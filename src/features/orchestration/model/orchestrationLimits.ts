/**
 * Caps that bound one orchestration run. They are stored on the run so a
 * resumed run keeps the limits it was approved with; runs saved before limits
 * existed load with the defaults, which match the previous fixed values.
 */
export type OrchestrationLimits = {
  /** Highest parallel worker count a run may select. */
  maxWorkers: number;
  /** Assignments one run may hold, including later delegations. */
  maxTasks: number;
  /** Control commands with retry receipts (mutations) per run. */
  maxCommands: number;
  /** Automatic lead wake-ups before the run pauses for the user. */
  maxContinuations: number;
  /** Tail of each worker's final message kept in run history. */
  storedResultChars: number;
  /** Tail of a worker's text sent to the lead when it gave no structured report. */
  leadResultChars: number;
  /** Window that coalesces several worker completions into one lead wake-up. */
  wakeBatchMs: number;
  /** Longest one acceptance check may run before it is killed and fails. */
  checkTimeoutMs: number;
  /** Automatic fix turns a worker gets for failing checks before the lead decides. */
  maxCheckRetries: number;
};

export const DEFAULT_ORCHESTRATION_LIMITS: Readonly<OrchestrationLimits> =
  Object.freeze({
    maxWorkers: 4,
    maxTasks: 40,
    maxCommands: 512,
    maxContinuations: 20,
    storedResultChars: 20_000,
    leadResultChars: 4000,
    wakeBatchMs: 2000,
    checkTimeoutMs: 600_000,
    maxCheckRetries: 2,
  });

/** Inclusive range each limit may be configured within. */
export const ORCHESTRATION_LIMIT_RANGES: Readonly<
  Record<keyof OrchestrationLimits, readonly [number, number]>
> = Object.freeze({
  maxWorkers: [1, 8],
  maxTasks: [1, 100],
  maxCommands: [16, 2048],
  maxContinuations: [1, 100],
  storedResultChars: [1000, 100_000],
  leadResultChars: [200, 20_000],
  wakeBatchMs: [0, 30_000],
  checkTimeoutMs: [10_000, 3_600_000],
  maxCheckRetries: [0, 5],
});

/**
 * Complete a partial or persisted limits object. Missing or non-numeric values
 * take their default, so a malformed history can never disable a cap.
 */
export function resolveOrchestrationLimits(
  value?: Partial<OrchestrationLimits> | null,
): OrchestrationLimits {
  const limits = { ...DEFAULT_ORCHESTRATION_LIMITS };
  for (const key of Object.keys(limits) as (keyof OrchestrationLimits)[]) {
    const raw = value?.[key];
    if (typeof raw !== "number" || !Number.isFinite(raw)) continue;
    const [min, max] = ORCHESTRATION_LIMIT_RANGES[key];
    limits[key] = Math.min(max, Math.max(min, Math.round(raw)));
  }
  return limits;
}

/**
 * Optional user budget for one run. Reaching either cap pauses the run; Resume
 * grants the same allowance again from that point.
 */
export type OrchestrationBudget = {
  /** Wall-clock minutes the run may stay active. */
  maxMinutes?: number;
  /** Worker turns the run may dispatch, including automatic check fixes. */
  maxWorkerTurns?: number;
};

/** Inclusive range each budget cap may be set within. */
export const ORCHESTRATION_BUDGET_RANGES: Readonly<
  Record<keyof OrchestrationBudget, readonly [number, number]>
> = Object.freeze({
  maxMinutes: [1, 24 * 60],
  maxWorkerTurns: [1, 1000],
});

/**
 * Validate a budget from the start options. Absent caps mean unlimited; an
 * invalid cap fails loudly rather than silently running without it.
 */
export function validateOrchestrationBudget(
  value: unknown,
): OrchestrationBudget | undefined {
  if (value == null) return undefined;
  if (typeof value !== "object" || Array.isArray(value))
    throw new Error("The run budget must be an object of caps, or omitted");
  const input = value as Record<string, unknown>;
  const budget: OrchestrationBudget = {};
  for (const key of Object.keys(input)) {
    if (!(key in ORCHESTRATION_BUDGET_RANGES))
      throw new Error(
        `Unknown run budget field "${key}". Use maxMinutes or maxWorkerTurns.`,
      );
    const raw = input[key];
    if (raw == null) continue;
    const [min, max] =
      ORCHESTRATION_BUDGET_RANGES[key as keyof OrchestrationBudget];
    if (
      typeof raw !== "number" ||
      !Number.isInteger(raw) ||
      raw < min ||
      raw > max
    )
      throw new Error(`Set ${key} to a whole number from ${min} to ${max}`);
    budget[key as keyof OrchestrationBudget] = raw;
  }
  return Object.keys(budget).length ? budget : undefined;
}

/** Parallelism choices a proposal card offers under the given limits. */
export const parallelWorkerOptions = (
  limits: Pick<
    OrchestrationLimits,
    "maxWorkers"
  > = DEFAULT_ORCHESTRATION_LIMITS,
) => Array.from({ length: limits.maxWorkers }, (_, index) => index + 1);
