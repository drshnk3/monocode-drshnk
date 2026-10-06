import { invoke } from "@tauri-apps/api/core";
import { HARNESSES, type HarnessId, type Session } from "../../sessions/model/session";
import { pathKey } from "../../../shared/lib/paths";
import type { ApprovalDecision, HarnessEvent } from "../../../integrations/harness/core/types";
import { pendingApprovalForSession } from "../../notifications/model/approvalToast";
import type { UserQuestionReply } from "../../sessions/model/userQuestion";
import type { CheckRunResult } from "../../../platform/tauri/orchestrationNative";
import {
  validateOrchestrationBrief,
  validateOrchestrationSettings,
  validateProposedTasks,
  validateTaskChecks,
  validateTaskKind,
  type OrchestrationChoice,
  type OrchestrationProposal,
} from "./orchestrationPlan";
import {
  CHECK_OUTPUT_CHARS,
  busyTask,
  normalizeOrchestrationRun,
  orchestrationCheckoutCwd,
  orchestrationLimits,
  orchestrationWorkspace,
  settleActiveTime,
  workspaceIdentity,
  type CheckResult,
  type OrchestrationDispatch,
  type OrchestrationRun,
  type OrchestrationTask,
  type OrchestrationWorkspace,
  type WorkerChange,
} from "./orchestrationState";
import {
  resolveOrchestrationLimits,
  validateOrchestrationBudget,
  type OrchestrationBudget,
  type OrchestrationLimits,
} from "./orchestrationLimits";
import {
  MAX_RECORDED_CHANGES,
  leadResultFields,
  leadResultText,
  parseWorkerReport,
  reviewVerdict,
} from "./orchestrationReport";
import {
  orchestrationUsage,
  orchestrationUsageText,
} from "./orchestrationSummary";

export {
  busyTask,
  orchestrationCheckoutCwd,
  orchestrationLimits,
  orchestrationProjectCwd,
  orchestrationWorkspace,
  workspaceIdentity,
} from "./orchestrationState";
export {
  DEFAULT_ORCHESTRATION_LIMITS,
  ORCHESTRATION_BUDGET_RANGES,
  ORCHESTRATION_LIMIT_RANGES,
  resolveOrchestrationLimits,
  validateOrchestrationBudget,
} from "./orchestrationLimits";
export type {
  OrchestrationBudget,
  OrchestrationLimits,
} from "./orchestrationLimits";
export {
  changeMismatch,
  parseWorkerReport,
} from "./orchestrationReport";
export type {
  CheckResult,
  DispatchStage,
  DispatchState,
  OrchestrationDispatch,
  OrchestrationRun,
  OrchestrationTask,
  OrchestrationWorkspace,
  TaskKind,
  TaskStatus,
  WorkerChange,
  WorkerCheck,
  WorkerReport,
  WorkspacePolicy,
} from "./orchestrationState";
export type { CheckRunResult } from "../../../platform/tauri/orchestrationNative";
export type ControlOutcome = {
  status: "completed" | "failed" | "cancelled";
  text: string;
  error?: string;
};
export type WorkerPreparation = {
  scratchDir?: string;
  workspace: OrchestrationWorkspace;
};
export type WorkerDiff = {
  files: WorkerChange[];
  /** Unified diff, cut at the requested size. */
  patch: string;
  truncated: boolean;
};
/** Bounds of the diff action's maxBytes; requests outside are clamped. */
export const DIFF_BYTES = { default: 60_000, min: 1000, max: 200_000 } as const;
export type OrchestrationHost = {
  session(id: string): Session | undefined;
  sessions(): Session[];
  choices(): { harness: HarnessId; models: { id: string; name: string }[] }[];
  createWorker(
    run: OrchestrationRun,
    task: OrchestrationTask,
  ): Promise<WorkerPreparation>;
  integrateWorker(
    run: OrchestrationRun,
    task: OrchestrationTask,
  ): Promise<{ files: string[]; alreadyApplied: number; merged?: string[] }>;
  /**
   * Run one acceptance check in the task's checkout. Resolves with a failed
   * result on a non-zero exit or timeout; rejects only when it cannot run.
   */
  runCheck(
    run: OrchestrationRun,
    task: OrchestrationTask,
    command: string,
  ): Promise<CheckRunResult>;
  /**
   * Files the worker's session changed in its checkout. Optional and
   * best-effort: a failure leaves the task without recorded changes.
   */
  workerChanges?(
    run: OrchestrationRun,
    task: OrchestrationTask,
  ): Promise<WorkerChange[]>;
  /** The worker session's patch in its checkout, cut at `maxBytes`. */
  workerDiff(
    run: OrchestrationRun,
    task: OrchestrationTask,
    maxBytes: number,
  ): Promise<WorkerDiff>;
  /** Returns false when unreviewed changes require the worktree to be kept. */
  cleanupWorker(
    run: OrchestrationRun,
    task: OrchestrationTask,
    onlyIfUnchanged: boolean,
  ): Promise<boolean>;
  submit(
    id: string,
    text: string,
    done: (outcome: ControlOutcome) => void,
  ): void;
  stop(id: string): Promise<void>;
  /** Redirect a worker mid-turn, without discarding what it has already done. */
  steer(id: string, text: string): Promise<void>;
  /** Answer on a worker's behalf; the lead, not the user, decides. */
  respondApproval(
    id: string,
    requestId: number,
    decision: ApprovalDecision,
  ): void;
  answerQuestion(id: string, requestId: number, reply: UserQuestionReply): void;
};
type ApprovedStart = {
  proposalId: string;
  allowedModels: OrchestrationChoice[];
  tasks: OrchestrationTask[];
  brief?: string;
};
/** Run settings chosen at start; a resume keeps the previous ones unless passed. */
export type OrchestrationRunOptions = {
  autoAccept?: boolean;
  budget?: OrchestrationBudget;
};
type Storage = {
  save(run: OrchestrationRun): Promise<void>;
  load(id: string): Promise<OrchestrationRun | null>;
  enable(id: string, cwd: string): Promise<string>;
  disable(id: string): Promise<void>;
  scopes(cwd: string, files: string[]): Promise<string[]>;
  resolvePath(path: string): Promise<string>;
};
const storage: Storage = {
  save: (run) =>
    invoke("control_save", { leadId: run.leadId, state: JSON.stringify(run) }),
  load: async (id) => {
    const raw = await invoke<string | null>("control_load", { leadId: id });
    if (!raw) return null;
    const run = JSON.parse(raw) as OrchestrationRun;
    if (
      (run.version !== 1 && run.version !== 2) ||
      run.leadId !== id ||
      !Array.isArray(run.tasks)
    )
      throw new Error("Unsupported orchestration history");
    return normalizeOrchestrationRun(run);
  },
  enable: (sessionId, cwd) => invoke("control_enable", { sessionId, cwd }),
  disable: (sessionId) => invoke("control_disable", { sessionId }),
  scopes: (cwd, files) => invoke("control_scopes", { cwd, files }),
  resolvePath: (path) => invoke("control_write_path", { path }),
};

/**
 * One comparison form for scopes returned by Rust and paths reported by a
 * harness. Windows canonicalize uses the extended `\\?\D:\...` form while
 * providers usually report `D:\...`; both must describe the same location.
 */
export function orchestrationPathKey(value: string): string {
  let slashed = value.replace(/\\/g, "/");
  if (/^\/\/\?\/unc\//i.test(slashed)) slashed = `//${slashed.slice(8)}`;
  else if (/^\/\/\?\/[a-z]:\//i.test(slashed)) slashed = slashed.slice(4);

  const prefix = slashed.startsWith("//")
    ? "//"
    : /^[A-Za-z]:\//.test(slashed)
      ? slashed.slice(0, 3)
      : slashed.startsWith("/")
        ? "/"
        : "";
  const parts: string[] = [];
  for (const part of slashed.slice(prefix.length).split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") parts.pop();
    else parts.push(part);
  }
  return pathKey(`${prefix}${parts.join("/")}` || ".");
}

const scopeContains = (scope: string, path: string) =>
  path === scope || path.startsWith(scope.endsWith("/") ? scope : `${scope}/`);

export function scopesOverlap(a: string[], b: string[]): boolean {
  return a.some((left) => {
    const leftKey = orchestrationPathKey(left);
    return b.some((right) => {
      const rightKey = orchestrationPathKey(right);
      return (
        scopeContains(leftKey, rightKey) || scopeContains(rightKey, leftKey)
      );
    });
  });
}
/** A live worker process: it holds a worker slot as well as its scope. */
const activeTask = (task: OrchestrationTask) =>
  task.status === "running" || task.status === "cancelling";
/** A settled result the lead has not been woken with yet. */
const deliverable = (task: OrchestrationTask) =>
  !task.delivered && !busyTask(task) && task.status !== "queued";
export const sameCheckout = (a: string, b: string) =>
  pathKey(a.replace(/\\/g, "/")) === pathKey(b.replace(/\\/g, "/"));
const messageOf = (error: unknown) =>
  error instanceof Error ? error.message : String(error);

const recoveryTurn = (reason: string) =>
  `Continue the existing assignment from its retained worker checkout. The previous turn was stopped because the orchestration run was interrupted: ${reason}\n\nInspect the current files and prior conversation before acting. Preserve completed work, do not repeat destructive or external operations, remain inside the assigned write scope, run the remaining focused checks, and report what was already done versus what you completed now.`;

/** Output of each failing check quoted back to the worker. */
const FIX_OUTPUT_CHARS = 3000;
/** Patch bytes a reviewer prompt may carry, split across the reviewed tasks. */
export const REVIEW_PATCH_BYTES = 120_000;

/** Follow-up turn asking a worker to fix the checks that failed in its checkout. */
export function checkFixTurn(
  failed: CheckResult[],
  attempt: number,
  maxAttempts: number,
): string {
  const details = failed
    .map((check) => {
      const how = check.timedOut
        ? "timed out"
        : `exited with ${check.exitCode ?? "no exit code"}`;
      const tail = check.outputTail.slice(-FIX_OUTPUT_CHARS).trim();
      return `\`${check.command}\` ${how}.${tail ? `\nEnd of its output:\n\`\`\`\n${tail}\n\`\`\`` : ""}`;
    })
    .join("\n\n");
  return `MonoCode ran your assignment's acceptance checks in your checkout after your last turn, and ${failed.length === 1 ? "one failed" : `${failed.length} failed`}. This is automatic fix attempt ${attempt} of ${maxAttempts}.\n\n${details}\n\nFix the cause within your assigned write scope, then rerun the failing commands yourself. Do not weaken, skip or delete tests or checks to make them pass. If the failure comes from outside your scope or cannot be fixed by you, stop and report "blocked" with the reason. MonoCode reruns every check after this turn.`;
}

/** A check run that stopped before finishing; Resume starts it again. */
const checksInterrupted = (
  task: OrchestrationTask,
  reason: string,
): OrchestrationTask => ({
  ...task,
  status: "interrupted",
  recheck: true,
  checkRunId: undefined,
  accepted: false,
  delivered: true,
  error: `Acceptance checks were interrupted (${reason}). Resume runs them again.`,
});

/** Fold the turn its active dispatch ran into the task's time totals. */
function turnEnded(
  run: OrchestrationRun,
  task: OrchestrationTask,
  now = Date.now(),
): Partial<OrchestrationTask> {
  const dispatch = run.dispatches?.find(
    (entry) => entry.id === task.activeDispatchId,
  );
  if (!dispatch) return {};
  return {
    activeMs: (task.activeMs ?? 0) + Math.max(0, now - dispatch.startedAt),
    finishedAt: now,
  };
}

/**
 * Tokens the worker's latest turn reported, once per transcript turn. Absent
 * when the provider reported none, or the turn was already counted.
 */
function turnTokens(
  session: Session | undefined,
  task: OrchestrationTask,
): Pick<OrchestrationTask, "tokens" | "usageBlockId"> {
  const blocks = session?.blocks ?? [];
  let turn: Session["blocks"][number] | undefined;
  for (let index = blocks.length - 1; index >= 0; index -= 1)
    if (blocks[index].role === "user") {
      turn = blocks[index];
      break;
    }
  const metrics = turn?.turnMetrics;
  if (
    !turn ||
    turn.id === task.usageBlockId ||
    !metrics ||
    (metrics.inputTokens == null && metrics.outputTokens == null)
  )
    return {};
  return {
    tokens: {
      input: (task.tokens?.input ?? 0) + (metrics.inputTokens ?? 0),
      output: (task.tokens?.output ?? 0) + (metrics.outputTokens ?? 0),
    },
    usageBlockId: turn.id,
  };
}

const budgetPause = (detail: string) =>
  `Run budget reached: ${detail}. Its agents were stopped; raise the budget or Resume to continue.`;

/**
 * Why the run's budget is spent, if it is. Turns only block a new dispatch:
 * reaching the turn cap with every turn finished leaves the run usable.
 */
function budgetReason(
  run: OrchestrationRun,
  dispatching: boolean,
  now = Date.now(),
): string | undefined {
  if (!run.budget) return undefined;
  const usage = orchestrationUsage(run, now);
  const base = run.budgetBaseline ?? { elapsedMs: 0, workerTurns: 0 };
  const minutes = (usage.elapsedMs - base.elapsedMs) / 60_000;
  if (run.budget.maxMinutes && minutes >= run.budget.maxMinutes)
    return `${Math.floor(minutes)} of ${run.budget.maxMinutes} minutes used`;
  const turns = usage.workerTurns - base.workerTurns;
  if (
    dispatching &&
    run.budget.maxWorkerTurns &&
    turns >= run.budget.maxWorkerTurns
  )
    return `${turns} of ${run.budget.maxWorkerTurns} worker turns used`;
  return undefined;
}

const ASSIGNMENT_BLOCK =
  /(?:\r?\n[ \t]*)*<monocode_assignment\b[^>]*>[\s\S]*?<\/monocode_assignment>/gi;
const BRIEF_BLOCK =
  /^\s*<monocode_brief\b[^>]*>[\s\S]*?<\/monocode_brief>(?:[ \t]*\r?\n)*/i;

const RESULT_FORMAT =
  '{"status":"done"|"partial"|"blocked","summary":"what you did and its outcome","changedFiles":["project-relative paths you changed"],"checks":[{"command":"exact command","passed":true,"note":"optional"}],"blockers":["what stops you, if anything"],"followUps":["optional suggestions for the lead"]}';

/**
 * Prompt the worker receives, including the envelope the transcript hides.
 * The run brief comes first and is identical for every worker of a run, so a
 * provider's prompt cache can reuse it across workers.
 */
export function workerTurnPrompt(
  prompt: string,
  files: string[],
  scratchDir?: string,
  brief?: string,
): string {
  const scratch = scratchDir
    ? ` Temporary helpers and test output may be written in your private scratch directory: ${JSON.stringify(scratchDir)}. TMPDIR, TMP and TEMP point there. Use this directory for scratch files; do not write elsewhere outside the project. Deliver final changes in your assigned project files.`
    : "";
  const shared = brief?.trim()
    ? `<monocode_brief>\nShared notes from the lead's investigation of this project. Rely on them instead of re-exploring; your task text and assignment take precedence.\n\n${brief.trim()}\n</monocode_brief>\n\n`
    : "";
  // A reviewer owns no files: any project write stops it.
  const scope = files.length
    ? `Your assigned write scope is: ${files.join(", ")}.`
    : "You are a read-only reviewer with no write scope: never edit, create or delete project files, and avoid commands that write to the project. A project write stops this review.";
  return `${shared}${prompt}\n\n<monocode_assignment>\nYou are a worker managed by a MonoCode lead. Work only in the checkout selected for this run. The workspace, scope and Git rules in this assignment envelope override any contradictory wording in the task text above. ${scope}${scratch} Read other files as needed, but do not edit outside your scope. If another file or shared operation is needed, report the blocker and stop so the lead can expand or create a new assignment. Do not spawn agents, create worktrees, switch branches, stage, commit, push, install dependencies or run broad formatters/generators. A task owning '.' may run explicitly requested project-wide validation or generation, but Git finalization remains the lead's responsibility after integration. Other workers may be working concurrently in separate checkouts; do not rely on their work until the lead has accepted it. Run focused checks for your change. End your final message with exactly one <monocode_result> block holding this JSON, and nothing after it: <monocode_result>${RESULT_FORMAT}</monocode_result>. Use "done" only when the assignment is complete and its checks pass, "partial" when some of it remains, and "blocked" when you stopped on something the lead must resolve.\n</monocode_assignment>`;
}

/**
 * Task text a person should see: the run brief and the assignment envelope
 * stay in the send.
 */
export function visibleUserPrompt(text: string): string {
  return text.replace(BRIEF_BLOCK, "").replace(ASSIGNMENT_BLOCK, "").trimEnd();
}

function text(value: unknown, label: string, max = 30_000): string {
  if (typeof value !== "string" || !value.trim())
    throw new Error(`Invalid ${label}: provide a non-empty string`);
  if (value.length > max)
    throw new Error(`Invalid ${label}: keep it under ${max} characters`);
  return value.trim();
}
function strings(value: unknown, label: string, max = 64): string[] {
  if (!Array.isArray(value))
    throw new Error(`Invalid ${label}: provide an array of strings`);
  if (value.length > max)
    throw new Error(`Invalid ${label}: at most ${max} entries`);
  return [...new Set(value.map((item) => text(item, label, 512)))];
}
/**
 * A mistyped field must fail loudly rather than silently change the task. A
 * Map, so an action named after an Object member is still just unknown.
 */
const FIELDS = new Map<string, string[]>([
  ["list", []],
  [
    "delegate",
    [
      "title",
      "harness",
      "model",
      "prompt",
      "files",
      "dependsOn",
      "checks",
      "kind",
      "reviewOf",
    ],
  ],
  ["get", ["taskId"]],
  ["message", ["taskId", "text"]],
  ["retry", ["taskId", "text", "files"]],
  ["cancel", ["taskId"]],
  ["wait", ["timeoutSeconds"]],
  ["review", ["taskId"]],
  ["diff", ["taskId", "maxBytes"]],
  ["finish", []],
  ["steer", ["taskId", "text"]],
  ["respond", ["taskId", "requestId", "decision"]],
  ["answer", ["taskId", "requestId", "answers", "skip"]],
]);
/** Inspection stays available on an inactive run and is never receipted. */
const READ_ONLY_ACTIONS = new Set(["list", "get", "diff"]);
function checkFields(action: string, input: Record<string, unknown>) {
  const allowed = FIELDS.get(action);
  if (!allowed)
    throw new Error(
      `Unknown action "${action}". Use one of: ${[...FIELDS.keys()].join(", ")}. Run the control CLI with --help.`,
    );
  const unknown = Object.keys(input).filter((key) => !allowed.includes(key));
  if (unknown.length)
    throw new Error(
      `Unknown ${action} field${unknown.length > 1 ? "s" : ""}: ${unknown.join(", ")}. ${allowed.length ? `${action} accepts: ${allowed.join(", ")}.` : `${action} takes no input.`}`,
    );
}
/**
 * Quote the executable for the shell the lead runs in, and only when needed.
 * The path is absolute, so a leading slash means a POSIX shell — where a
 * backslash escapes rather than separates, and so is never safe bare.
 */
export function shellPath(path: string): string {
  if (path.startsWith("/"))
    return /^[A-Za-z0-9._/:-]+$/.test(path)
      ? path
      : `'${path.replace(/'/g, `'\\''`)}'`;
  return /[\s"]/.test(path) ? `"${path.replace(/"/g, "")}"` : path;
}
/** Map the lead's chosen option IDs onto the worker's own question shape. */
function questionAnswers(
  value: unknown,
  questions: { id: string; options: { id: string }[] }[] = [],
): Record<string, string[]> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error(
      'answers must be an object of questionId -> [optionId], or pass {"skip":true}',
    );
  const answers: Record<string, string[]> = {};
  for (const [id, chosen] of Object.entries(value)) {
    const question = questions.find((entry) => entry.id === id);
    if (!question)
      throw new Error(
        `Unknown question "${id}". Ask for: ${listed(questions.map((entry) => entry.id)) || "none"}.`,
      );
    const ids = strings(chosen, `answers.${id}`, 16);
    const unknown = ids.filter(
      (option) => !question.options.some((entry) => entry.id === option),
    );
    if (unknown.length)
      throw new Error(
        `Unknown option${unknown.length > 1 ? "s" : ""} for "${id}": ${listed(unknown)}. Choose from: ${listed(question.options.map((entry) => entry.id))}.`,
      );
    answers[id] = ids;
  }
  if (!Object.keys(answers).length)
    throw new Error('Answer at least one question, or pass {"skip":true}');
  return answers;
}
function diffBytes(value: unknown): number {
  if (value == null) return DIFF_BYTES.default;
  if (typeof value !== "number" || !Number.isFinite(value))
    throw new Error(
      `maxBytes must be a number of bytes from ${DIFF_BYTES.min} to ${DIFF_BYTES.max}; omit it for ${DIFF_BYTES.default}.`,
    );
  return Math.min(DIFF_BYTES.max, Math.max(DIFF_BYTES.min, Math.round(value)));
}
const listed = (values: string[], max = 12) =>
  values.length > max
    ? `${values.slice(0, max).join(", ")} (+${values.length - max} more)`
    : values.join(", ");

/** Failing check output per check in list and wait; get keeps the full tail. */
const LIST_CHECK_OUTPUT = 1000;

/** A new instruction from the lead restarts check accounting. */
const FRESH_CHECKS = {
  checkResults: undefined,
  checkRetries: undefined,
  checkRunId: undefined,
  recheck: undefined,
  autoAccepted: undefined,
  autoAcceptError: undefined,
} satisfies Partial<OrchestrationTask>;

/** Bookkeeping the lead never acts on. */
const internalFieldsHidden = (task: OrchestrationTask) => ({
  ...task,
  checkRunId: undefined,
  recheck: undefined,
  usageBlockId: undefined,
});

/** Review tasks that read `task`, with their verdicts once complete. */
function reviewsOf(run: OrchestrationRun, task: OrchestrationTask) {
  const reviews = run.tasks
    .filter(
      (entry) => entry.kind === "review" && entry.reviewOf?.includes(task.id),
    )
    .map((entry) => ({
      taskId: entry.id,
      title: entry.title,
      status: entry.status,
      verdict: reviewVerdict(entry),
    }));
  return reviews.length ? reviews : undefined;
}

export class Orchestrator {
  private runs: OrchestrationRun[] = [];
  private listeners = new Set<() => void>();
  private loaded = new Set<string>();
  private deleted = new Set<string>();
  private persisted = new Map<string, OrchestrationRun>();
  private saves = Promise.resolve();
  private actions = Promise.resolve();
  private pumping = false;
  private starting = new Set<string>();
  private pumpAgain = false;
  private waking = new Set<string>();
  /** One pending lead wake-up per run, with the time it is due. */
  private wakeTimers = new Map<
    string,
    { timer: ReturnType<typeof setTimeout>; due: number }
  >();
  /** When the oldest undelivered event of a run was first seen. */
  private pendingSince = new Map<string, number>();
  private blocked = new Map<string, string>();
  private announced = new Map<string, Set<string>>();
  /** Async write checks are isolated per dispatch, including retries. */
  private writeChecks = new Map<string, Set<Promise<void>>>();
  private inflight = new Map<
    string,
    { signature: string; promise: Promise<unknown> }
  >();
  private host: OrchestrationHost | null = null;
  constructor(private readonly store: Storage = storage) {}
  bind(host: OrchestrationHost) {
    this.host = host;
  }
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  snapshot = () => this.runs;
  run(id: string) {
    return this.runs.find((run) => run.leadId === id);
  }
  forSession(id: string) {
    return this.runs.find(
      (run) =>
        run.leadId === id || run.tasks.some((task) => task.sessionId === id),
    );
  }
  resumeBlocker(leadId: string, checkoutCwd?: string): Session | undefined {
    const lead = this.host?.session(leadId);
    if (!lead) return undefined;
    const cwd =
      checkoutCwd ??
      (this.run(leadId)
        ? orchestrationCheckoutCwd(this.run(leadId)!)
        : (lead.worktreeCwd ?? lead.cwd));
    return this.host
      ?.sessions()
      .find(
        (session) =>
          session.id !== leadId &&
          session.busy &&
          sameCheckout(session.worktreeCwd ?? session.cwd, cwd),
      );
  }
  resumeLeadBusy(leadId: string): boolean {
    return !!this.host?.session(leadId)?.busy;
  }
  /**
   * Whether the lead's run references this checkout, from memory or its saved
   * history, without hydrating (which would stop and pause a saved run). Any
   * doubt, including an unreadable history, answers true.
   */
  async ownsWorktree(
    leadId: string,
    path: string,
    branch?: string,
  ): Promise<boolean> {
    let run = this.run(leadId);
    if (!run) {
      try {
        run = (await this.store.load(leadId)) ?? undefined;
      } catch {
        return true;
      }
    }
    if (!run) return false;
    const key = orchestrationPathKey(path);
    const matches = (workspace?: OrchestrationWorkspace) =>
      !!workspace &&
      (orchestrationPathKey(workspace.checkoutCwd) === key ||
        (!!branch && workspace.branch === branch));
    return (
      run.tasks.some((task) => matches(task.workspace)) ||
      (run.dispatches ?? []).some((dispatch) => matches(dispatch.workspace))
    );
  }
  private emit() {
    for (const listener of this.listeners) listener();
  }
  private async commit(run: OrchestrationRun) {
    run = normalizeOrchestrationRun(run);
    this.runs = [
      ...this.runs.filter((entry) => entry.leadId !== run.leadId),
      run,
    ];
    this.emit();
    const saved = this.saves
      .catch(() => undefined)
      .then(async () => {
        await this.store.save(run);
        this.persisted.set(run.leadId, run);
      });
    this.saves = saved;
    try {
      await saved;
    } catch (error) {
      const current = this.run(run.leadId)!;
      const running = current.tasks.filter(activeTask);
      this.runs = this.runs.map((entry) =>
        entry.leadId === run.leadId
          ? {
              ...entry,
              status: "paused",
              error: `Could not save run: ${messageOf(error)}`,
              ...settleActiveTime(entry),
              tasks: entry.tasks.map((task) =>
                activeTask(task)
                  ? { ...task, status: "cancelling" }
                  : task.status === "checking"
                    ? checksInterrupted(task, "run history could not be saved")
                    : task,
              ),
            }
          : entry,
      );
      this.emit();
      // Keep the checkout reserved until processes have stopped, even if the
      // database is unavailable. Resume sends a recovery turn into the same
      // retained checkout instead of pretending the interrupted turn finished.
      await Promise.allSettled(
        [run.leadId, ...running.map((task) => task.sessionId)].map(
          async (id) => {
            await this.host?.stop(id);
            const latest = this.run(run.leadId)!;
            const stoppedTask = latest.tasks.find(
              (task) => task.sessionId === id && activeTask(task),
            );
            this.runs = this.runs.map((entry) =>
              entry.leadId === run.leadId
                ? {
                    ...latest,
                    tasks: latest.tasks.map((task) =>
                      task.sessionId === id && activeTask(task)
                        ? {
                            ...task,
                            status: "interrupted",
                            accepted: false,
                            delivered: true,
                            activeDispatchId: undefined,
                            ...(task.activeDispatchId
                              ? { lastDispatchId: task.activeDispatchId }
                              : {}),
                            error:
                              "Stopped because run history could not be saved. Resume will continue from the retained worker checkout.",
                            recoveryPrompt: recoveryTurn(
                              "run history could not be saved",
                            ),
                          }
                        : task,
                    ),
                    dispatches: (latest.dispatches ?? []).map((dispatch) =>
                      dispatch.id === stoppedTask?.activeDispatchId
                        ? {
                            ...dispatch,
                            state: "interrupted",
                            stage: "settled",
                            updatedAt: Date.now(),
                            error:
                              "Stopped because run history could not be saved.",
                          }
                        : dispatch,
                    ),
                  }
                : entry,
            );
            this.emit();
          },
        ),
      );
      throw error;
    }
  }
  private async patchTask(
    leadId: string,
    id: string,
    patch: Partial<OrchestrationTask>,
  ) {
    const run = this.run(leadId);
    if (run)
      await this.commit({
        ...run,
        tasks: run.tasks.map((task) =>
          task.id === id ? { ...task, ...patch } : task,
        ),
      });
  }
  private async patchDispatch(
    leadId: string,
    dispatchId: string,
    patch: Partial<OrchestrationDispatch>,
  ) {
    const run = this.run(leadId);
    if (run)
      await this.commit({
        ...run,
        dispatches: (run.dispatches ?? []).map((dispatch) =>
          dispatch.id === dispatchId
            ? { ...dispatch, ...patch, updatedAt: Date.now() }
            : dispatch,
        ),
      });
  }
  private async cleanupUnchangedWorker(
    leadId: string,
    taskId: string,
  ): Promise<boolean> {
    const run = this.run(leadId);
    const task = run?.tasks.find((entry) => entry.id === taskId);
    if (!run || !task || task.workspacePolicy === "shared" || !task.workspace)
      return true;
    try {
      const cleaned = await this.host?.cleanupWorker(run, task, true);
      if (!cleaned) return false;
      const current = this.run(leadId);
      if (!current) return false;
      await this.commit({
        ...current,
        tasks: current.tasks.map((entry) =>
          entry.id === taskId ? { ...entry, workspace: undefined } : entry,
        ),
        dispatches: (current.dispatches ?? []).map((dispatch) =>
          dispatch.id === task.lastDispatchId
            ? {
                ...dispatch,
                stage: "cleaned",
                cleanupError: undefined,
                updatedAt: Date.now(),
              }
            : dispatch,
        ),
      });
      return true;
    } catch (error) {
      if (task.lastDispatchId)
        await this.patchDispatch(leadId, task.lastDispatchId, {
          cleanupError: messageOf(error),
        });
      return false;
    }
  }
  async hydrate(id: string) {
    if (this.loaded.has(id) || this.run(id)) return;
    this.loaded.add(id);
    try {
      const loaded = await this.store.load(id);
      if (!loaded || this.run(id) || this.deleted.has(id)) return;
      const run = normalizeOrchestrationRun(loaded);
      if (run.status === "active" || run.tasks.some(activeTask)) {
        await Promise.all(
          [
            id,
            ...run.tasks.filter(activeTask).map((task) => task.sessionId),
          ].map((sessionId) => this.host?.stop(sessionId)),
        );
        await this.store.disable(id);
      }
      const interrupted = new Set(
        run.tasks
          .filter(activeTask)
          .map((task) => task.activeDispatchId)
          .filter((dispatchId): dispatchId is string => !!dispatchId),
      );
      // The app was closed for an unknown time; count active time only up to
      // the last recorded activity.
      const lastActivity = Math.max(
        run.activeSince ?? 0,
        ...(run.dispatches ?? []).map((dispatch) => dispatch.updatedAt),
        ...run.tasks.map((task) => task.finishedAt ?? 0),
      );
      await this.commit({
        ...run,
        status: run.status === "active" ? "paused" : run.status,
        activeMs:
          (run.activeMs ?? 0) +
          (run.activeSince ? Math.max(0, lastActivity - run.activeSince) : 0),
        activeSince: undefined,
        tasks: run.tasks.map((task) =>
          task.status === "checking"
            ? checksInterrupted(task, "MonoCode stopped while they ran")
            : activeTask(task)
            ? {
                ...task,
                status: "interrupted",
                activeDispatchId: undefined,
                ...(task.activeDispatchId
                  ? { lastDispatchId: task.activeDispatchId }
                  : {}),
                accepted: false,
                error:
                  "Interrupted while MonoCode was not running. Resume will continue from the retained worker checkout.",
                recoveryPrompt: recoveryTurn(
                  "MonoCode stopped while the worker was running",
                ),
                delivered: true,
              }
            : { ...task, delivered: task.accepted || task.status === "queued" },
        ),
        dispatches: (run.dispatches ?? []).map((dispatch) =>
          interrupted.has(dispatch.id)
            ? {
                ...dispatch,
                state: "interrupted",
                stage: "settled",
                updatedAt: Date.now(),
                error: "Interrupted while MonoCode was not running.",
              }
            : dispatch,
        ),
        error:
          run.status === "active"
            ? "Run interrupted while MonoCode was not running. Worker checkouts were retained; Resume will continue them."
            : run.error,
        lastPauseReason:
          run.status === "active"
            ? "MonoCode stopped while the orchestration run was active."
            : run.lastPauseReason,
      });
    } catch (error) {
      this.loaded.delete(id);
      throw error;
    }
  }
  /**
   * `limits` overrides apply to a new run; a resumed run keeps the limits it
   * was started with unless overrides are passed again.
   */
  async start(
    leadId: string,
    allowedHarnesses: HarnessId[],
    maxWorkers: number,
    approved?: ApprovedStart,
    limits?: Partial<OrchestrationLimits>,
    options?: OrchestrationRunOptions,
  ) {
    if (this.starting.has(leadId))
      throw new Error("The run is already starting");
    this.starting.add(leadId);
    try {
      await this.startRun(
        leadId,
        allowedHarnesses,
        maxWorkers,
        approved,
        limits,
        options,
      );
    } finally {
      this.starting.delete(leadId);
    }
  }
  /**
   * `options.autoAccept` overrides the card's setting; `options.budget` caps
   * the run's time and worker turns.
   */
  async startApproved(
    leadId: string,
    proposalId: string,
    proposal: OrchestrationProposal,
    overrides?: Partial<OrchestrationLimits>,
    options?: OrchestrationRunOptions,
  ) {
    if (proposal.status !== "ready")
      throw new Error("Review a completed proposal before starting");
    const limits = resolveOrchestrationLimits(overrides);
    const settings = validateOrchestrationSettings(proposal.settings, limits);
    const budget = validateOrchestrationBudget(
      options?.budget ?? settings.budget,
    );
    const autoAccept = options?.autoAccept ?? settings.autoAccept ?? false;
    const planned = validateProposedTasks(
      proposal.tasks,
      settings,
      proposal.checkoutCwd ?? proposal.cwd,
      limits,
    );
    const brief = validateOrchestrationBrief(proposal.brief);
    const lead = this.host?.session(leadId);
    if (
      !lead ||
      !sameCheckout(lead.cwd, proposal.cwd) ||
      !sameCheckout(
        lead.worktreeCwd ?? lead.cwd,
        proposal.checkoutCwd ?? proposal.cwd,
      )
    )
      throw new Error("Return to the proposal's checkout before starting");
    const available = this.host!.choices();
    const allowedModels = settings.choices.filter((choice) =>
      available.some(
        (entry) =>
          entry.harness === choice.harness &&
          entry.models.some((model) => model.id === choice.model),
      ),
    );
    if (
      planned.some(
        (task) =>
          !allowedModels.some(
            (choice) =>
              choice.harness === task.harness && choice.model === task.model,
          ),
      )
    )
      throw new Error(
        "An assigned model is no longer available. Change that assignment before starting.",
      );
    const ids = new Map(planned.map((task) => [task.id, crypto.randomUUID()]));
    const tasks: OrchestrationTask[] = await Promise.all(
      planned.map(async (task) => ({
        ...task,
        id: ids.get(task.id)!,
        assignmentId: task.id,
        sessionId: crypto.randomUUID(),
        scopes: task.files.length
          ? await this.store.scopes(lead.worktreeCwd ?? lead.cwd, task.files)
          : [],
        dependsOn: task.dependsOn.map((id) => ids.get(id)!),
        ...(task.reviewOf
          ? { reviewOf: task.reviewOf.map((id) => ids.get(id)!) }
          : {}),
        status: "queued",
        accepted: false,
        delivered: true,
        result: "",
        workspacePolicy: "isolated-child",
      })),
    );
    const currentLead = this.host?.session(leadId);
    if (
      !currentLead ||
      !sameCheckout(
        currentLead.worktreeCwd ?? currentLead.cwd,
        proposal.checkoutCwd ?? proposal.cwd,
      )
    )
      throw new Error("Return to the proposal's checkout before starting");
    await this.start(
      leadId,
      [...new Set(allowedModels.map((choice) => choice.harness))],
      settings.maxWorkers,
      { proposalId, allowedModels, tasks, brief },
      limits,
      { autoAccept, budget },
    );
    this.host!.submit(
      leadId,
      `The user confirmed the orchestration card, including any edits. The app has already queued the exact assignments below; do not delegate duplicates. Supervise them through the control CLI, review their changes, request corrections when needed, and finish the original request.\n\nOriginal request:\n${proposal.request}\n\nApproved assignments:\n${JSON.stringify(tasks.map(({ id, title, prompt, harness, model, modelSettings, files, dependsOn, kind, reviewOf, checks }) => ({ taskId: id, title, prompt, harness, model, modelSettings, files, dependsOn, kind, reviewOf, checks })))}`,
      (outcome) => {
        if (outcome.status !== "completed")
          void this.pause(
            leadId,
            outcome.error ??
              "The lead was interrupted. Its agents were stopped; review and resume the run.",
          ).catch(console.error);
      },
    );
  }
  private async startRun(
    leadId: string,
    allowedHarnesses: HarnessId[],
    maxWorkers: number,
    approved?: ApprovedStart,
    overrides?: Partial<OrchestrationLimits>,
    options?: OrchestrationRunOptions,
  ) {
    const lead = this.host?.session(leadId);
    if (!lead) throw new Error("The orchestration lead is unavailable");
    const requestedBudget = validateOrchestrationBudget(options?.budget);
    if (lead.busy)
      throw new Error(
        this.run(leadId)?.status === "paused"
          ? "Wait for the lead's interrupted turn to finish before resuming orchestration"
          : "Wait for the lead's current turn to finish",
      );
    const workspace = workspaceIdentity(
      lead.cwd,
      lead.worktreeCwd ?? lead.cwd,
      lead.branch,
    );
    const previous = this.run(leadId);
    const resumable = previous?.status === "paused" ? previous : undefined;
    const limits = resolveOrchestrationLimits({
      ...resumable?.limits,
      ...overrides,
    });
    if (
      !Number.isInteger(maxWorkers) ||
      maxWorkers < 1 ||
      maxWorkers > limits.maxWorkers
    )
      throw new Error(`Choose 1 to ${limits.maxWorkers} workers`);
    const available = this.host!.choices().map((choice) => choice.harness);
    if (
      !allowedHarnesses.length ||
      allowedHarnesses.some((id) => !available.includes(id))
    )
      throw new Error("Choose installed worker harnesses");
    if (
      previous?.status === "active" ||
      (approved && previous?.status === "paused")
    )
      throw new Error("Stop the current run before starting another proposal");
    if (previous?.tasks.some(busyTask))
      throw new Error(
        previous.status === "paused"
          ? "Wait for interrupted agents to stop before resuming orchestration"
          : "Stop active workers before changing the run",
      );
    if (
      previous?.status === "paused" &&
      !sameCheckout(orchestrationCheckoutCwd(previous), workspace.checkoutCwd)
    )
      throw new Error(
        "Return the lead to its original checkout before resuming orchestration",
      );
    const blocker = this.resumeBlocker(leadId, workspace.checkoutCwd);
    if (blocker) {
      const label = blocker.title.trim() || blocker.id;
      throw new Error(
        `"${label}" is still running in this checkout. Stop it before ${
          previous?.status === "paused"
            ? "resuming orchestration"
            : "starting orchestration"
        }.`,
      );
    }
    const [canonicalRoot] = await this.store.scopes(workspace.checkoutCwd, [
      ".",
    ]);
    const cli = await this.store.enable(leadId, workspace.checkoutCwd);
    const resumedTasks =
      previous?.status === "paused"
        ? previous.tasks.map((task): OrchestrationTask =>
            task.status === "interrupted" && task.recheck
              ? {
                  ...task,
                  status: "checking",
                  checkRunId: crypto.randomUUID(),
                  recheck: undefined,
                  error: undefined,
                  delivered: true,
                  accepted: false,
                }
              : task.status === "interrupted"
              ? {
                  ...task,
                  status: "queued" as const,
                  error: undefined,
                  delivered: true,
                  accepted: false,
                  activeDispatchId: undefined,
                  recoveryPrompt:
                    task.recoveryPrompt ??
                    recoveryTurn(
                      previous.error ??
                        previous.lastPauseReason ??
                        "the run was paused",
                    ),
                }
              : task,
          )
        : [];
    const budget = requestedBudget ?? (approved ? undefined : resumable?.budget);
    // Resuming a run whose budget ran out grants the same allowance again,
    // counted from now; a raised budget that still has room keeps counting.
    const spent =
      resumable &&
      budget &&
      budgetReason({ ...resumable, budget }, true) !== undefined;
    const usage = resumable && orchestrationUsage(resumable);
    const rechecks = resumedTasks.filter(
      (task) => task.status === "checking" && task.checkRunId,
    );
    try {
      await this.host!.stop(leadId); // Refresh the child environment before its next turn.
      await this.commit({
        autoAccept:
          options?.autoAccept ??
          (approved ? false : (resumable?.autoAccept ?? false)),
        budget,
        budgetBaseline:
          spent && usage
            ? { elapsedMs: usage.elapsedMs, workerTurns: usage.workerTurns }
            : approved
              ? undefined
              : resumable?.budgetBaseline,
        activeMs: approved ? 0 : (resumable?.activeMs ?? 0),
        activeSince: Date.now(),
        version: 2,
        leadId,
        cwd: lead.cwd,
        workspace,
        canonicalRoot,
        cli,
        status: "active",
        allowedHarnesses: [...new Set(allowedHarnesses)],
        allowedModels:
          approved?.allowedModels ??
          (previous?.status === "paused" ? previous.allowedModels : undefined),
        proposalId:
          approved?.proposalId ??
          (previous?.status === "paused" ? previous.proposalId : undefined),
        brief: approved ? approved.brief : resumable?.brief,
        maxWorkers,
        limits,
        tasks:
          approved?.tasks ??
          (previous?.status === "paused" ? resumedTasks : []),
        dispatches:
          previous?.status === "paused" ? (previous.dispatches ?? []) : [],
        continuations: 0,
        requests: previous?.status === "paused" ? previous.requests : {},
        lastPauseReason:
          previous?.status === "paused"
            ? (previous.error ?? previous.lastPauseReason)
            : undefined,
      });
    } catch (error) {
      await this.store.disable(leadId);
      throw error;
    }
    for (const task of rechecks)
      void this.runChecks(leadId, task.id, task.checkRunId!).catch(
        console.error,
      );
    void this.pump();
    this.sync();
  }
  submissionError(id: string, managed = false): string | null {
    if (managed) return null;
    const session = this.host?.session(id);
    if (!session) return null;
    const own = this.forSession(id);
    if (
      own &&
      own.leadId !== id &&
      (own.status === "active" || own.tasks.some(busyTask))
    )
      return "This worker is managed by the orchestrator. Send instructions through its lead or stop the run first.";
    const other = this.runs.find(
      (run) =>
        (run.status === "active" || run.tasks.some(busyTask)) &&
        run.leadId !== id &&
        sameCheckout(
          orchestrationCheckoutCwd(run),
          session.worktreeCwd ?? session.cwd,
        ),
    );
    if (other)
      return "This checkout has an active orchestrator. Stop that run before starting independent work.";
    if (own?.status === "paused")
      return "Resume or stop orchestration before sending the lead another turn.";
    if (
      own?.status === "active" &&
      !sameCheckout(
        orchestrationCheckoutCwd(own),
        session.worktreeCwd ?? session.cwd,
      )
    )
      return "Return the lead to its original project or stop orchestration first.";
    return null;
  }
  prompt(id: string, prompt: string): string {
    const run = this.run(id);
    if (!run || run.status !== "active") return prompt;
    const cli = `${shellPath(run.cli)} control`;
    return `${prompt}\n\n<monocode_orchestration>\nYou are the lead of a local MonoCode run. Coordinate the user's task using ${cli}. Run \`${cli} --help\` before your first command; it documents every action, its exact JSON fields and the retry rule. Credentials are already in your environment; never print them.\nEach call prints one JSON line and exits non-zero unless "ok" is true; read the "error" text, it says what to do next. Unknown JSON fields are rejected rather than ignored, so fix the field name instead of guessing. If a call fails before reaching MonoCode, retry it with the "requestId" from that response so the work is never queued twice.\nUse list to discover allowed harness/model IDs. Delegate bounded tasks with project-relative files (directories reserve their descendants), self-contained prompts and dependsOn task IDs. Use the checkout selected for this run. You may read and plan; leave project file edits to workers. Never start workers outside this CLI. Workers with overlapping files are queued. For project-wide validation, generators or broad formatting, assign a separate task with files ["."] and wait for other workers to finish. Workers must never commit, push, switch branches or write outside the selected checkout. If the user requested those final operations, review and integrate every worker, call finish, then perform the explicitly authorized finalization yourself from the lead checkout.\nAgents never prompt the user. When one needs an approval or answers a question, list, get and wait report it as needsInput on that task, and you decide with respond or answer; it stays stopped until you do. Judge the request against the task you assigned, and put it to the user in this conversation only when the call is genuinely theirs.\nSupervision is event-driven: after delegating, end your turn instead of polling. MonoCode wakes you automatically, batching worker results together and bringing any approval or question that needs you. Use wait only when you genuinely need a result before you can continue the current turn, keep it bounded, and never loop on list, get or wait.
Steer a running agent with steer to correct its course without losing its work; use message only once it has stopped. Each result is a compact report: status, summary, the files the worker actually changed, its checks and blockers; get shows one task in detail. Completed means a turn finished, not that the work passed review. Review with diff before review/accept: read the actual patch, message a worker for fixes, and use review to accept each completed task. A scope-blocked worker is isolated to that task: use message if it should stay within its existing scope, retry with corrected project-relative files if the assignment was too narrow, or cancel it if no longer needed. Never expand scope merely to excuse an unexpected write. Call finish only when required work and combined validation are complete. If the run is paused, list/get/diff/wait remain readable and explain the reason. Stop polling, report that reason, and ask the user to click Resume; Resume automatically continues interrupted workers from their retained checkouts. Do not expose credentials, create worktrees, switch branches or silently escalate worker permissions.\nGive a delegated task "checks" when a fast, focused command can verify it, such as one test file or a typecheck. MonoCode runs them in the worker's checkout after each turn (status checking) and sends failures back to the worker itself, so you are woken only once they pass or its automatic fixes run out; "App-run checks" in a result are MonoCode's own results, not the worker's claims. For an independent read-only review, delegate "kind":"review" with "reviewOf" taskIds and no files: it starts once those tasks complete, reads their patches, and its verdict arrives with their results (approved, or changes requested with blockers). Accepting a review task only records it; it never changes files.${
      run.autoAccept
        ? " This run auto-accepts: a completed task whose checks all passed and whose report is done is integrated without your review, and its result says so. Tasks without checks still wait for your review."
        : ""
    }${
      run.budget
        ? ` This run has a budget (${[
            run.budget.maxMinutes ? `${run.budget.maxMinutes} minutes` : "",
            run.budget.maxWorkerTurns
              ? `${run.budget.maxWorkerTurns} worker turns`
              : "",
          ]
            .filter(Boolean)
            .join(", ")}); MonoCode pauses the run when it is spent, so delegate economically.`
        : ""
    }\n</monocode_orchestration>`;
  }
  async handle(
    leadId: string,
    requestId: string,
    action: string,
    input: Record<string, unknown>,
  ): Promise<unknown> {
    checkFields(action, input);
    const signature = JSON.stringify({ action, input });
    const key = `${leadId}:${requestId}`;
    const receipts = this.persisted.get(leadId)?.requests;
    const previous =
      receipts &&
      Object.prototype.hasOwnProperty.call(receipts, requestId) &&
      typeof receipts[requestId]?.signature === "string"
        ? receipts[requestId]
        : undefined;
    if (previous) {
      if (previous.signature !== signature)
        throw new Error("Request ID was already used with different input");
      return previous.result;
    }
    const pending = this.inflight.get(key);
    if (pending) {
      if (pending.signature !== signature)
        throw new Error("Request ID was already used with different input");
      return pending.promise;
    }
    if (action === "wait") return this.wait(leadId, input);
    const result = this.actions
      .catch(() => undefined)
      .then(async () => {
        const run = this.run(leadId);
        if (!run)
          throw new Error("No orchestration run was found for this lead");
        const readOnly = READ_ONLY_ACTIONS.has(action);
        if (run.status !== "active" && !readOnly)
          throw new Error(this.inactiveReason(run));
        if (
          !readOnly &&
          Object.keys(run.requests).length >=
            orchestrationLimits(run).maxCommands
        )
          throw new Error(
            "Run command limit reached. Stop the run and start another after reviewing the files.",
          );
        return this.execute(run, action, input, requestId, signature);
      });
    this.actions = result.then(
      () => undefined,
      () => undefined,
    );
    this.inflight.set(key, { signature, promise: result });
    try {
      return await result;
    } finally {
      this.inflight.delete(key);
      void this.pump();
    }
  }
  /**
   * The run as list and wait report it. Results are compact: a worker's report
   * replaces its text, and dispatch history omits the text it already carries.
   */
  private view(run: OrchestrationRun) {
    const { leadResultChars } = orchestrationLimits(run);
    return {
      ...run,
      cli: undefined,
      requests: undefined,
      brief: undefined,
      budgetBaseline: undefined,
      activeMs: undefined,
      activeSince: undefined,
      usage: orchestrationUsage(run),
      recovery: run.status === "active" ? undefined : this.inactiveReason(run),
      dispatches: run.dispatches?.map((dispatch) => ({
        ...dispatch,
        result: undefined,
      })),
      tasks: run.tasks.map((task) => ({
        ...internalFieldsHidden(task),
        prompt: undefined,
        scopes: undefined,
        ...leadResultFields(task, leadResultChars),
        // Passing output is noise in a list; get returns every tail.
        checkResults: task.checkResults?.map((check) => ({
          ...check,
          outputTail: check.passed
            ? undefined
            : check.outputTail.slice(-LIST_CHECK_OUTPUT),
        })),
        reviews: reviewsOf(run, task),
        waitingFor: this.waitingFor(run, task),
        needsInput: this.pendingInput(task),
      })),
    };
  }
  private inactiveReason(run: OrchestrationRun): string {
    return run.status === "paused"
      ? `This run is paused. ${run.error ?? "Work was interrupted."} list, get and wait remain available for inspection. Do not retry mutations or keep polling: explain the pause and ask the user to click Resume in MonoCode. Resume will continue interrupted tasks from their retained worker checkouts; policy-blocked tasks remain stopped for an explicit retry or cancellation.`
      : `This run is ${run.status}. Inspect results with list or get; do not keep retrying commands for this run.`;
  }
  /**
   * What a worker is blocked on. Workers have no user-facing prompt: the lead
   * answers for them, and escalates to the user in its own conversation when
   * it does not want to decide alone.
   */
  pendingInput(task: OrchestrationTask) {
    const worker = this.host?.session(task.sessionId);
    const pending = worker && pendingApprovalForSession(worker);
    if (!pending) return undefined;
    return {
      kind: pending.kind,
      requestId: pending.requestId,
      label: pending.label,
      detail:
        pending.kind === "approval"
          ? (pending.block?.tool?.detail?.trim() ?? pending.block?.text)
          : undefined,
      questions: worker?.pendingQuestion?.questions,
    };
  }
  waitingFor(
    run: OrchestrationRun,
    task: OrchestrationTask,
  ): string | undefined {
    if (task.status !== "queued") return undefined;
    const dependency = run.tasks.find(
      (entry) => task.dependsOn.includes(entry.id) && !entry.accepted,
    );
    if (dependency) return `Waiting for review: ${dependency.title}`;
    const reviewed = run.tasks.find(
      (entry) =>
        task.reviewOf?.includes(entry.id) && entry.status !== "completed",
    );
    if (reviewed)
      return ["queued", "running", "cancelling", "checking"].includes(
        reviewed.status,
      )
        ? `Waiting for ${reviewed.title} to complete`
        : `Cannot review ${reviewed.title}: it is ${reviewed.status}. Correct it with message or retry, or cancel this review.`;
    const owner = run.tasks.find(
      (entry) => busyTask(entry) && scopesOverlap(entry.scopes, task.scopes),
    );
    if (owner) return `Waiting for files: ${owner.title}`;
    return "Waiting for a worker slot";
  }
  private async execute(
    run: OrchestrationRun,
    action: string,
    input: Record<string, unknown>,
    requestId: string,
    signature: string,
  ): Promise<unknown> {
    // Persist the mutation and its retry receipt together, before dispatch.
    const record = async (next: OrchestrationRun, result: unknown) => {
      await this.commit({
        ...next,
        requests: { ...next.requests, [requestId]: { signature, result } },
      });
      return result;
    };
    const changeTask = (
      id: string,
      patch: Partial<OrchestrationTask>,
      result: unknown,
    ) => {
      const current = this.run(run.leadId)!;
      return record(
        {
          ...current,
          tasks: current.tasks.map((entry) =>
            entry.id === id ? { ...entry, ...patch } : entry,
          ),
        },
        result,
      );
    };
    const task = () => {
      const id = text(input.taskId, "taskId", 128);
      const found = this.run(run.leadId)!.tasks.find(
        (entry) => entry.id === id,
      );
      if (!found)
        throw new Error(
          "Task does not belong to this run. Use a taskId returned by delegate or list.",
        );
      return found;
    };
    switch (action) {
      case "list":
        return {
          run: this.view(run),
          harnesses: this.host!.choices()
            .filter((choice) => run.allowedHarnesses.includes(choice.harness))
            .map((choice) => ({
              ...choice,
              models: choice.models.filter(
                (model) =>
                  !run.allowedModels ||
                  run.allowedModels.some(
                    (allowed) =>
                      allowed.harness === choice.harness &&
                      allowed.model === model.id,
                  ),
              ),
            })),
        };
      case "get": {
        // The fields list reports, plus this task's own prompt.
        const target = task();
        return {
          ...internalFieldsHidden(target),
          ...leadResultFields(target, orchestrationLimits(run).leadResultChars),
          reviews: reviewsOf(this.run(run.leadId)!, target),
          runStatus: run.status,
          recovery:
            run.status === "active" ? undefined : this.inactiveReason(run),
          scopes: undefined,
          waitingFor: this.waitingFor(this.run(run.leadId)!, target),
          needsInput: this.pendingInput(target),
        };
      }
      case "delegate": {
        const { maxTasks } = orchestrationLimits(run);
        if (run.tasks.length >= maxTasks)
          throw new Error(
            `This run has reached its ${maxTasks}-task limit. Reuse an existing task with message or retry, or finish this run and start another.`,
          );
        const harness = text(input.harness, "harness") as HarnessId;
        if (
          !HARNESSES.includes(harness) ||
          !run.allowedHarnesses.includes(harness)
        )
          throw new Error(
            `Harness "${harness}" is not allowed in this run. Allowed: ${listed(run.allowedHarnesses)}.`,
          );
        const choice = this.host!.choices().find(
          (entry) => entry.harness === harness,
        );
        if (!choice) throw new Error("Worker harness is unavailable");
        const permittedModels = choice.models.filter(
          (model) =>
            !run.allowedModels ||
            run.allowedModels.some(
              (allowed) =>
                allowed.harness === harness && allowed.model === model.id,
            ),
        );
        const model =
          input.model == null
            ? permittedModels[0]?.id
            : text(input.model, "model", 256);
        if (!model || !permittedModels.some((item) => item.id === model))
          throw new Error(
            `Choose a model ID returned by list for ${harness}: ${listed(permittedModels.map((item) => item.id)) || "none available"}.`,
          );
        const kind = validateTaskKind(input.kind, "This task's");
        const title = text(input.title, "title", 160);
        const prompt =
          kind === "review" && input.prompt == null
            ? "Review the changes of the listed tasks."
            : text(input.prompt, "prompt");
        const files = strings(
          kind === "review" ? (input.files ?? []) : input.files,
          "files",
        );
        const checks = validateTaskChecks(input.checks, "This task's");
        const reviewOf =
          input.reviewOf == null
            ? []
            : strings(input.reviewOf, "reviewOf", maxTasks);
        if (kind === "review") {
          if (files.length)
            throw new Error(
              'A review task has no write scope: omit files or pass []. To have changes made, delegate a "work" task instead.',
            );
          if (!reviewOf.length)
            throw new Error(
              "A review task needs reviewOf: the taskIds of the work it reviews, from delegate or list.",
            );
          if (checks)
            throw new Error(
              "A review task cannot have checks: they would run in its own unchanged checkout. Put checks on the work task it reviews.",
            );
          const invalid = reviewOf.filter((id) => {
            const reviewed = run.tasks.find((item) => item.id === id);
            return (
              !reviewed ||
              reviewed.kind === "review" ||
              reviewed.status === "cancelled"
            );
          });
          if (invalid.length)
            throw new Error(
              `reviewOf must hold work taskIds from this run; unknown, cancelled or review tasks: ${listed(invalid)}.`,
            );
        } else {
          if (!files.length)
            throw new Error(
              "Declare at least one file/directory scope in files, or '.' for exclusive checkout access",
            );
          if (reviewOf.length)
            throw new Error(
              'reviewOf is only for review tasks. Pass "kind":"review" with no files, or drop reviewOf.',
            );
        }
        const dependsOn = strings(input.dependsOn ?? [], "dependsOn", maxTasks);
        const missing = dependsOn.filter(
          (id) =>
            !run.tasks.some(
              (item) => item.id === id && item.status !== "cancelled",
            ),
        );
        if (missing.length)
          throw new Error(
            `dependsOn must hold taskIds from this run; unknown or cancelled: ${listed(missing)}.`,
          );
        const scopes = files.length
          ? await this.store.scopes(orchestrationCheckoutCwd(run), files)
          : [];
        // Reviewers also get a throwaway worktree: a write the harness does not
        // report (a shell command) can never reach the lead checkout.
        const created: OrchestrationTask = {
          id: crypto.randomUUID(),
          sessionId: crypto.randomUUID(),
          title,
          prompt,
          files,
          scopes,
          dependsOn,
          harness,
          model,
          status: "queued",
          accepted: false,
          result: "",
          delivered: true,
          workspacePolicy: "isolated-child",
          ...(kind === "review" ? { kind, reviewOf } : {}),
          ...(checks ? { checks } : {}),
        };
        return record(
          {
            ...this.run(run.leadId)!,
            tasks: [...this.run(run.leadId)!.tasks, created],
          },
          {
            taskId: created.id,
            sessionId: created.sessionId,
            status: "queued",
          },
        );
      }
      case "message": {
        const target = task();
        if (busyTask(target) || target.status === "queued")
          throw new Error(
            `Wait for this worker or cancel it before sending a new turn; ${target.title} is ${target.status}.`,
          );
        if (
          run.tasks.some(
            (entry) =>
              entry.dependsOn.includes(target.id) &&
              entry.status !== "queued" &&
              entry.status !== "cancelled",
          )
        )
          throw new Error(
            "A dependent task has already started; create a separate correction task after it finishes",
          );
        return changeTask(
          target.id,
          {
            prompt: text(input.text, "text"),
            status: "queued",
            accepted: false,
            result: "",
            report: undefined,
            changes: undefined,
            error: undefined,
            recoveryPrompt: undefined,
            delivered: true,
            activeDispatchId: undefined,
            acceptedDispatchId: undefined,
            ...FRESH_CHECKS,
          },
          { taskId: target.id, status: "queued" },
        );
      }
      case "retry": {
        const target = task();
        if (busyTask(target) || target.status === "queued")
          throw new Error(
            `Wait for this worker or cancel it before retrying; ${target.title} is ${target.status}.`,
          );
        if (
          run.tasks.some(
            (entry) =>
              entry.dependsOn.includes(target.id) &&
              entry.status !== "queued" &&
              entry.status !== "cancelled",
          )
        )
          throw new Error(
            "A dependent task has already started; create a separate correction task after it finishes",
          );
        if (target.kind === "review")
          throw new Error(
            "A review task has no write scope to correct. Send it a new turn with message, or cancel it.",
          );
        const files = strings(input.files, "files");
        if (!files.length)
          throw new Error(
            "Declare at least one corrected project-relative file/directory scope, or '.' for the whole checkout",
          );
        const current = this.run(run.leadId)!;
        const scopes = await this.store.scopes(
          orchestrationCheckoutCwd(current),
          files,
        );
        return changeTask(
          target.id,
          {
            prompt: text(input.text, "text"),
            files,
            scopes,
            writeScopes: undefined,
            status: "queued",
            accepted: false,
            result: "",
            report: undefined,
            changes: undefined,
            error: undefined,
            recoveryPrompt: undefined,
            delivered: true,
            activeDispatchId: undefined,
            acceptedDispatchId: undefined,
            ...FRESH_CHECKS,
          },
          { taskId: target.id, status: "queued", files },
        );
      }
      case "steer": {
        const target = task();
        if (target.status !== "running")
          throw new Error(
            `Only a running agent can be steered; ${target.title} is ${target.status}. ${
              target.status === "queued"
                ? "It has not started yet, so edit it with message instead."
                : "Send it a fresh turn with message."
            }`,
          );
        const guidance = text(input.text, "text");
        await this.host!.steer(target.sessionId, guidance);
        return record(this.run(run.leadId)!, {
          taskId: target.id,
          steered: true,
        });
      }
      case "cancel":
        await this.cancelTask(run.leadId, task().id);
        return record(this.run(run.leadId)!, { cancelled: true });
      case "respond": {
        const target = task();
        const pending = this.pendingInput(target);
        if (pending?.kind !== "approval")
          throw new Error(
            `${target.title} is not waiting on an approval. Read needsInput from list or wait before responding.`,
          );
        if (input.requestId !== pending.requestId)
          throw new Error(
            `Stale requestId. ${target.title} is waiting on ${pending.requestId}.`,
          );
        const decision = text(input.decision, "decision", 16);
        if (decision !== "allow" && decision !== "deny")
          throw new Error('decision must be "allow" or "deny"');
        this.host!.respondApproval(
          target.sessionId,
          pending.requestId,
          decision,
        );
        return record(this.run(run.leadId)!, {
          taskId: target.id,
          decision,
        });
      }
      case "answer": {
        const target = task();
        const pending = this.pendingInput(target);
        if (pending?.kind !== "question")
          throw new Error(
            `${target.title} is not waiting on a question. Read needsInput from list or wait before answering.`,
          );
        if (input.requestId !== pending.requestId)
          throw new Error(
            `Stale requestId. ${target.title} is waiting on ${pending.requestId}.`,
          );
        const reply: UserQuestionReply =
          input.skip === true
            ? { kind: "skipped" }
            : {
                kind: "answered",
                answers: questionAnswers(input.answers, pending.questions),
              };
        this.host!.answerQuestion(target.sessionId, pending.requestId, reply);
        return record(this.run(run.leadId)!, {
          taskId: target.id,
          answered: reply.kind === "answered",
        });
      }
      case "review": {
        const target = task();
        if (target.status !== "completed")
          throw new Error(
            `Only a completed result can be accepted; ${target.title} is ${target.status}. ${
              ["failed", "blocked", "interrupted"].includes(target.status)
                ? "Send it another turn with message, retry it with corrected scope when necessary, or drop it with cancel."
                : target.status === "checking"
                  ? "MonoCode is running its acceptance checks; end your turn and you are woken with the result."
                  : "Wait for it to finish, or cancel it."
            }`,
          );
        const accepted = await this.acceptTask(run.leadId, target.id);
        return record(this.run(run.leadId)!, { accepted: true, ...accepted });
      }
      case "diff": {
        const target = task();
        const maxBytes = diffBytes(input.maxBytes);
        const started = !!(target.activeDispatchId ?? target.lastDispatchId);
        if (!started)
          throw new Error(
            `${target.title} has not started yet, so it has no changes to diff. End your turn; MonoCode wakes you with its result.`,
          );
        if (target.workspacePolicy !== "shared" && !target.workspace)
          throw new Error(
            activeTask(target)
              ? `${target.title}'s checkout is still being prepared. Try diff again once it is running.`
              : target.accepted
                ? `${target.title} was already accepted and its worktree cleaned up, so its changes are now in the lead checkout. Inspect them there with git diff.`
                : `${target.title}'s isolated checkout is no longer available, so there is no worker diff to read. Use get for its report, or retry the task if its changes are still needed.`,
          );
        let diff: WorkerDiff;
        try {
          diff = await this.host!.workerDiff(
            this.run(run.leadId)!,
            target,
            maxBytes,
          );
        } catch (error) {
          throw new Error(
            `Could not read ${target.title}'s changes: ${messageOf(error)}. Retry diff once its turn has settled, or use get for the files it reported.`,
          );
        }
        return {
          taskId: target.id,
          files: diff.files,
          patch: diff.patch,
          truncated: diff.truncated,
        };
      }
      case "finish": {
        const outstanding = this.run(run.leadId)!.tasks.filter(
          (entry) => entry.status !== "cancelled" && !entry.accepted,
        );
        if (outstanding.length)
          throw new Error(
            `Review all remaining tasks before finishing. Outstanding: ${listed(
              outstanding.map((entry) => `${entry.title} (${entry.status})`),
            )}. Accept a completed task with review, correct a failed or blocked task with message/retry, or drop it with cancel.`,
          );
        const cleanupPending: string[] = [];
        for (const retained of this.run(run.leadId)!.tasks.filter(
          (entry) => entry.workspacePolicy !== "shared" && entry.workspace,
        )) {
          // A reviewer's checkout is never applied to the lead checkout, even
          // once accepted: only an unchanged one is removed.
          if (!retained.accepted || retained.kind === "review") {
            const cleaned = await this.cleanupUnchangedWorker(
              run.leadId,
              retained.id,
            );
            if (!cleaned) cleanupPending.push(retained.workspace!.checkoutCwd);
            continue;
          }
          const dispatchId = retained.acceptedDispatchId;
          const dispatch = this.run(run.leadId)!.dispatches?.find(
            (entry) => entry.id === dispatchId,
          );
          if (dispatch?.stage === "cleaned") continue;
          try {
            const cleaned = await this.host!.cleanupWorker(
              this.run(run.leadId)!,
              retained,
              false,
            );
            if (cleaned) {
              const current = this.run(run.leadId)!;
              await this.commit({
                ...current,
                tasks: current.tasks.map((entry) =>
                  entry.id === retained.id
                    ? { ...entry, workspace: undefined }
                    : entry,
                ),
                dispatches: (current.dispatches ?? []).map((entry) =>
                  entry.id === dispatchId
                    ? {
                        ...entry,
                        stage: "cleaned",
                        cleanupError: undefined,
                        updatedAt: Date.now(),
                      }
                    : entry,
                ),
              });
            } else cleanupPending.push(retained.workspace!.checkoutCwd);
          } catch (error) {
            cleanupPending.push(retained.workspace!.checkoutCwd);
            if (dispatchId)
              await this.patchDispatch(run.leadId, dispatchId, {
                cleanupError: messageOf(error),
              });
          }
        }
        const finished = this.run(run.leadId)!;
        const result = await record(
          { ...finished, status: "finished", ...settleActiveTime(finished) },
          {
            finished: true,
            ...(cleanupPending.length ? { cleanupPending } : {}),
          },
        );
        await this.store.disable(run.leadId);
        return result;
      }
      default:
        throw new Error("Unknown action. Run control --help.");
    }
  }
  private async wait(leadId: string, input: Record<string, unknown>) {
    const run = this.run(leadId);
    if (!run) throw new Error("No orchestration run was found for this lead");
    const seconds = input.timeoutSeconds ?? 20;
    if (
      typeof seconds !== "number" ||
      !Number.isFinite(seconds) ||
      seconds < 0 ||
      seconds > 25
    )
      throw new Error("timeoutSeconds must be 0 to 25");
    // A worker blocking on the lead changes no run state, so watch for that
    // separately; otherwise the lead sleeps while an agent waits on it.
    const blocked = this.blocked.get(leadId);
    // Input that arrived before `wait` is already actionable. Only long-poll
    // while every running worker can still make progress without the lead.
    if (
      run.status === "active" &&
      this.blockedKeys(run).length === 0 &&
      (run.tasks.some(busyTask) ||
        run.tasks.some((task) => task.status === "queued"))
    ) {
      await new Promise<void>((resolve) => {
        const finish = () => {
          clearTimeout(timer);
          unsubscribe();
          resolve();
        };
        const unsubscribe = this.subscribe(() => {
          if (this.run(leadId) !== run || this.blocked.get(leadId) !== blocked)
            finish();
        });
        const timer = setTimeout(finish, seconds * 1000);
      });
    }
    return this.view(this.run(leadId)!);
  }
  private async pump() {
    if (this.pumping) {
      this.pumpAgain = true;
      return;
    }
    if (!this.host) return;
    this.pumping = true;
    try {
      for (const initial of this.runs) {
        const initialRun = this.run(initial.leadId);
        if (!initialRun || initialRun.status !== "active") continue;
        for (const initialTask of initialRun.tasks) {
          const run = this.run(initial.leadId);
          if (
            !run ||
            run.status !== "active" ||
            run.tasks.filter(activeTask).length >= run.maxWorkers
          )
            break;
          const task = run.tasks.find((entry) => entry.id === initialTask.id);
          if (
            !task ||
            task.status !== "queued" ||
            task.dependsOn.some(
              (id) => !run.tasks.find((entry) => entry.id === id)?.accepted,
            ) ||
            // A review reads completed work; it never waits for acceptance.
            task.reviewOf?.some(
              (id) =>
                run.tasks.find((entry) => entry.id === id)?.status !==
                "completed",
            )
          )
            continue;
          // Checking tasks keep their scope although their worker is idle.
          if (
            run.tasks.some(
              (entry) =>
                busyTask(entry) && scopesOverlap(entry.scopes, task.scopes),
            )
          )
            continue;
          if (!this.host.session(run.leadId)) {
            await this.stopRun(run.leadId);
            break;
          }
          const spent = budgetReason(run, true);
          if (spent) {
            await this.pause(run.leadId, budgetPause(spent));
            break;
          }
          const dispatchId = crypto.randomUUID();
          const now = Date.now();
          const dispatch: OrchestrationDispatch = {
            id: dispatchId,
            taskId: task.id,
            sessionId: task.sessionId,
            workspace: orchestrationWorkspace(run),
            state: "starting",
            stage: "accepted",
            startedAt: now,
            updatedAt: now,
          };
          // Persist authority before any external worker/resource operation.
          await this.commit({
            ...run,
            tasks: run.tasks.map((entry) =>
              entry.id === task.id
                ? {
                    ...entry,
                    status: "running",
                    activeDispatchId: dispatchId,
                    acceptedDispatchId: undefined,
                  }
                : entry,
            ),
            dispatches: [...(run.dispatches ?? []), dispatch],
          });
          this.writeChecks.set(dispatchId, new Set());
          try {
            if (
              !this.host
                .choices()
                .some(
                  (choice) =>
                    choice.harness === task.harness &&
                    choice.models.some((model) => model.id === task.model),
                )
            )
              throw new Error(
                "The assigned harness/model is no longer available. Review this task before retrying.",
              );
            const activeRun = this.run(run.leadId)!;
            const activeTask = activeRun.tasks.find(
              (entry) => entry.id === task.id,
            )!;
            const prepared = await this.host.createWorker(
              activeRun,
              activeTask,
            );
            if (
              this.run(run.leadId)?.status !== "active" ||
              this.run(run.leadId)?.tasks.find((entry) => entry.id === task.id)
                ?.status !== "running"
            )
              continue;
            const preparedRun = this.run(run.leadId)!;
            const writeScopes = task.files.length
              ? await this.store.scopes(
                  prepared.workspace.checkoutCwd,
                  task.files,
                )
              : [];
            await this.commit({
              ...preparedRun,
              tasks: preparedRun.tasks.map((entry) =>
                entry.id === task.id
                  ? {
                      ...entry,
                      workspace: prepared.workspace,
                      scratchDir: prepared.scratchDir,
                      writeScopes,
                    }
                  : entry,
              ),
              dispatches: (preparedRun.dispatches ?? []).map((entry) =>
                entry.id === dispatchId
                  ? {
                      ...entry,
                      workspace: prepared.workspace,
                      stage: "session_prepared",
                      updatedAt: Date.now(),
                    }
                  : entry,
              ),
            });
            if (
              this.run(run.leadId)?.status !== "active" ||
              this.run(run.leadId)?.tasks.find((entry) => entry.id === task.id)
                ?.status !== "running"
            )
              continue;
            // A reviewer's first turn carries the reviewed patches, read now
            // so they reflect each task's latest completed turn.
            const body =
              task.recoveryPrompt ??
              (task.kind === "review"
                ? await this.reviewPrompt(run.leadId, task.id)
                : task.prompt);
            if (
              this.run(run.leadId)?.status !== "active" ||
              this.run(run.leadId)?.tasks.find((entry) => entry.id === task.id)
                ?.activeDispatchId !== dispatchId
            )
              continue;
            const prompt = workerTurnPrompt(
              body,
              task.files,
              prepared.scratchDir,
              preparedRun.brief,
            );
            this.host.submit(task.sessionId, prompt, (outcome) => {
              void this.settle(run.leadId, task.id, outcome, dispatchId).catch(
                console.error,
              );
            });
            const submitted = this.run(run.leadId)!;
            const submittedAt = Date.now();
            await this.commit({
              ...submitted,
              tasks: submitted.tasks.map((entry) =>
                entry.id === task.id
                  ? {
                      ...entry,
                      turns: (entry.turns ?? 0) + 1,
                      startedAt: entry.startedAt ?? submittedAt,
                    }
                  : entry,
              ),
              dispatches: (submitted.dispatches ?? []).map((entry) =>
                entry.id === dispatchId &&
                submitted.tasks.some(
                  (item) =>
                    item.id === task.id && item.activeDispatchId === dispatchId,
                )
                  ? {
                      ...entry,
                      state: "running",
                      stage: "turn_submitted",
                      updatedAt: submittedAt,
                    }
                  : entry,
              ),
            });
          } catch (error) {
            await this.settle(
              run.leadId,
              task.id,
              {
                status: "failed",
                text: "",
                error: messageOf(error),
              },
              dispatchId,
            );
          }
        }
      }
    } catch (error) {
      console.error("Orchestration dispatch failed", error);
    } finally {
      this.pumping = false;
      if (this.pumpAgain) {
        this.pumpAgain = false;
        void this.pump();
      }
    }
  }
  private async settle(
    leadId: string,
    taskId: string,
    outcome: ControlOutcome,
    dispatchId: string,
  ) {
    let task = this.run(leadId)?.tasks.find((entry) => entry.id === taskId);
    if (!task || task.activeDispatchId !== dispatchId) return;
    const { storedResultChars } = orchestrationLimits(this.run(leadId)!);
    const parsed = parseWorkerReport(outcome.text);
    if (task?.status === "cancelling") {
      if (outcome.text)
        await this.patchTask(leadId, taskId, {
          result: parsed.text.slice(-storedResultChars),
        });
      return;
    }
    if (task.status !== "running") return;
    const changes = await this.readChanges(leadId, task);
    // A fast final response must not make an unchecked write reviewable.
    await Promise.all(this.writeChecks.get(dispatchId) ?? []);
    task = this.run(leadId)?.tasks.find((entry) => entry.id === taskId);
    if (
      !task ||
      task.status !== "running" ||
      task.activeDispatchId !== dispatchId
    )
      return;
    this.writeChecks.delete(dispatchId);
    const run = this.run(leadId)!;
    const now = Date.now();
    // The turn itself is settled either way; a worker that says it is
    // blocked goes straight to the lead instead of into automatic fixes.
    const checkRunId =
      outcome.status === "completed" &&
      task.checks?.length &&
      parsed.report?.status !== "blocked"
        ? crypto.randomUUID()
        : undefined;
    const usage = turnTokens(this.host?.session(task.sessionId), task);
    await this.commit({
      ...run,
      tasks: run.tasks.map((entry) =>
        entry.id === taskId
          ? {
              ...entry,
              ...turnEnded(run, entry, now),
              ...usage,
              status: checkRunId ? "checking" : outcome.status,
              result: parsed.text.slice(-storedResultChars),
              report: parsed.report,
              changes,
              error: outcome.error,
              recoveryPrompt: undefined,
              delivered: !!checkRunId,
              accepted: false,
              activeDispatchId: undefined,
              lastDispatchId: dispatchId,
              checkRunId,
              checkResults: undefined,
            }
          : entry,
      ),
      dispatches: (run.dispatches ?? []).map((dispatch) =>
        dispatch.id === dispatchId
          ? {
              ...dispatch,
              state: outcome.status,
              stage: "settled",
              updatedAt: now,
              result: parsed.text.slice(-storedResultChars),
              error: outcome.error,
            }
          : dispatch,
      ),
    });
    if (outcome.status === "failed")
      await this.cleanupUnchangedWorker(leadId, taskId);
    const spent = budgetReason(this.run(leadId)!, false);
    if (spent) await this.pause(leadId, budgetPause(spent));
    if (checkRunId)
      void this.runChecks(leadId, taskId, checkRunId).catch(console.error);
    void this.pump();
    this.sync();
  }
  /**
   * Run a task's acceptance checks in order, in its retained checkout. Every
   * step re-reads the task: a cancel, stop, pause or newer check run voids
   * this one, and its late results are dropped.
   */
  private async runChecks(leadId: string, taskId: string, checkRunId: string) {
    const current = () => {
      const task = this.run(leadId)?.tasks.find((entry) => entry.id === taskId);
      return task?.status === "checking" && task.checkRunId === checkRunId
        ? task
        : undefined;
    };
    const results: CheckResult[] = [];
    let hostError: string | undefined;
    for (const command of current()?.checks ?? []) {
      const task = current();
      const run = this.run(leadId);
      if (!task || !run || !this.host) return;
      try {
        const outcome = await this.host.runCheck(run, task, command);
        results.push({
          command,
          passed: outcome.exitCode === 0 && !outcome.timedOut,
          exitCode: outcome.exitCode,
          timedOut: outcome.timedOut,
          durationMs: outcome.durationMs,
          outputTail: outcome.output.slice(-CHECK_OUTPUT_CHARS),
        });
      } catch (error) {
        hostError = messageOf(error);
        results.push({
          command,
          passed: false,
          exitCode: null,
          timedOut: false,
          durationMs: 0,
          outputTail: `MonoCode could not run this check: ${hostError}`,
        });
      }
      // Show progress while later checks run.
      if (!current()) return;
      await this.patchTask(leadId, taskId, { checkResults: [...results] });
      if (hostError) break;
    }
    const task = current();
    const run = this.run(leadId);
    if (!task || !run) return;
    const failed = results.filter((check) => !check.passed);
    const retries = task.checkRetries ?? 0;
    const { maxCheckRetries } = orchestrationLimits(run);
    // The worker can fix its own failures; it cannot fix the app being
    // unable to run a command, so that goes to the lead.
    if (failed.length && !hostError && retries < maxCheckRetries) {
      await this.commit({
        ...run,
        tasks: run.tasks.map((entry) =>
          entry.id === taskId
            ? {
                ...entry,
                status: "queued",
                checkRunId: undefined,
                checkResults: results,
                checkRetries: retries + 1,
                recoveryPrompt: checkFixTurn(
                  failed,
                  retries + 1,
                  maxCheckRetries,
                ),
                delivered: true,
                error: undefined,
              }
            : entry,
        ),
      });
      void this.pump();
      return;
    }
    const autoAccept =
      !!run.autoAccept &&
      results.length > 0 &&
      !failed.length &&
      (task.report?.status ?? "done") === "done";
    await this.commit({
      ...run,
      tasks: run.tasks.map((entry) =>
        entry.id === taskId
          ? {
              ...entry,
              status: "completed",
              checkRunId: undefined,
              checkResults: results,
              // Held back while auto-accept runs, so the lead hears the outcome.
              delivered: autoAccept,
              error: hostError
                ? `Its acceptance checks could not run: ${hostError}. Inspect the command and the worker checkout, then review the task yourself.`
                : entry.error,
            }
          : entry,
      ),
    });
    if (autoAccept) await this.autoAccept(leadId, taskId);
    void this.pump();
    this.sync();
  }
  /**
   * The review path for a task whose checks passed in an autoAccept run,
   * serialized with the lead's own commands. A failure leaves the task
   * completed for the lead, with the reason in its next wake-up.
   */
  private async autoAccept(leadId: string, taskId: string) {
    const attempt = this.actions
      .catch(() => undefined)
      .then(async () => {
        const run = this.run(leadId);
        const task = run?.tasks.find((entry) => entry.id === taskId);
        if (run?.status !== "active" || task?.status !== "completed") return;
        if (task.accepted) return;
        try {
          await this.acceptTask(leadId, taskId);
          await this.patchTask(leadId, taskId, {
            autoAccepted: true,
            autoAcceptError: undefined,
          });
        } catch (error) {
          await this.patchTask(leadId, taskId, {
            autoAcceptError: messageOf(error),
          });
        }
      });
    this.actions = attempt.catch(() => undefined);
    try {
      await attempt;
    } finally {
      const task = this.run(leadId)?.tasks.find(
        (entry) => entry.id === taskId,
      );
      if (task?.status === "completed" && task.delivered)
        await this.patchTask(leadId, taskId, { delivered: false });
    }
  }
  /**
   * Accept a completed task: integrate an isolated worker's changes into the
   * lead checkout and remove its worktree. A review task changed nothing, so
   * accepting it only records it and removes its checkout if still unchanged.
   */
  private async acceptTask(
    leadId: string,
    taskId: string,
  ): Promise<{
    integrated: boolean;
    cleaned: boolean;
    cleanupError?: string;
    merged?: string[];
  }> {
    let target = this.run(leadId)!.tasks.find((entry) => entry.id === taskId)!;
    const dispatchId = target.lastDispatchId;
    if (!dispatchId)
      throw new Error("This task has no completed dispatch to review");
    if (target.kind === "review") {
      if (!target.accepted) {
        const current = this.run(leadId)!;
        await this.commit({
          ...current,
          tasks: current.tasks.map((entry) =>
            entry.id === taskId
              ? { ...entry, accepted: true, acceptedDispatchId: dispatchId }
              : entry,
          ),
        });
      }
      return {
        integrated: false,
        cleaned: await this.cleanupUnchangedWorker(leadId, taskId),
      };
    }
    const isolated = target.workspacePolicy !== "shared";
    let merged: string[] | undefined;
    if (!target.accepted) {
      if (isolated) {
        if (!target.workspace)
          throw new Error(
            "This worker's isolated checkout is unavailable. Its changes were not accepted.",
          );
        await this.patchDispatch(leadId, dispatchId, {
          stage: "integration_started",
          cleanupError: undefined,
        });
        const applied = await this.host!.integrateWorker(
          this.run(leadId)!,
          target,
        );
        merged = applied?.merged;
      }
      const current = this.run(leadId)!;
      await this.commit({
        ...current,
        tasks: current.tasks.map((entry) =>
          entry.id === taskId
            ? {
                ...entry,
                accepted: true,
                acceptedDispatchId: dispatchId,
              }
            : entry,
        ),
        dispatches: (current.dispatches ?? []).map((dispatch) =>
          dispatch.id === dispatchId
            ? {
                ...dispatch,
                stage: isolated ? "integrated" : dispatch.stage,
                updatedAt: Date.now(),
              }
            : dispatch,
        ),
      });
      target = this.run(leadId)!.tasks.find((entry) => entry.id === taskId)!;
    }

    let cleaned = !isolated;
    let cleanupError: string | undefined;
    if (isolated) {
      try {
        cleaned = await this.host!.cleanupWorker(
          this.run(leadId)!,
          target,
          false,
        );
      } catch (error) {
        cleanupError = messageOf(error);
      }
      const current = this.run(leadId)!;
      await this.commit({
        ...current,
        tasks: current.tasks.map((entry) =>
          entry.id === taskId && cleaned
            ? { ...entry, workspace: undefined }
            : entry,
        ),
        dispatches: (current.dispatches ?? []).map((dispatch) =>
          dispatch.id === dispatchId
            ? {
                ...dispatch,
                ...(cleaned ? { stage: "cleaned" as const } : {}),
                cleanupError,
                updatedAt: Date.now(),
              }
            : dispatch,
        ),
      });
    }
    return {
      integrated: isolated,
      cleaned,
      ...(cleanupError ? { cleanupError } : {}),
      ...(merged?.length ? { merged } : {}),
    };
  }
  /**
   * First turn of a review task: the reviewed tasks' instructions, reports
   * and patches, inside one byte budget split evenly between them.
   */
  private async reviewPrompt(leadId: string, taskId: string): Promise<string> {
    const run = this.run(leadId)!;
    const task = run.tasks.find((entry) => entry.id === taskId)!;
    const { leadResultChars } = orchestrationLimits(run);
    const targets = (task.reviewOf ?? []).flatMap((id) => {
      const target = run.tasks.find((entry) => entry.id === id);
      return target ? [target] : [];
    });
    const share = Math.max(
      DIFF_BYTES.min,
      Math.floor(REVIEW_PATCH_BYTES / Math.max(1, targets.length)),
    );
    const lead = orchestrationCheckoutCwd(run);
    const sections = await Promise.all(
      targets.map(async (target) => {
        let patch: string;
        if (target.workspacePolicy !== "shared" && !target.workspace)
          patch = target.accepted
            ? `Patch unavailable: this task was already accepted into the lead checkout at ${JSON.stringify(lead)}. Read its changed files there, without editing them.`
            : "Patch unavailable: this task's checkout no longer exists. Review its report and say so in your verdict.";
        else
          try {
            const diff = await this.host!.workerDiff(run, target, share);
            const where = target.workspace?.checkoutCwd ?? lead;
            patch = `${diff.patch.trimEnd() || "(empty patch)"}${
              diff.truncated
                ? `\n[Patch truncated at ${share} bytes. Read the remaining changed files in ${JSON.stringify(where)} without editing them.]`
                : ""
            }`;
          } catch (error) {
            patch = `Patch unavailable: ${messageOf(error)}.`;
          }
        return `<reviewed_task id="${target.id}">\nTitle: ${target.title}\n\nOriginal instructions:\n${target.prompt}\n\nResult:\n${leadResultText(target, leadResultChars)}\n\nPatch:\n${patch}\n</reviewed_task>`;
      }),
    );
    return `${task.prompt}\n\nYou are reviewing the work of ${targets.length === 1 ? "another worker" : "other workers"} for the lead. Each section below holds a task's original instructions, its result and the patch of its uncommitted changes, which live in its own checkout. Check correctness, fidelity to the instructions and their file scope, missing or weak tests, and risky side effects. You may read any project file for context and run read-only commands, but never edit, create or delete files. Name each finding with its file and line, most important first.\n\nYour <monocode_result> is your verdict on every reviewed task: status "done" approves them as they are; "partial" or "blocked" requests changes, with each required change in blockers and optional suggestions in followUps. Leave changedFiles empty.\n\n${sections.join("\n\n")}`;
  }
  /**
   * Files a finished turn actually changed. Best-effort: settling must never
   * depend on reading the checkpoint, so any failure records no changes.
   */
  private async readChanges(
    leadId: string,
    task: OrchestrationTask,
  ): Promise<WorkerChange[] | undefined> {
    const run = this.run(leadId);
    if (!run || !this.host?.workerChanges) return undefined;
    if (task.workspacePolicy !== "shared" && !task.workspace) return undefined;
    try {
      const changes = await this.host.workerChanges(run, task);
      if (!Array.isArray(changes)) return undefined;
      return changes
        .slice(0, MAX_RECORDED_CHANGES)
        .map(({ relative, status, additions, deletions }) => ({
          relative,
          status,
          additions,
          deletions,
        }));
    } catch (error) {
      console.warn("Could not read the worker's changed files", error);
      return undefined;
    }
  }
  async cancelTask(leadId: string, taskId: string) {
    const task = this.run(leadId)?.tasks.find((entry) => entry.id === taskId);
    if (!task || task.status === "cancelled") return;
    const dispatchId = task.activeDispatchId;
    if (activeTask(task)) {
      await this.patchTask(leadId, taskId, {
        status: "cancelling",
      });
      await this.host!.stop(task.sessionId);
    }
    const run = this.run(leadId);
    if (!run) return;
    await this.commit({
      ...run,
      tasks: run.tasks.map((entry) =>
        entry.id === taskId
          ? {
              ...entry,
              ...turnEnded(run, entry),
              status: "cancelled",
              accepted: false,
              delivered: false,
              activeDispatchId: undefined,
              recoveryPrompt: undefined,
              checkRunId: undefined,
              recheck: undefined,
              ...(dispatchId ? { lastDispatchId: dispatchId } : {}),
            }
          : entry,
      ),
      dispatches: (run.dispatches ?? []).map((dispatch) =>
        dispatch.id === dispatchId
          ? {
              ...dispatch,
              state: "cancelled",
              stage: "settled",
              updatedAt: Date.now(),
            }
          : dispatch,
      ),
    });
    if (dispatchId) this.writeChecks.delete(dispatchId);
    await this.cleanupUnchangedWorker(leadId, taskId);
    void this.pump();
  }
  private async interruptTask(leadId: string, taskId: string, reason: string) {
    const task = this.run(leadId)?.tasks.find((entry) => entry.id === taskId);
    if (!task || task.status !== "running") return;
    const dispatchId = task.activeDispatchId;
    await this.patchTask(leadId, taskId, {
      status: "cancelling",
      error: reason,
    });
    await this.host!.stop(task.sessionId);
    const run = this.run(leadId);
    if (!run) return;
    await this.commit({
      ...run,
      tasks: run.tasks.map((entry) =>
        entry.id === taskId
          ? {
              ...entry,
              ...turnEnded(run, entry),
              status: "interrupted",
              accepted: false,
              delivered: true,
              activeDispatchId: undefined,
              error: reason,
              recoveryPrompt: recoveryTurn(reason),
              ...(dispatchId ? { lastDispatchId: dispatchId } : {}),
            }
          : entry,
      ),
      dispatches: (run.dispatches ?? []).map((dispatch) =>
        dispatch.id === dispatchId
          ? {
              ...dispatch,
              state: "interrupted",
              stage: "settled",
              updatedAt: Date.now(),
              error: reason,
            }
          : dispatch,
      ),
    });
    if (dispatchId) this.writeChecks.delete(dispatchId);
  }
  private async blockTask(leadId: string, taskId: string, reason: string) {
    const task = this.run(leadId)?.tasks.find((entry) => entry.id === taskId);
    if (!task || task.status !== "running") return;
    const dispatchId = task.activeDispatchId;
    await this.patchTask(leadId, taskId, {
      status: "cancelling",
      error: reason,
    });
    await this.host!.stop(task.sessionId);
    const run = this.run(leadId);
    if (!run) return;
    await this.commit({
      ...run,
      tasks: run.tasks.map((entry) =>
        entry.id === taskId
          ? {
              ...entry,
              ...turnEnded(run, entry),
              status: "blocked",
              accepted: false,
              delivered: false,
              activeDispatchId: undefined,
              error: reason,
              recoveryPrompt: undefined,
              ...(dispatchId ? { lastDispatchId: dispatchId } : {}),
            }
          : entry,
      ),
      dispatches: (run.dispatches ?? []).map((dispatch) =>
        dispatch.id === dispatchId
          ? {
              ...dispatch,
              state: "blocked",
              stage: "settled",
              updatedAt: Date.now(),
              error: reason,
            }
          : dispatch,
      ),
    });
    if (dispatchId) this.writeChecks.delete(dispatchId);
    void this.pump();
    this.sync();
  }
  /**
   * A paused run has no supervisor, so its agents stop with it. Leaving them
   * editing with nobody reviewing is how a run quietly diverges from what the
   * user approved. Their worktrees are retained. Queued work is left alone: `pump`
   * will not dispatch while paused, so it resumes intact.
   */
  private async pause(
    leadId: string,
    error: string,
    patch?: (run: OrchestrationRun) => OrchestrationRun,
  ) {
    const run = this.run(leadId);
    if (!run || run.status !== "active") return;
    this.clearWake(leadId);
    const paused = patch ? patch(run) : run;
    // Checks hold no worker process, so they stop at once and run again on Resume.
    await this.commit({
      ...paused,
      ...settleActiveTime(run),
      status: "paused",
      error,
      lastPauseReason: error,
      tasks: paused.tasks.map((task) =>
        task.status === "checking" ? checksInterrupted(task, error) : task,
      ),
    });
    // Serialize state transitions: parallel commits here can resurrect an
    // already-stopped worker from an older snapshot.
    for (const task of this.run(leadId)!.tasks.filter(
      (entry) => entry.status === "running",
    ))
      await this.interruptTask(leadId, task.id, error);
  }
  async stopRun(leadId: string) {
    const run = this.run(leadId);
    if (!run) return;
    this.clearWake(leadId);
    let saveError: unknown;
    await this.commit({
      ...run,
      ...settleActiveTime(run),
      status: "stopped",
    }).catch((error: unknown) => {
      saveError = error;
    });
    await Promise.all(
      [
        leadId,
        ...run.tasks.filter(activeTask).map((task) => task.sessionId),
      ].map((id) => this.host?.stop(id)),
    );
    const latest = this.run(leadId)!;
    const stopped: OrchestrationRun = {
      ...latest,
      status: "stopped",
      tasks: latest.tasks.map((task) =>
        busyTask(task) || task.status === "queued"
          ? {
              ...task,
              ...turnEnded(latest, task),
              status: "cancelled",
              accepted: false,
              delivered: true,
              activeDispatchId: undefined,
              checkRunId: undefined,
              ...(task.activeDispatchId
                ? { lastDispatchId: task.activeDispatchId }
                : {}),
            }
          : task,
      ),
      dispatches: (latest.dispatches ?? []).map((dispatch) =>
        latest.tasks.some(
          (task) => task.activeDispatchId === dispatch.id && activeTask(task),
        )
          ? {
              ...dispatch,
              state: "cancelled",
              stage: "settled",
              updatedAt: Date.now(),
            }
          : dispatch,
      ),
    };
    for (const task of latest.tasks) {
      if (task.activeDispatchId) this.writeChecks.delete(task.activeDispatchId);
    }
    await this.commit(stopped).catch((error: unknown) => {
      saveError = error;
    });
    if (!saveError) {
      for (const task of stopped.tasks.filter((entry) => !entry.accepted))
        await this.cleanupUnchangedWorker(leadId, task.id);
    }
    const afterCleanup = this.run(leadId) ?? stopped;
    this.runs = this.runs.map((entry) =>
      entry.leadId === leadId
        ? {
            ...afterCleanup,
            error: saveError
              ? `Run stopped; could not save history: ${messageOf(saveError)}`
              : afterCleanup.error,
          }
        : entry,
    );
    this.emit();
    await this.store.disable(leadId);
  }
  stopForSession(id: string): Promise<void> | null {
    const run = this.forSession(id);
    if (
      !run ||
      (run.status !== "active" &&
        run.status !== "paused" &&
        !run.tasks.some(busyTask))
    )
      return null;
    if (run.leadId === id) return this.stopRun(id);
    const task = run.tasks.find((entry) => entry.sessionId === id)!;
    return this.cancelTask(run.leadId, task.id);
  }
  /** Drain control writes before the database removes a lead or one of its workers. */
  deleteSession(id: string, remove: () => Promise<void>): Promise<void> {
    const result = this.actions
      .catch(() => undefined)
      .then(async () => {
        const run = this.forSession(id);
        if (
          run &&
          (run.status === "active" ||
            run.status === "paused" ||
            run.tasks.some(busyTask))
        ) {
          await this.stopRun(run.leadId);
        }
        await this.saves.catch(() => undefined);
        await remove();
        this.deleted.add(id);
        if (!run) return;
        this.runs = this.runs.filter((entry) => entry.leadId !== run.leadId);
        this.persisted.delete(run.leadId);
        this.blocked.delete(run.leadId);
        this.announced.delete(run.leadId);
        this.clearWake(run.leadId);
        this.emit();
        if (run.leadId !== id) {
          // Read the transaction's pruned graph; never save the pre-delete snapshot.
          const updated = await this.store.load(run.leadId).catch((error) => {
            console.error(
              "Could not reload orchestration after deletion",
              error,
            );
            this.loaded.delete(run.leadId);
            return null;
          });
          if (updated) {
            const normalized = normalizeOrchestrationRun(updated);
            this.runs = [...this.runs, normalized];
            this.persisted.set(run.leadId, normalized);
            this.emit();
          }
        }
      });
    this.actions = result.catch(() => undefined);
    return result;
  }
  /** `${taskId}:${requestId}` for every worker currently blocked on the lead. */
  private blockedKeys(run: OrchestrationRun): string[] {
    return run.tasks.flatMap((task) => {
      const pending = this.pendingInput(task);
      return pending ? [`${task.id}:${pending.requestId}`] : [];
    });
  }
  sync() {
    for (const run of this.runs) {
      if (run.status !== "active") continue;
      // A blocked worker changes no run state, so `wait` needs telling.
      const keys = this.blockedKeys(run).join(",");
      if (this.blocked.get(run.leadId) !== keys) {
        this.blocked.set(run.leadId, keys);
        this.emit();
      }
    }
    const now = Date.now();
    for (const run of this.runs) {
      if (run.status !== "active") {
        this.clearWake(run.leadId);
        continue;
      }
      if (this.waking.has(run.leadId)) continue;
      const announced = this.announced.get(run.leadId) ?? new Set<string>();
      const results = run.tasks.filter(deliverable);
      const blocked = this.blockedKeys(run).filter(
        (key) => !announced.has(key),
      );
      if (!results.length && !blocked.length) {
        this.clearWake(run.leadId);
        continue;
      }
      const since = this.pendingSince.get(run.leadId) ?? now;
      this.pendingSince.set(run.leadId, since);
      // Never interrupt the lead or queued user input: the sync that follows
      // its turn schedules the wake-up, already due if the window has passed.
      const lead = this.host?.session(run.leadId);
      if (!lead || lead.busy || lead.queuedMessages?.length) continue;
      // Completions landing close together share one continuation turn. A
      // worker blocked on the lead cannot progress, so it is never batched.
      this.scheduleWake(
        run.leadId,
        blocked.length ? now : since + orchestrationLimits(run).wakeBatchMs,
      );
    }
  }
  /** Keep the earliest due wake-up; a later event never postpones it. */
  private scheduleWake(leadId: string, due: number) {
    const pending = this.wakeTimers.get(leadId);
    if (pending && pending.due <= due) return;
    if (pending) clearTimeout(pending.timer);
    const timer = setTimeout(
      () => {
        this.wakeTimers.delete(leadId);
        void this.wake(leadId);
      },
      Math.max(0, due - Date.now()),
    );
    this.wakeTimers.set(leadId, { timer, due });
  }
  private clearWake(leadId: string) {
    const pending = this.wakeTimers.get(leadId);
    if (pending) clearTimeout(pending.timer);
    this.wakeTimers.delete(leadId);
    this.pendingSince.delete(leadId);
  }
  /** Deliver every pending result and request to an idle lead in one turn. */
  private async wake(leadId: string) {
    if (this.waking.has(leadId)) return;
    this.waking.add(leadId);
    try {
      const current = this.run(leadId);
      const session = this.host?.session(leadId);
      if (
        !current ||
        current.status !== "active" ||
        !session ||
        session.busy ||
        session.queuedMessages?.length
      )
        return;
      const results = current.tasks.filter(deliverable);
      const seen = this.announced.get(leadId) ?? new Set<string>();
      const waiting = current.tasks.flatMap((task) => {
        const pending = this.pendingInput(task);
        const key = pending && `${task.id}:${pending.requestId}`;
        return key && !seen.has(key) ? [{ task, pending, key }] : [];
      });
      if (!results.length && !waiting.length) return;
      const limits = orchestrationLimits(current);
      if (current.continuations >= limits.maxContinuations) {
        await this.pause(
          leadId,
          "Automatic continuation limit reached. Its agents were stopped; review and resume the run.",
        );
        return;
      }
      this.pendingSince.delete(leadId);
      await this.commit({
        ...current,
        continuations: current.continuations + 1,
        lastPauseReason: undefined,
        tasks: current.tasks.map((task) =>
          results.some((item) => item.id === task.id)
            ? { ...task, delivered: true }
            : task,
        ),
      });
      this.announced.set(
        leadId,
        new Set([...seen, ...waiting.map((entry) => entry.key)]),
      );
      // Work first, each with the verdicts already given on it; then the
      // reviews themselves, whose findings say what to change.
      const summary = [
        ...results.filter((task) => task.kind !== "review"),
        ...results.filter((task) => task.kind === "review"),
      ]
        .map((task) => {
          const verdicts = (reviewsOf(current, task) ?? [])
            .filter((review) => review.verdict)
            .map(
              (review) =>
                `Review ${review.taskId} — ${review.title}: ${review.verdict}`,
            );
          return [leadResultText(task, limits.leadResultChars), ...verdicts].join(
            "\n",
          );
        })
        .join("\n\n");
      const usage = `Run usage: ${orchestrationUsageText(orchestrationUsage(current))}${
        current.budget
          ? `; budget ${[
              current.budget.maxMinutes
                ? `${current.budget.maxMinutes} minutes`
                : "",
              current.budget.maxWorkerTurns
                ? `${current.budget.maxWorkerTurns} worker turns`
                : "",
            ]
              .filter(Boolean)
              .join(", ")}`
          : ""
      }.`;
      const asks = waiting
        .map(
          ({ task, pending }) =>
            `${task.id} — ${task.title} needs ${pending.kind === "approval" ? "an approval" : "an answer"} (requestId ${pending.requestId}): ${pending.label}\n${pending.detail?.slice(0, 2000) ?? ""}${
              pending.questions ? `\n${JSON.stringify(pending.questions)}` : ""
            }`,
        )
        .join("\n\n");
      const body = [
        current.lastPauseReason
          ? `Previous interruption: ${current.lastPauseReason}\nInterrupted workers were continued from their retained checkouts. Inspect their results normally before review. Policy-blocked tasks were not restarted; correct or explicitly re-scope those tasks before retrying them. Dependent validation remains queued until its prerequisites pass review.`
          : "",
        results.length
          ? `Worker results are ready. Inspect each patch with diff, request corrections through the CLI when needed, accept finished work with review, and finish the original task. If other workers are still running, end your turn when you are done here; MonoCode wakes you with their results.\n\n${summary}`
          : "",
        waiting.length
          ? `These agents are blocked waiting on you. Decide each one with respond or answer; they stay stopped until you do. Judge it against the task you assigned, and ask the user in this conversation only when the call is genuinely theirs to make.\n\n${asks}`
          : "",
        usage,
      ]
        .filter(Boolean)
        .join("\n\n");
      this.host!.submit(leadId, body, (outcome) => {
        if (outcome.status !== "completed") {
          void this.pause(
            leadId,
            outcome.error ??
              "Lead continuation was interrupted. Its agents were stopped; review and resume.",
            (current) => ({
              ...current,
              tasks: current.tasks.map((task) =>
                results.some((item) => item.id === task.id)
                  ? { ...task, delivered: false }
                  : task,
              ),
            }),
          ).catch(console.error);
        } else this.sync();
      });
    } catch (error) {
      console.error("Orchestration continuation failed", error);
    } finally {
      this.waking.delete(leadId);
    }
  }
  observe(id: string, event: HarnessEvent) {
    if (event.type !== "tool.started" && event.type !== "tool.updated") return;
    const run = this.forSession(id);
    const task = run?.tasks.find(
      (entry) => entry.sessionId === id && entry.status === "running",
    );
    if (
      !run ||
      run.status !== "active" ||
      !task ||
      event.preview?.kind !== "write" ||
      ["failed", "error", "cancelled"].includes(event.status ?? "")
    )
      return;
    const paths =
      event.paths ?? (event.preview.path ? [event.preview.path] : []);
    const dispatchId = task.activeDispatchId;
    if (!dispatchId) return;
    const stillRunning = () =>
      this.run(run.leadId)?.status === "active" &&
      this.run(run.leadId)?.tasks.some(
        (entry) =>
          entry.id === task.id &&
          entry.status === "running" &&
          entry.activeDispatchId === dispatchId,
      );
    const checks = this.writeChecks.get(dispatchId);
    const check = (async () => {
      for (const path of paths) {
        const absolute = /^(?:[\\/]|[a-z]:[\\/])/i.test(path)
          ? path
          : `${task.workspace?.checkoutCwd ?? orchestrationCheckoutCwd(run)}/${path}`;
        let resolved: string;
        try {
          resolved = await this.store.resolvePath(absolute);
        } catch (error) {
          if (stillRunning())
            await this.blockTask(
              run.leadId,
              task.id,
              `Could not verify ${task.title}'s reported write to ${path}: ${messageOf(error)}. Only this worker was stopped and its checkout was retained. Inspect the path, then retry it with an explicit project-relative scope or cancel it.`,
            );
          return;
        }
        if (!stillRunning()) return;
        const normalized = orchestrationPathKey(resolved);
        if (
          [
            ...(task.writeScopes ?? task.scopes),
            ...(task.scratchDir ? [task.scratchDir] : []),
          ].some((scope) =>
            scopeContains(orchestrationPathKey(scope), normalized),
          )
        )
          continue;
        await this.blockTask(
          run.leadId,
          task.id,
          `${task.title} reported a write outside its assignment: ${path}. Only this worker was stopped and its checkout was retained; other independent work continues. Inspect the reported path. Retry with corrected project-relative files only if the write is genuinely required, otherwise send a correction within the existing scope or cancel the task.`,
        );
        return;
      }
    })().catch(console.error);
    checks?.add(check);
    void check.finally(() => checks?.delete(check));
  }
}

export const orchestrator = new Orchestrator();
