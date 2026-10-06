import { describe, expect, it } from "vitest";
import {
  budgetField,
  cardHasErrors,
  effectiveAutoAccept,
  proposalCardErrors,
  quickModeStarts,
  reviewCandidates,
  withTaskKind,
  withoutReviewsOf,
} from "./orchestrationCard";
import { resolveOrchestrationLimits } from "./orchestrationLimits";
import {
  proposalMarkdown,
  validateOrchestrationSettings,
  type OrchestrationProposal,
  type ProposedTask,
} from "./orchestrationPlan";

const limits = resolveOrchestrationLimits();
const work = (id: string, patch: Partial<ProposedTask> = {}): ProposedTask => ({
  id,
  title: `Task ${id}`,
  prompt: "Do it",
  harness: "codex",
  model: "codex:test",
  files: [`src/${id}`],
  dependsOn: [],
  ...patch,
});
const proposal = (
  tasks: ProposedTask[],
  patch: Partial<OrchestrationProposal> = {},
): OrchestrationProposal => ({
  version: 1,
  leadId: "lead",
  cwd: "/repo",
  request: "Build",
  author: { harness: "codex", model: "codex:test", name: "Lead" },
  settings: {
    choices: [{ harness: "codex", model: "codex:test", name: "Worker" }],
    maxWorkers: 2,
  },
  status: "ready",
  title: "Plan",
  summary: "",
  tasks,
  ...patch,
});

describe("proposal card validation", () => {
  it("accepts a valid card", () => {
    const errors = proposalCardErrors(proposal([work("a")]), limits);
    expect(errors).toEqual({ tasks: {} });
    expect(cardHasErrors(errors)).toBe(false);
  });

  it("pins check errors to their task with the model's message", () => {
    const errors = proposalCardErrors(
      proposal([
        work("a", { checks: ["npm test", " "] }),
        work("b", { checks: Array.from({ length: 6 }, (_, i) => `c${i}`) }),
      ]),
      limits,
    );
    expect(errors.tasks.a).toContain("non-empty command");
    expect(errors.tasks.b).toContain("at most 5");
    expect(cardHasErrors(errors)).toBe(true);
  });

  it("pins graph errors that name an assignment, and keeps the rest general", () => {
    const review = work("r", { kind: "review", files: [], reviewOf: [] });
    expect(proposalCardErrors(proposal([work("a"), review]), limits).tasks.r).toContain(
      "needs reviewOf",
    );
    const cycle = proposalCardErrors(
      proposal([work("a", { dependsOn: ["b"] }), work("b", { dependsOn: ["a"] })]),
      limits,
    );
    expect(cycle.general).toContain("cycle");
  });

  it("checks the brief and budget like starting does", () => {
    const errors = proposalCardErrors(
      proposal([work("a")], {
        brief: "x".repeat(8001),
        settings: {
          ...proposal([]).settings,
          budget: { maxMinutes: 0 },
        },
      }),
      limits,
    );
    expect(errors.brief).toContain("under 8000");
    expect(errors.budget).toContain("maxMinutes");
  });

  it("validates parallelism against the configured limit", () => {
    const wide = proposal([work("a")], {
      settings: { ...proposal([]).settings, maxWorkers: 6 },
    });
    expect(proposalCardErrors(wide, limits).general).toContain("1 to 4");
    expect(
      cardHasErrors(
        proposalCardErrors(wide, resolveOrchestrationLimits({ maxWorkers: 8 })),
      ),
    ).toBe(false);
  });
});

describe("proposal card edits", () => {
  it("turns a task into a reviewer and back without losing its scope", () => {
    const plan = proposal([work("a"), work("b", { checks: ["npm test"] })]);
    const reviewer = withTaskKind(plan.tasks[1], "review", plan);
    expect(reviewer).toMatchObject({ kind: "review", files: [], reviewOf: ["a"] });
    expect(reviewer.checks).toBeUndefined();
    expect(
      cardHasErrors(proposalCardErrors({ ...plan, tasks: [plan.tasks[0], reviewer] }, limits)),
    ).toBe(false);
    const back = withTaskKind(reviewer, "work", plan, ["src/b"]);
    expect(back.files).toEqual(["src/b"]);
    expect(back.kind).toBeUndefined();
    expect(back.reviewOf).toBeUndefined();
    expect(withTaskKind(reviewer, "work", plan).files).toEqual(["."]);
  });

  it("offers only other work tasks to review, and unlinks a demoted reviewer", () => {
    const plan = proposal([
      work("a"),
      work("r", { kind: "review", files: [], reviewOf: ["a"] }),
      work("s", { kind: "review", files: [], reviewOf: ["a", "r"] }),
    ]);
    expect(reviewCandidates(plan, "s").map((task) => task.id)).toEqual(["a"]);
    expect(withoutReviewsOf(plan.tasks, "r")[2].reviewOf).toEqual(["a"]);
  });

  it("keeps typed budget values for validation and clears blank ones", () => {
    expect(budgetField(undefined, "maxMinutes", "30")).toEqual({ maxMinutes: 30 });
    expect(budgetField({ maxMinutes: 30 }, "maxMinutes", " ")).toBeUndefined();
    expect(budgetField({ maxMinutes: 30 }, "maxWorkerTurns", "1.5")).toEqual({
      maxMinutes: 30,
      maxWorkerTurns: 1.5,
    });
    expect(validateOrchestrationSettings({
      ...proposal([]).settings,
      budget: { maxMinutes: 30 },
    }).budget).toEqual({ maxMinutes: 30 });
  });

  it("shows auto-accept on only when some task has checks", () => {
    const on = { ...proposal([]).settings, autoAccept: true };
    expect(effectiveAutoAccept(proposal([work("a")], { settings: on }))).toBe(false);
    expect(
      effectiveAutoAccept(proposal([work("a", { checks: ["npm test"] })], { settings: on })),
    ).toBe(true);
  });

  it("writes the brief, checks, reviewers and run settings into the readable plan", () => {
    const text = proposalMarkdown(
      proposal(
        [
          work("a", { checks: ["npm test"] }),
          work("r", { title: "Check A", kind: "review", files: [], reviewOf: ["a"] }),
        ],
        {
          brief: "Shared notes",
          settings: {
            ...proposal([]).settings,
            autoAccept: true,
            budget: { maxMinutes: 30 },
          },
        },
      ),
    );
    expect(text).toContain("## Brief\nShared notes");
    expect(text).toContain("Checks: npm test");
    expect(text).toContain("## Review: Check A");
    expect(text).toContain("Reviews: Task a");
    expect(text).toContain("Auto-accept tasks whose checks pass");
    expect(text).toContain("Budget: 30 minutes");
  });
});

describe("quick mode", () => {
  const on = { quickMode: true, limits };
  it("starts a small, valid plan without reviewers", () => {
    expect(quickModeStarts(proposal([work("a"), work("b")]), on)).toBe(true);
  });
  it("never starts when off, large, reviewed, invalid or not ready", () => {
    const small = proposal([work("a")]);
    expect(quickModeStarts(small, { ...on, quickMode: false })).toBe(false);
    expect(quickModeStarts(proposal([work("a"), work("b"), work("c")]), on)).toBe(false);
    expect(
      quickModeStarts(
        proposal([work("a"), work("r", { kind: "review", files: [], reviewOf: ["a"] })]),
        on,
      ),
    ).toBe(false);
    expect(quickModeStarts(proposal([work("a", { checks: [""] })]), on)).toBe(false);
    expect(quickModeStarts({ ...small, status: "invalid" }, on)).toBe(false);
    expect(quickModeStarts(proposal([]), on)).toBe(false);
  });
});
