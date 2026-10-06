import {
  validateOrchestrationBudget,
  type OrchestrationBudget,
  type OrchestrationLimits,
} from "./orchestrationLimits";
import {
  MAX_ORCHESTRATION_BRIEF,
  validateOrchestrationBrief,
  validateOrchestrationSettings,
  validateProposedTasks,
  validateTaskChecks,
  validateTaskKind,
  type OrchestrationProposal,
  type ProposedTask,
} from "./orchestrationPlan";
import type { TaskKind } from "./orchestrationState";

/**
 * Pure helpers behind the proposal card. Validation runs the same validators
 * `startApproved` runs, so the card blocks exactly what starting would reject.
 */
export type ProposalCardErrors = {
  brief?: string;
  budget?: string;
  /** Errors that belong to one assignment, by proposal task id. */
  tasks: Record<string, string>;
  /** Anything else the start would reject, such as a dependency cycle. */
  general?: string;
};

const messageOf = (error: unknown) =>
  error instanceof Error ? error.message : String(error);

/** Brief length the card shows against the limit, as the model counts it. */
export const briefLength = (brief: string | undefined) =>
  brief?.trim().length ?? 0;
export { MAX_ORCHESTRATION_BRIEF };

export function proposalCardErrors(
  proposal: Pick<
    OrchestrationProposal,
    "brief" | "tasks" | "settings" | "cwd" | "checkoutCwd"
  >,
  limits: OrchestrationLimits,
): ProposalCardErrors {
  const errors: ProposalCardErrors = { tasks: {} };
  try {
    validateOrchestrationBrief(proposal.brief);
  } catch (error) {
    errors.brief = messageOf(error);
  }
  try {
    validateOrchestrationBudget(proposal.settings.budget);
  } catch (error) {
    errors.budget = messageOf(error);
  }
  for (const task of proposal.tasks) {
    try {
      validateTaskKind(task.kind, "This task");
      validateTaskChecks(task.checks, "This task's");
    } catch (error) {
      errors.tasks[task.id] = messageOf(error);
    }
  }
  if (Object.keys(errors.tasks).length) return errors;
  try {
    const settings = validateOrchestrationSettings(
      { ...proposal.settings, budget: undefined },
      limits,
    );
    validateProposedTasks(
      proposal.tasks,
      settings,
      proposal.checkoutCwd ?? proposal.cwd,
      limits,
    );
  } catch (error) {
    const message = messageOf(error);
    // Model messages quote the assignment id; pin those to their row.
    const owner = proposal.tasks.find((task) =>
      message.includes(`"${task.id}"`),
    );
    if (owner) errors.tasks[owner.id] = message;
    else errors.general = message;
  }
  return errors;
}

export const cardHasErrors = (errors: ProposalCardErrors) =>
  !!errors.brief ||
  !!errors.budget ||
  !!errors.general ||
  Object.keys(errors.tasks).length > 0;

/** Auto-accept can only act on tasks the app runs checks for. */
export const proposalHasChecks = (proposal: Pick<OrchestrationProposal, "tasks">) =>
  proposal.tasks.some(
    (task) => task.kind !== "review" && !!task.checks?.length,
  );

/** What the card shows and starts with: off whenever nothing has checks. */
export const effectiveAutoAccept = (
  proposal: Pick<OrchestrationProposal, "tasks" | "settings">,
) => !!proposal.settings.autoAccept && proposalHasChecks(proposal);

/** Work tasks a review task may read: every other non-review assignment. */
export const reviewCandidates = (
  proposal: Pick<OrchestrationProposal, "tasks">,
  taskId: string,
) =>
  proposal.tasks.filter((task) => task.id !== taskId && task.kind !== "review");

/**
 * Switch an assignment's kind. A reviewer owns no files and carries no checks;
 * returning to work restores `previousFiles` (or the whole project) so the
 * task stays valid instead of silently losing its scope.
 */
export function withTaskKind(
  task: ProposedTask,
  kind: TaskKind,
  proposal: Pick<OrchestrationProposal, "tasks">,
  previousFiles?: string[],
): ProposedTask {
  if (kind === "review") {
    if (task.kind === "review") return task;
    const first = reviewCandidates(proposal, task.id)[0];
    const review: ProposedTask = {
      ...task,
      kind: "review",
      files: [],
      reviewOf: first ? [first.id] : [],
    };
    delete review.checks;
    return review;
  }
  if (task.kind !== "review") return task;
  const work: ProposedTask = {
    ...task,
    files: previousFiles?.length ? previousFiles : ["."],
  };
  delete work.kind;
  delete work.reviewOf;
  return work;
}

/** Changing a task's kind can leave other reviewers pointing at a reviewer. */
export function withoutReviewsOf(
  tasks: ProposedTask[],
  reviewerId: string,
): ProposedTask[] {
  return tasks.map((task) =>
    task.reviewOf?.includes(reviewerId)
      ? { ...task, reviewOf: task.reviewOf.filter((id) => id !== reviewerId) }
      : task,
  );
}

/**
 * A budget field as typed: blank clears the cap; anything else is kept as a
 * number (possibly invalid) so validation can say what is wrong with it.
 */
export function budgetField(
  budget: OrchestrationBudget | undefined,
  key: keyof OrchestrationBudget,
  text: string,
): OrchestrationBudget | undefined {
  const next = { ...budget };
  const trimmed = text.trim();
  if (!trimmed) delete next[key];
  else next[key] = Number(trimmed);
  return Object.keys(next).length ? next : undefined;
}

/**
 * Quick mode starts a proposal on its own only when it is small, has no
 * review step and passes the same validation a click would.
 */
export function quickModeStarts(
  proposal: OrchestrationProposal,
  preferences: { quickMode: boolean; limits: OrchestrationLimits },
): boolean {
  if (!preferences.quickMode || proposal.status !== "ready") return false;
  if (!proposal.tasks.length || proposal.tasks.length > 2) return false;
  if (proposal.tasks.some((task) => task.kind === "review")) return false;
  return !cardHasErrors(proposalCardErrors(proposal, preferences.limits));
}
