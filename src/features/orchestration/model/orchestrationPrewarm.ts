import { pathKey } from "../../../shared/lib/paths";
import type { Session } from "../../sessions/model/session";
import type { OrchestrationRun } from "./orchestrationState";

/**
 * Worker worktrees prepared while a proposal card waits for confirmation, so
 * "Confirm & start" does not wait for checkout seeding and dependency clones.
 *
 * Identity: a run renames its tasks with fresh UUIDs, but keeps the proposal
 * task id as `assignmentId` and the card's block id as `proposalId`. A
 * pre-warmed worktree is keyed by (lead, proposal, assignment), so the run's
 * `createWorker` can claim it for exactly the task it was made for.
 *
 * Safety: claiming re-runs the native seeded create on the pre-warmed branch,
 * which verifies the worktree still matches the lead checkout. A stale one is
 * removed and the task falls back to normal creation. Every pre-warmed
 * worktree is recorded in a journal before it is created, so one left behind
 * by a crash or quit is removed on the next launch, but only after checking
 * that no run and no session uses it.
 */
export type PrewarmKey = {
  leadId: string;
  proposalId: string;
  assignmentId: string;
};

export type PrewarmEntry = PrewarmKey & {
  /** Lead checkout the worktree was seeded from. */
  cwd: string;
  branch: string;
  /** Known once creation returned. */
  path?: string;
  /** App instance that made it; another instance's entries are stale. */
  instance: string;
  /** Handed to a run; the run's own lifecycle removes it from here on. */
  claimed?: boolean;
  createdAt: number;
};

export type PrewarmTree = { path: string; branch: string | null };

export type PrewarmHost = {
  /** Seeded create; on an existing branch it verifies and returns that worktree. */
  create(cwd: string, branch: string): Promise<PrewarmTree>;
  /** Remove the worktree (when `path` is known) and its temporary branch. */
  remove(cwd: string, branch: string, path?: string): Promise<void>;
  list(
    cwd: string,
  ): Promise<{ path: string; branch: string | null; sessionIds: string[] }[]>;
  /** Whether a run references this checkout; true when unsure. */
  owned(leadId: string, path: string, branch: string): Promise<boolean>;
  /** A fresh `mc/orch-*` branch name that no run task id can produce. */
  branchName(): string;
  journal: {
    read(): PrewarmEntry[];
    write(entries: PrewarmEntry[]): void;
  };
};

export type PrewarmTarget = {
  leadId: string;
  proposalId: string;
  cwd: string;
  /** Assignments to prepare, in order. */
  assignmentIds: string[];
  /** The proposal is starting or running: keep what exists, make nothing new. */
  hold?: boolean;
};

type Slot = {
  entry: PrewarmEntry;
  state: "queued" | "creating" | "ready" | "discarded";
  tree?: PrewarmTree;
  created?: Promise<void>;
};

type Job = { kind: "create"; key: string } | { kind: "remove"; entry: PrewarmEntry };

const MAX_JOURNAL = 100;
const keyOf = (key: PrewarmKey) =>
  `${key.leadId}\u0000${key.proposalId}\u0000${key.assignmentId}`;
const samePath = (a: string, b: string) =>
  pathKey(a.replace(/\\/g, "/")) === pathKey(b.replace(/\\/g, "/"));

export class WorktreePrewarmer {
  private slots = new Map<string, Slot>();
  /** One job at a time: pre-warming must never compete for disk or memory. */
  private jobs: Job[] = [];
  private working = false;
  private idle = Promise.resolve();
  private finishIdle: () => void = () => {};

  constructor(
    private readonly host: PrewarmHost,
    readonly instance: string = crypto.randomUUID(),
  ) {}

  /** Make the prepared set match the cards on screen. Cheap when unchanged. */
  sync(targets: PrewarmTarget[]) {
    const wanted = new Map<string, { target: PrewarmTarget; id: string }>();
    const held = new Set<string>();
    for (const target of targets) {
      if (target.hold) {
        held.add(`${target.leadId}\u0000${target.proposalId}\u0000`);
        continue;
      }
      for (const id of target.assignmentIds)
        wanted.set(keyOf({ ...target, assignmentId: id }), { target, id });
    }
    for (const [key, slot] of this.slots) {
      const owner = `${slot.entry.leadId}\u0000${slot.entry.proposalId}\u0000`;
      const want = wanted.get(key);
      if (held.has(owner)) {
        // The run is starting: work not begun would only compete with it.
        if (slot.state === "queued") this.discard(key);
        continue;
      }
      if (!want || !samePath(want.target.cwd, slot.entry.cwd))
        this.discard(key);
    }
    for (const [key, { target, id }] of wanted) {
      if (this.slots.has(key)) continue;
      this.slots.set(key, {
        state: "queued",
        entry: {
          leadId: target.leadId,
          proposalId: target.proposalId,
          assignmentId: id,
          cwd: target.cwd,
          branch: this.host.branchName(),
          instance: this.instance,
          createdAt: Date.now(),
        },
      });
      this.jobs.push({ kind: "create", key });
    }
    void this.pump();
  }

  /** Pre-warmed or pending assignments, for tests and diagnostics. */
  prepared(): { key: PrewarmKey; state: Slot["state"]; path?: string }[] {
    return [...this.slots.values()].map((slot) => ({
      key: {
        leadId: slot.entry.leadId,
        proposalId: slot.entry.proposalId,
        assignmentId: slot.entry.assignmentId,
      },
      state: slot.state,
      path: slot.tree?.path,
    }));
  }

  /** Resolves once queued work has finished. */
  settled(): Promise<void> {
    return this.idle;
  }

  /**
   * The worktree for a run task: its pre-warmed one when that still matches
   * the lead checkout, otherwise a normal one on `fallbackBranch`.
   */
  async worktreeFor(
    key: { leadId: string; proposalId?: string; assignmentId?: string },
    cwd: string,
    fallbackBranch: string,
  ): Promise<PrewarmTree> {
    const claimed =
      key.proposalId && key.assignmentId
        ? await this.take(
            {
              leadId: key.leadId,
              proposalId: key.proposalId,
              assignmentId: key.assignmentId,
            },
            cwd,
          )
        : undefined;
    if (claimed?.path) {
      try {
        return await this.host.create(cwd, claimed.branch);
      } catch (error) {
        // The lead checkout changed after pre-warming (or the worktree did).
        console.warn("Pre-warmed worktree is stale; creating a fresh one", error);
        try {
          await this.host.remove(cwd, claimed.branch, claimed.path);
          this.journalDrop(claimed);
        } catch (removal) {
          // Left in the journal; the next launch retries the cleanup.
          console.warn("Could not remove a stale pre-warmed worktree", removal);
        }
      }
    }
    return this.host.create(cwd, fallbackBranch);
  }

  /**
   * Remove pre-warmed worktrees an earlier app instance left behind. Never
   * touches one a run references or a session works in; those only leave the
   * journal.
   */
  async cleanupStale(): Promise<void> {
    const stale = this.host.journal
      .read()
      .filter((entry) => entry.instance !== this.instance);
    for (const entry of stale) {
      try {
        if (
          await this.host.owned(entry.leadId, entry.path ?? "", entry.branch)
        ) {
          this.journalDrop(entry);
          continue;
        }
        const tree = (await this.host.list(entry.cwd)).find(
          (candidate) =>
            (!!entry.path && samePath(candidate.path, entry.path)) ||
            candidate.branch === entry.branch,
        );
        if (tree?.sessionIds.length) {
          this.journalDrop(entry);
          continue;
        }
        await this.host.remove(entry.cwd, entry.branch, tree?.path);
        this.journalDrop(entry);
      } catch (error) {
        console.warn("Could not clean up a pre-warmed worktree", error);
      }
    }
  }

  private async take(
    key: PrewarmKey,
    cwd: string,
  ): Promise<PrewarmEntry | undefined> {
    const id = keyOf(key);
    let slot = this.slots.get(id);
    if (!slot) return undefined;
    if (slot.state === "queued") {
      // Not started: creating it now gains nothing over the normal path.
      this.discard(id);
      return undefined;
    }
    if (slot.state === "creating") await slot.created;
    slot = this.slots.get(id);
    if (!slot || slot.state !== "ready" || !slot.tree) return undefined;
    this.slots.delete(id);
    if (!samePath(slot.entry.cwd, cwd)) {
      slot.state = "discarded";
      this.enqueue({ kind: "remove", entry: slot.entry });
      return undefined;
    }
    const entry = { ...slot.entry, claimed: true };
    this.journalPut(entry);
    return entry;
  }

  private discard(key: string) {
    const slot = this.slots.get(key);
    if (!slot) return;
    this.slots.delete(key);
    const state = slot.state;
    slot.state = "discarded";
    if (state === "queued")
      this.jobs = this.jobs.filter(
        (job) => !(job.kind === "create" && job.key === key),
      );
    else if (state === "ready")
      this.enqueue({ kind: "remove", entry: slot.entry });
    // "creating" finishes in the pump, which sees the discard and removes it.
  }

  private enqueue(job: Job) {
    this.jobs.push(job);
    void this.pump();
  }

  private async pump() {
    if (this.working) return;
    this.working = true;
    this.idle = new Promise((resolve) => (this.finishIdle = resolve));
    try {
      for (let job = this.jobs.shift(); job; job = this.jobs.shift()) {
        if (job.kind === "remove") await this.removeEntry(job.entry);
        else await this.create(job.key);
      }
    } finally {
      this.working = false;
      this.finishIdle();
    }
  }

  private async create(key: string) {
    const slot = this.slots.get(key);
    if (!slot || slot.state !== "queued") return;
    slot.state = "creating";
    let done: () => void = () => {};
    slot.created = new Promise((resolve) => (done = resolve));
    // Journal first: a crash mid-create still leaves a record to clean up.
    this.journalPut(slot.entry);
    try {
      const tree = await this.host.create(slot.entry.cwd, slot.entry.branch);
      slot.entry = { ...slot.entry, path: tree.path };
      slot.tree = tree;
      this.journalPut(slot.entry);
      if (slot.state === "creating") slot.state = "ready";
      else await this.removeEntry(slot.entry);
    } catch (error) {
      console.warn("Could not pre-warm a worker worktree", error);
      if (this.slots.get(key) === slot) this.slots.delete(key);
      slot.state = "discarded";
      await this.removeEntry(slot.entry);
    } finally {
      done();
    }
  }

  private async removeEntry(entry: PrewarmEntry) {
    try {
      await this.host.remove(entry.cwd, entry.branch, entry.path);
      this.journalDrop(entry);
    } catch (error) {
      console.warn("Could not remove a pre-warmed worktree", error);
    }
  }

  private journalPut(entry: PrewarmEntry) {
    const others = this.host.journal
      .read()
      .filter((item) => item.branch !== entry.branch);
    this.host.journal.write([...others, entry].slice(-MAX_JOURNAL));
  }

  private journalDrop(entry: Pick<PrewarmEntry, "branch">) {
    const entries = this.host.journal.read();
    const next = entries.filter((item) => item.branch !== entry.branch);
    if (next.length !== entries.length) this.host.journal.write(next);
  }
}

const JOURNAL_KEY = "monocode.orchestrationPrewarm";

/** The journal in localStorage; a malformed record reads as empty. */
export const localPrewarmJournal: PrewarmHost["journal"] = {
  read() {
    try {
      const parsed: unknown = JSON.parse(
        localStorage.getItem(JOURNAL_KEY) ?? "[]",
      );
      return Array.isArray(parsed)
        ? parsed.filter(
            (entry): entry is PrewarmEntry =>
              !!entry &&
              typeof entry === "object" &&
              typeof entry.leadId === "string" &&
              typeof entry.cwd === "string" &&
              typeof entry.branch === "string" &&
              entry.branch.startsWith("mc/orch-") &&
              typeof entry.instance === "string",
          )
        : [];
    } catch {
      return [];
    }
  },
  write(entries) {
    try {
      localStorage.setItem(JOURNAL_KEY, JSON.stringify(entries));
    } catch {
      // private mode / quota: startup cleanup simply has less to do
    }
  },
};

type CardSession = Pick<Session, "id" | "busy" | "cwd" | "worktreeCwd" | "blocks">;

/**
 * Which cards want worktrees. Only a session's newest proposal counts. A ready
 * card prepares its first tasks that can start at once (no dependencies, not
 * a review), up to its parallelism; a starting or running one holds what it
 * has for its run to claim. `fresh`, when given, limits preparing to cards
 * planned or touched in this window, so restoring old conversations at launch
 * does not create worktrees nobody is about to use.
 */
export function prewarmTargets(
  sessions: readonly CardSession[],
  runs: readonly Pick<OrchestrationRun, "leadId" | "status" | "proposalId">[],
  enabled: boolean,
  fresh?: ReadonlySet<string>,
): PrewarmTarget[] {
  const targets: PrewarmTarget[] = [];
  for (const session of sessions) {
    let block: CardSession["blocks"][number] | undefined;
    for (let index = session.blocks.length - 1; index >= 0; index--) {
      if (session.blocks[index].orchestration) {
        block = session.blocks[index];
        break;
      }
    }
    const proposal = block?.orchestration;
    if (!block || !proposal) continue;
    const run = runs.find((entry) => entry.leadId === session.id);
    const running = run?.status === "active" || run?.status === "paused";
    const cwd = proposal.checkoutCwd ?? proposal.cwd;
    if (
      proposal.status === "starting" ||
      (proposal.status === "approved" && running && run?.proposalId === block.id)
    ) {
      targets.push({
        leadId: session.id,
        proposalId: block.id,
        cwd,
        assignmentIds: [],
        hold: true,
      });
      continue;
    }
    if (
      !enabled ||
      (fresh && !fresh.has(block.id)) ||
      proposal.status !== "ready" ||
      session.busy ||
      running ||
      !samePath(session.worktreeCwd ?? session.cwd, cwd)
    )
      continue;
    const assignmentIds = proposal.tasks
      .filter((task) => !task.dependsOn.length && task.kind !== "review")
      .slice(0, Math.max(0, proposal.settings.maxWorkers))
      .map((task) => task.id);
    if (assignmentIds.length)
      targets.push({ leadId: session.id, proposalId: block.id, cwd, assignmentIds });
  }
  return targets;
}
