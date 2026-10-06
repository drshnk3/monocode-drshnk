import { describe, expect, it, vi } from "vitest";
import {
  WorktreePrewarmer,
  prewarmTargets,
  type PrewarmEntry,
  type PrewarmHost,
  type PrewarmTarget,
} from "./orchestrationPrewarm";
import type { OrchestrationProposal } from "./orchestrationPlan";
import type { Block } from "../../sessions/model/session";

type Tree = { path: string; branch: string; head: string };

/**
 * A repository in memory: `create` follows the native seeded create, which
 * returns an existing branch's worktree only while it matches the lead.
 */
function fakeHost() {
  let counter = 0;
  let head = "h1";
  const trees = new Map<string, Tree>();
  let journal: PrewarmEntry[] = [];
  const owned = new Set<string>();
  const sessions = new Map<string, string[]>();
  const gates: (() => void)[] = [];
  let gated = false;
  const host: PrewarmHost & {
    trees: Map<string, Tree>;
    calls: string[];
  } = {
    trees,
    calls: [],
    async create(_cwd, branch) {
      host.calls.push(`create ${branch}`);
      if (gated) await new Promise<void>((resolve) => gates.push(resolve));
      const existing = trees.get(branch);
      if (existing) {
        if (existing.head !== head)
          throw new Error("The recovered orchestration worktree is incomplete");
        return { path: existing.path, branch };
      }
      const tree = { path: `/trees/${branch}`, branch, head };
      trees.set(branch, tree);
      return { path: tree.path, branch };
    },
    async remove(_cwd, branch) {
      host.calls.push(`remove ${branch}`);
      trees.delete(branch);
    },
    async list() {
      return [...trees.values()].map((tree) => ({
        path: tree.path,
        branch: tree.branch,
        sessionIds: sessions.get(tree.path) ?? [],
      }));
    },
    async owned(_leadId, path, branch) {
      return owned.has(path) || owned.has(branch);
    },
    branchName: () => `mc/orch-pw${++counter}`,
    journal: {
      read: () => journal,
      write: (entries) => {
        journal = entries;
      },
    },
  };
  return {
    host,
    owned,
    sessions,
    journal: () => journal,
    moveLead: () => {
      head = "h2";
    },
    gate: () => {
      gated = true;
    },
    release: () => {
      gated = false;
      gates.splice(0).forEach((resolve) => resolve());
    },
  };
}

const target = (ids: string[], extra?: Partial<PrewarmTarget>): PrewarmTarget => ({
  leadId: "lead",
  proposalId: "card",
  cwd: "/repo",
  assignmentIds: ids,
  ...extra,
});

describe("worktree pre-warming", () => {
  it("prepares one worktree at a time and hands each to its own task", async () => {
    const fake = fakeHost();
    const prewarmer = new WorktreePrewarmer(fake.host, "now");
    prewarmer.sync([target(["ui", "api"])]);
    await prewarmer.settled();
    expect(fake.host.trees.size).toBe(2);
    expect(fake.journal().map((entry) => entry.assignmentId)).toEqual([
      "ui",
      "api",
    ]);
    const tree = await prewarmer.worktreeFor(
      { leadId: "lead", proposalId: "card", assignmentId: "api" },
      "/repo",
      "mc/orch-taskid",
    );
    expect(tree.path).toBe("/trees/mc/orch-pw2");
    expect(fake.host.calls).not.toContain("create mc/orch-taskid");
    // Claimed, not forgotten: the next launch confirms the run owns it.
    expect(
      fake.journal().find((entry) => entry.assignmentId === "api")?.claimed,
    ).toBe(true);
  });

  it("serializes creation instead of starting every worktree at once", async () => {
    const fake = fakeHost();
    fake.gate();
    const prewarmer = new WorktreePrewarmer(fake.host, "now");
    prewarmer.sync([target(["a", "b", "c"])]);
    await Promise.resolve();
    expect(fake.host.calls).toEqual(["create mc/orch-pw1"]);
    fake.release();
    await prewarmer.settled();
    expect(fake.host.trees.size).toBe(3);
  });

  it("falls back to a fresh worktree when the lead checkout moved", async () => {
    const fake = fakeHost();
    const prewarmer = new WorktreePrewarmer(fake.host, "now");
    prewarmer.sync([target(["ui"])]);
    await prewarmer.settled();
    fake.moveLead();
    const tree = await prewarmer.worktreeFor(
      { leadId: "lead", proposalId: "card", assignmentId: "ui" },
      "/repo",
      "mc/orch-taskid",
    );
    expect(tree.path).toBe("/trees/mc/orch-taskid");
    expect(fake.host.calls).toContain("remove mc/orch-pw1");
    expect(fake.host.trees.has("mc/orch-pw1")).toBe(false);
    expect(fake.journal()).toEqual([]);
  });

  it("uses the normal path for tasks it did not prepare", async () => {
    const fake = fakeHost();
    const prewarmer = new WorktreePrewarmer(fake.host, "now");
    const tree = await prewarmer.worktreeFor(
      { leadId: "lead", proposalId: "card", assignmentId: "ui" },
      "/repo",
      "mc/orch-taskid",
    );
    expect(tree.path).toBe("/trees/mc/orch-taskid");
    const legacy = await prewarmer.worktreeFor(
      { leadId: "lead" },
      "/repo",
      "mc/orch-other",
    );
    expect(legacy.path).toBe("/trees/mc/orch-other");
  });

  it("removes everything when the card goes away, including work in flight", async () => {
    const fake = fakeHost();
    fake.gate();
    const prewarmer = new WorktreePrewarmer(fake.host, "now");
    prewarmer.sync([target(["a", "b", "c"])]);
    await Promise.resolve();
    prewarmer.sync([]);
    expect(prewarmer.prepared()).toEqual([]);
    fake.release();
    await prewarmer.settled();
    // Only the one already being created was made, and it was removed again.
    expect(fake.host.calls).toEqual([
      "create mc/orch-pw1",
      "remove mc/orch-pw1",
    ]);
    expect(fake.host.trees.size).toBe(0);
    expect(fake.journal()).toEqual([]);
  });

  it("drops tasks that no longer fit the chosen parallelism", async () => {
    const fake = fakeHost();
    const prewarmer = new WorktreePrewarmer(fake.host, "now");
    prewarmer.sync([target(["a", "b"])]);
    await prewarmer.settled();
    prewarmer.sync([target(["a"])]);
    await prewarmer.settled();
    expect([...fake.host.trees.keys()]).toEqual(["mc/orch-pw1"]);
  });

  it("holds prepared worktrees while the run starts, and drops unbegun work", async () => {
    const fake = fakeHost();
    fake.gate();
    const prewarmer = new WorktreePrewarmer(fake.host, "now");
    prewarmer.sync([target(["a", "b"])]);
    await Promise.resolve();
    prewarmer.sync([target([], { hold: true })]);
    fake.release();
    await prewarmer.settled();
    expect([...fake.host.trees.keys()]).toEqual(["mc/orch-pw1"]);
    const tree = await prewarmer.worktreeFor(
      { leadId: "lead", proposalId: "card", assignmentId: "a" },
      "/repo",
      "mc/orch-a",
    );
    expect(tree.path).toBe("/trees/mc/orch-pw1");
    // The run ended: nothing left to remove, the claimed one is the run's.
    prewarmer.sync([]);
    await prewarmer.settled();
    expect(fake.host.trees.has("mc/orch-pw1")).toBe(true);
  });

  it("waits for a worktree still being created rather than duplicating it", async () => {
    const fake = fakeHost();
    fake.gate();
    const prewarmer = new WorktreePrewarmer(fake.host, "now");
    prewarmer.sync([target(["a"])]);
    await Promise.resolve();
    const claimed = prewarmer.worktreeFor(
      { leadId: "lead", proposalId: "card", assignmentId: "a" },
      "/repo",
      "mc/orch-a",
    );
    fake.release();
    expect((await claimed).path).toBe("/trees/mc/orch-pw1");
    expect(fake.host.trees.has("mc/orch-a")).toBe(false);
  });

  it("cleans up a previous launch's leftovers but never a run's or a session's", async () => {
    const fake = fakeHost();
    const earlier = new WorktreePrewarmer(fake.host, "earlier");
    earlier.sync([target(["free", "run", "session"])]);
    await earlier.settled();
    fake.owned.add("/trees/mc/orch-pw2");
    fake.sessions.set("/trees/mc/orch-pw3", ["worker"]);
    const now = new WorktreePrewarmer(fake.host, "now");
    now.sync([target(["fresh"], { proposalId: "other" })]);
    await now.settled();
    await now.cleanupStale();
    expect([...fake.host.trees.keys()].sort()).toEqual([
      "mc/orch-pw2",
      "mc/orch-pw3",
      "mc/orch-pw4",
    ]);
    // The current instance's own entry stays; the others leave the journal.
    expect(fake.journal().map((entry) => entry.branch)).toEqual([
      "mc/orch-pw4",
    ]);
  });

  it("keeps a journal entry whose cleanup failed for the next launch", async () => {
    const fake = fakeHost();
    const earlier = new WorktreePrewarmer(fake.host, "earlier");
    earlier.sync([target(["a"])]);
    await earlier.settled();
    fake.host.remove = vi.fn(async () => {
      throw new Error("busy");
    });
    await new WorktreePrewarmer(fake.host, "now").cleanupStale();
    expect(fake.journal()).toHaveLength(1);
  });
});

const proposal = (
  patch: Partial<OrchestrationProposal> = {},
): OrchestrationProposal => ({
  version: 1,
  leadId: "lead",
  cwd: "/repo",
  request: "Build",
  author: { harness: "codex", model: "m", name: "Lead" },
  settings: { choices: [], maxWorkers: 2 },
  status: "ready",
  title: "Plan",
  summary: "",
  tasks: [
    { id: "a", title: "A", prompt: "p", harness: "codex", model: "m", files: ["a"], dependsOn: [] },
    { id: "b", title: "B", prompt: "p", harness: "codex", model: "m", files: ["b"], dependsOn: ["a"] },
    { id: "c", title: "C", prompt: "p", harness: "codex", model: "m", files: ["c"], dependsOn: [] },
    { id: "d", title: "D", prompt: "p", harness: "codex", model: "m", files: ["d"], dependsOn: [] },
    { id: "r", title: "R", prompt: "p", harness: "codex", model: "m", files: [], dependsOn: [], kind: "review", reviewOf: ["a"] },
  ],
  ...patch,
});

const lead = (blocks: Block[], patch = {}) => ({
  id: "lead",
  busy: false,
  cwd: "/repo",
  worktreeCwd: undefined,
  blocks,
  ...patch,
});
const card = (value: OrchestrationProposal, id = "card"): Block => ({
  id,
  role: "plan",
  text: "",
  orchestration: value,
});

describe("pre-warm targets", () => {
  it("prepares the newest ready card's startable work up to its parallelism", () => {
    expect(prewarmTargets([lead([card(proposal())])], [], true)).toEqual([
      { leadId: "lead", proposalId: "card", cwd: "/repo", assignmentIds: ["a", "c"] },
    ]);
    expect(
      prewarmTargets(
        [lead([card(proposal(), "old"), card(proposal({ status: "invalid" }), "new")])],
        [],
        true,
      ),
    ).toEqual([]);
  });

  it("prepares nothing when off, busy, running or in another checkout", () => {
    const ready = [card(proposal())];
    expect(prewarmTargets([lead(ready)], [], false)).toEqual([]);
    // A card restored from an earlier launch waits until it is touched.
    expect(prewarmTargets([lead(ready)], [], true, new Set())).toEqual([]);
    expect(prewarmTargets([lead(ready)], [], true, new Set(["card"]))).toHaveLength(1);
    expect(prewarmTargets([lead(ready, { busy: true })], [], true)).toEqual([]);
    expect(
      prewarmTargets([lead(ready, { worktreeCwd: "/elsewhere" })], [], true),
    ).toEqual([]);
    expect(
      prewarmTargets(
        [lead(ready)],
        [{ leadId: "lead", status: "paused", proposalId: "earlier" }],
        true,
      ),
    ).toEqual([]);
  });

  it("holds a starting card and the card of its running run", () => {
    expect(
      prewarmTargets([lead([card(proposal({ status: "starting" }))])], [], false),
    ).toEqual([
      { leadId: "lead", proposalId: "card", cwd: "/repo", assignmentIds: [], hold: true },
    ]);
    const approved = [lead([card(proposal({ status: "approved" }))])];
    expect(
      prewarmTargets(approved, [{ leadId: "lead", status: "active", proposalId: "card" }], true),
    ).toHaveLength(1);
    expect(
      prewarmTargets(approved, [{ leadId: "lead", status: "finished", proposalId: "card" }], true),
    ).toEqual([]);
  });
});
