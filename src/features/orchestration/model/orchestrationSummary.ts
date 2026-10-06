import type { OrchestrationRun, TaskStatus } from "./orchestration";
import { sessionNeedsInput, type HarnessId, type Session } from "../../sessions/model/session";
import { formatTokens } from "../../sessions/model/contextUsage";
import {
  runElapsedMs,
  type CheckResult,
  type OrchestrationTask,
} from "./orchestrationState";
import { reviewVerdict } from "./orchestrationReport";

/** Small history projection; never includes prompts, results or credentials. */
export type OrchestrationSummary = {
  status: OrchestrationRun["status"];
  live?: boolean;
  tasks: {
    sessionId: string;
    title: string;
    harness: HarnessId;
    model: string;
    status: TaskStatus;
    needsInput?: boolean;
  }[];
};

export function summarizeOrchestration(
  run: OrchestrationRun,
  sessions: readonly Session[],
): OrchestrationSummary {
  const byId = new Map(sessions.map((session) => [session.id, session]));
  return {
    status: run.status,
    live: true,
    tasks: run.tasks.map(({ sessionId, title, harness, model, status }) => ({
      sessionId,
      title,
      harness,
      model,
      status,
      needsInput:
        !!byId.get(sessionId) && sessionNeedsInput(byId.get(sessionId)!),
    })),
  };
}

export function orchestrationTaskLabel(
  task: OrchestrationSummary["tasks"][number],
  summary: OrchestrationSummary,
): string {
  if (task.needsInput) return "Needs input";
  if (
    !summary.live &&
    ["running", "cancelling", "checking", "queued"].includes(task.status)
  )
    return "Saved";
  if (summary.status === "paused" && task.status === "queued") return "Paused";
  return {
    queued: "Queued",
    running: "Working",
    cancelling: "Stopping",
    checking: "Checking",
    completed: "Done",
    failed: "Failed",
    blocked: "Needs review",
    interrupted: "Interrupted",
    cancelled: "Cancelled",
  }[task.status];
}

/** Run totals derived from its tasks; tokens only when a provider reported them. */
export type OrchestrationUsage = {
  /** Wall-clock time the run has been active. */
  elapsedMs: number;
  /** Summed worker turn time; parallel workers add up. */
  workerMs: number;
  workerTurns: number;
  tokens?: { input: number; output: number };
};

export function orchestrationUsage(
  run: OrchestrationRun,
  now = Date.now(),
): OrchestrationUsage {
  let workerMs = 0;
  let workerTurns = 0;
  let tokens: OrchestrationUsage["tokens"];
  for (const task of run.tasks) {
    workerMs += task.activeMs ?? 0;
    workerTurns += task.turns ?? 0;
    if (task.tokens)
      tokens = {
        input: (tokens?.input ?? 0) + task.tokens.input,
        output: (tokens?.output ?? 0) + task.tokens.output,
      };
  }
  return {
    elapsedMs: runElapsedMs(run, now),
    workerMs,
    workerTurns,
    ...(tokens ? { tokens } : {}),
  };
}

/** "1h 5m", "12m", "40s". */
export function formatDuration(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

/** A task still in progress: a worker turn, its stop, or its checks. */
export const activeTaskStatus = (status: TaskStatus) =>
  status === "running" || status === "cancelling" || status === "checking";

export type TaskTone = "attention" | "active" | "done" | "idle";

/** Colour family of a task's status label, shared by the sidebar surfaces. */
export function orchestrationTaskTone(
  task: OrchestrationSummary["tasks"][number],
  summary: Pick<OrchestrationSummary, "live">,
): TaskTone {
  if (
    task.needsInput ||
    task.status === "failed" ||
    task.status === "blocked" ||
    task.status === "interrupted"
  )
    return "attention";
  if (summary.live && activeTaskStatus(task.status)) return "active";
  if (task.status === "completed") return "done";
  return "idle";
}

export type CheckSummary = {
  passed: number;
  total: number;
  failing: CheckResult[];
  label: string;
};

/** "2/3 checks passed", with the failing results for a closer look. */
export function checkSummary(
  results: CheckResult[] | undefined,
): CheckSummary | undefined {
  if (!results?.length) return undefined;
  const failing = results.filter((check) => !check.passed);
  const passed = results.length - failing.length;
  return {
    passed,
    total: results.length,
    failing,
    label: failing.length
      ? `${passed}/${results.length} checks passed`
      : `${results.length === 1 ? "Check" : "Checks"} passed`,
  };
}

const plural = (count: number, word: string) =>
  `${count} ${word}${count === 1 ? "" : "s"}`;

/** "4m · 3 turns · 12k tokens", or undefined before the first turn. */
export function taskUsageText(
  task: Pick<OrchestrationTask, "activeMs" | "turns" | "tokens">,
): string | undefined {
  if (!task.turns) return undefined;
  return [
    formatDuration(task.activeMs ?? 0),
    plural(task.turns, "turn"),
    task.tokens
      ? `${formatTokens(task.tokens.input + task.tokens.output)} tokens`
      : "",
  ]
    .filter(Boolean)
    .join(" · ");
}

/** Run totals for the sidebar; undefined until a worker has taken a turn. */
export function runUsageLine(
  run: OrchestrationRun,
  now = Date.now(),
): string | undefined {
  const usage = orchestrationUsage(run, now);
  if (!usage.workerTurns) return undefined;
  return [
    `${formatDuration(usage.elapsedMs)} elapsed`,
    plural(usage.workerTurns, "worker turn"),
    usage.tokens
      ? `${formatTokens(usage.tokens.input + usage.tokens.output)} tokens`
      : "",
  ]
    .filter(Boolean)
    .join(" · ");
}

/** Review tasks that read `taskId`, with their verdicts once they finish. */
export function taskReviews(run: OrchestrationRun, taskId: string) {
  return run.tasks
    .filter(
      (entry) => entry.kind === "review" && entry.reviewOf?.includes(taskId),
    )
    .map((entry) => ({
      sessionId: entry.sessionId,
      title: entry.title,
      verdict: reviewVerdict(entry),
    }));
}

const BUDGET_PAUSE = "Run budget reached: ";

/** What ran out, when the run is paused on its budget. */
export function budgetPauseDetail(
  run: Pick<OrchestrationRun, "status" | "error">,
): string | undefined {
  if (run.status !== "paused" || !run.error?.startsWith(BUDGET_PAUSE))
    return undefined;
  return run.error.slice(BUDGET_PAUSE.length).split(".")[0];
}

/** One line for lead wake-ups. */
export function orchestrationUsageText(usage: OrchestrationUsage): string {
  return [
    `${formatDuration(usage.elapsedMs)} elapsed`,
    `${usage.workerTurns} worker turn${usage.workerTurns === 1 ? "" : "s"}`,
    `${formatDuration(usage.workerMs)} worker time`,
    usage.tokens
      ? `${formatTokens(usage.tokens.input)} input / ${formatTokens(usage.tokens.output)} output tokens`
      : "",
  ]
    .filter(Boolean)
    .join(", ");
}
