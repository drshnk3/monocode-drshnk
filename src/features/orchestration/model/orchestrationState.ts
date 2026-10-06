import { pathKey } from "../../../shared/lib/paths";
import type { OrchestrationChoice } from "./orchestrationPlan";
import type { HarnessId } from "../../sessions/model/session";
import {
  resolveOrchestrationLimits,
  type OrchestrationBudget,
  type OrchestrationLimits,
} from "./orchestrationLimits";

/**
 * `checking`: the worker's turn finished and the app is running its acceptance
 * checks. The worker process is idle, but the task still owns its scope and is
 * not yet a result the lead can review.
 */
export type TaskStatus =
  | "queued"
  | "running"
  | "cancelling"
  | "checking"
  | "completed"
  | "failed"
  | "blocked"
  | "interrupted"
  | "cancelled";

export type WorkspacePolicy =
  "shared" | "isolated-child" | "isolated-top-level";

export type OrchestrationWorkspace = {
  /** Stable comparison identity; not a display path. */
  id: string;
  /** Project identity used by recents, history and project-level settings. */
  projectCwd: string;
  /** Concrete checkout in which this run may read and write. */
  checkoutCwd: string;
  kind: "main" | "worktree";
  branch?: string;
};

export type DispatchState =
  | "starting"
  | "running"
  | "completed"
  | "failed"
  | "blocked"
  | "interrupted"
  | "cancelled"
  | "start_unknown"
  | "stop_unknown";

export type DispatchStage =
  | "accepted"
  | "session_prepared"
  | "turn_submitted"
  | "settled"
  | "integration_started"
  | "integrated"
  | "cleaned";

export type OrchestrationDispatch = {
  id: string;
  taskId: string;
  sessionId: string;
  workspace: OrchestrationWorkspace;
  state: DispatchState;
  stage: DispatchStage;
  startedAt: number;
  updatedAt: number;
  result?: string;
  error?: string;
  cleanupError?: string;
};

/** One focused check a worker says it ran. */
export type WorkerCheck = {
  command: string;
  passed: boolean;
  note?: string;
};

/** Structured summary a worker appends to its final message. */
export type WorkerReport = {
  status: "done" | "partial" | "blocked";
  summary: string;
  changedFiles: string[];
  checks: WorkerCheck[];
  blockers: string[];
  followUps?: string[];
};

/** A file the worker's session actually changed, from its checkpoint. */
export type WorkerChange = {
  relative: string;
  status: string;
  additions: number;
  deletions: number;
};

/** One acceptance check the app ran in the worker's checkout. */
export type CheckResult = {
  command: string;
  passed: boolean;
  /** Null when the process was killed (timeout), signalled or never started. */
  exitCode: number | null;
  timedOut: boolean;
  durationMs: number;
  /** End of the combined output, capped at `CHECK_OUTPUT_CHARS`. */
  outputTail: string;
};

/** Output kept per check result. */
export const CHECK_OUTPUT_CHARS = 4000;
/** Acceptance checks one task may carry, and the longest command. */
export const MAX_TASK_CHECKS = 5;
export const MAX_CHECK_COMMAND = 500;

export type TaskKind = "work" | "review";

export type OrchestrationTask = {
  id: string;
  assignmentId?: string;
  sessionId: string;
  /** Absent means "work". A review task reads `reviewOf` and never writes. */
  kind?: TaskKind;
  /** Tasks a review task inspects; it runs once each of them has completed. */
  reviewOf?: string[];
  title: string;
  harness: HarnessId;
  model: string;
  modelSettings?: Record<string, string>;
  prompt: string;
  files: string[];
  /** Logical scopes in the lead checkout, used for scheduling overlap. */
  scopes: string[];
  /** The same scopes resolved inside this worker's isolated checkout. */
  writeScopes?: string[];
  scratchDir?: string;
  dependsOn: string[];
  status: TaskStatus;
  accepted: boolean;
  /** Human-readable tail of the final message, without its report block. */
  result: string;
  /** Parsed `<monocode_result>` of the last turn, when the worker gave one. */
  report?: WorkerReport;
  /** Files the last turn actually changed; absent when they could not be read. */
  changes?: WorkerChange[];
  error?: string;
  /** A retained worker can continue safely with this recovery turn. */
  recoveryPrompt?: string;
  delivered: boolean;
  /** Workspace selection is independent from task/dependency identity. */
  workspacePolicy?: WorkspacePolicy;
  /** A retry reuses its worker checkout so partial work is never orphaned. */
  workspace?: OrchestrationWorkspace;
  /** Only this dispatch may settle the task. A retry always gets a new id. */
  activeDispatchId?: string;
  lastDispatchId?: string;
  acceptedDispatchId?: string;
  /** Commands the app runs in the worker's checkout after each successful turn. */
  checks?: string[];
  /** Results of the latest check run; replaced by every new run. */
  checkResults?: CheckResult[];
  /** Automatic fix turns sent for failing checks since the lead's last instruction. */
  checkRetries?: number;
  /** Only this check run may record results; a newer run or a cancel voids it. */
  checkRunId?: string;
  /** Checks were interrupted: Resume re-runs them instead of a worker turn. */
  recheck?: boolean;
  /** The app accepted this task because its checks passed in an autoAccept run. */
  autoAccepted?: boolean;
  /** Why automatic acceptance failed; the lead decides instead. */
  autoAcceptError?: string;
  /** First and latest worker turn boundaries, epoch ms. */
  startedAt?: number;
  finishedAt?: number;
  /** Summed duration of this task's worker turns. */
  activeMs?: number;
  /** Worker turns dispatched, including automatic check fixes. */
  turns?: number;
  /** Provider-reported tokens summed over the turns that reported them. */
  tokens?: { input: number; output: number };
  /** Transcript turn whose token metrics were last counted, to never count twice. */
  usageBlockId?: string;
};

export type OrchestrationRun = {
  /** Version 1 remains readable; every committed snapshot is migrated to 2. */
  version: 1 | 2;
  leadId: string;
  /** Legacy project identity. Use workspace.checkoutCwd for filesystem work. */
  cwd: string;
  workspace?: OrchestrationWorkspace;
  canonicalRoot?: string;
  status: "active" | "paused" | "stopped" | "finished";
  allowedHarnesses: HarnessId[];
  allowedModels?: OrchestrationChoice[];
  proposalId?: string;
  /** Shared context from planning, sent ahead of every worker prompt. */
  brief?: string;
  maxWorkers: number;
  /** Absent in runs saved before limits existed; read via `orchestrationLimits`. */
  limits?: OrchestrationLimits;
  cli: string;
  tasks: OrchestrationTask[];
  dispatches?: OrchestrationDispatch[];
  error?: string;
  continuations: number;
  lastPauseReason?: string;
  requests: Record<string, { signature: string; result: unknown }>;
  /** Accept a completed task automatically once all of its checks pass. */
  autoAccept?: boolean;
  budget?: OrchestrationBudget;
  /** Usage at the last Resume after the budget ran out; the budget counts from here. */
  budgetBaseline?: { elapsedMs: number; workerTurns: number };
  /** Active run time accumulated before `activeSince`. */
  activeMs?: number;
  /** When the run last became active; absent while inactive. */
  activeSince?: number;
};

/** In-progress and not yet a result: a live worker turn or its checks. */
export const busyTask = (task: OrchestrationTask) =>
  task.status === "running" ||
  task.status === "cancelling" ||
  task.status === "checking";

/** Wall-clock time the run has spent active. */
export const runElapsedMs = (run: OrchestrationRun, now = Date.now()) =>
  (run.activeMs ?? 0) +
  (run.status === "active" && run.activeSince
    ? Math.max(0, now - run.activeSince)
    : 0);

/** Fold the current active stretch into `activeMs`, for a run leaving "active". */
export const settleActiveTime = (
  run: OrchestrationRun,
  now = Date.now(),
): Pick<OrchestrationRun, "activeMs" | "activeSince"> => ({
  activeMs: runElapsedMs(run, now),
  activeSince: undefined,
});

export function workspaceIdentity(
  projectCwd: string,
  checkoutCwd: string,
  branch?: string,
): OrchestrationWorkspace {
  return {
    id: `checkout:${pathKey(checkoutCwd)}`,
    projectCwd,
    checkoutCwd,
    kind: pathKey(projectCwd) === pathKey(checkoutCwd) ? "main" : "worktree",
    ...(branch ? { branch } : {}),
  };
}

export function orchestrationWorkspace(
  run: OrchestrationRun,
): OrchestrationWorkspace {
  return run.workspace ?? workspaceIdentity(run.cwd, run.cwd);
}

export const orchestrationProjectCwd = (run: OrchestrationRun) =>
  orchestrationWorkspace(run).projectCwd;

export const orchestrationCheckoutCwd = (run: OrchestrationRun) =>
  orchestrationWorkspace(run).checkoutCwd;

export const orchestrationLimits = (run: OrchestrationRun) =>
  resolveOrchestrationLimits(run.limits);

export function normalizeOrchestrationRun(
  run: OrchestrationRun,
): OrchestrationRun {
  const workspace = orchestrationWorkspace(run);
  // Older builds implemented every worker scope violation as a global pause
  // and copied the pause reason onto every running task as a generic failure.
  // Preserve the actual offender for review, but recover the collateral tasks
  // as resumable interruptions. The exact shared error is the durable marker
  // that distinguishes these tasks from ordinary worker failures.
  const legacyPauseError = run.status === "paused" ? run.error : undefined;
  const escaped =
    legacyPauseError &&
    run.tasks.find((task) =>
      legacyPauseError.startsWith(
        `${task.title} reported a write outside its assignment:`,
      ),
    )?.id;
  const tasks = run.tasks.map((task) => {
    const legacyInterrupted =
      !!legacyPauseError &&
      task.status === "failed" &&
      task.error === legacyPauseError;
    return {
      ...task,
      ...(legacyInterrupted
        ? {
            status:
              task.id === escaped
                ? ("blocked" as const)
                : ("interrupted" as const),
            delivered: task.id === escaped ? false : true,
          }
        : {}),
      // Version 1 predates per-worker worktrees and must retain its original
      // shared-checkout behavior. New version 2 tasks default to isolation.
      workspacePolicy:
        task.workspacePolicy ??
        (run.version === 1 ? "shared" : "isolated-child"),
    };
  });
  const statusByDispatch = new Map(
    tasks.flatMap((task) =>
      task.lastDispatchId &&
      // Interrupted checks ran after their dispatch had already completed.
      (task.status === "blocked" ||
        (task.status === "interrupted" && !task.recheck))
        ? [[task.lastDispatchId, task.status] as const]
        : [],
    ),
  );
  return {
    ...run,
    version: 2,
    cwd: workspace.projectCwd,
    workspace,
    limits: resolveOrchestrationLimits(run.limits),
    tasks,
    dispatches: (run.dispatches ?? []).map((dispatch) => ({
      ...dispatch,
      state: statusByDispatch.get(dispatch.id) ?? dispatch.state,
    })),
  };
}
