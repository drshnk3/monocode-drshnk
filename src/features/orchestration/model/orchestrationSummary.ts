import type { OrchestrationRun, TaskStatus } from "./orchestration";
import { sessionNeedsInput, type HarnessId, type Session } from "../../sessions/model/session";
import { formatTokens } from "../../sessions/model/contextUsage";
import { runElapsedMs } from "./orchestrationState";

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
