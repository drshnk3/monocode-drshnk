import { describe, expect, it } from "vitest";
import {
  budgetPauseDetail,
  checkSummary,
  orchestrationTaskLabel,
  orchestrationTaskTone,
  runUsageLine,
  taskReviews,
  taskUsageText,
  type OrchestrationSummary,
} from "./orchestrationSummary";
import type {
  CheckResult,
  OrchestrationRun,
  OrchestrationTask,
} from "./orchestrationState";

const row = (
  status: OrchestrationSummary["tasks"][number]["status"],
  needsInput = false,
) => ({
  sessionId: "s",
  title: "Task",
  harness: "codex" as const,
  model: "m",
  status,
  needsInput,
});
const check = (command: string, passed: boolean): CheckResult => ({
  command,
  passed,
  exitCode: passed ? 0 : 1,
  timedOut: false,
  durationMs: 1000,
  outputTail: passed ? "" : "boom",
});
const task = (patch: Partial<OrchestrationTask>): OrchestrationTask => ({
  id: "t",
  sessionId: "s",
  title: "Task",
  harness: "codex",
  model: "m",
  prompt: "p",
  files: [],
  scopes: [],
  dependsOn: [],
  status: "completed",
  accepted: false,
  result: "",
  delivered: true,
  ...patch,
});
const run = (tasks: OrchestrationTask[], patch: Partial<OrchestrationRun> = {}) =>
  ({
    version: 2,
    leadId: "lead",
    cwd: "/repo",
    status: "active",
    allowedHarnesses: ["codex"],
    maxWorkers: 2,
    cli: "",
    tasks,
    continuations: 0,
    requests: {},
    activeMs: 125_000,
    ...patch,
  }) as OrchestrationRun;

describe("sidebar labels", () => {
  it("labels and colours checking as active work", () => {
    const live = { status: "active" as const, live: true, tasks: [] };
    expect(orchestrationTaskLabel(row("checking"), live)).toBe("Checking");
    expect(orchestrationTaskTone(row("checking"), live)).toBe("active");
    expect(orchestrationTaskTone(row("running"), live)).toBe("active");
    expect(orchestrationTaskTone(row("running", true), live)).toBe("attention");
    expect(orchestrationTaskTone(row("completed"), live)).toBe("done");
    expect(orchestrationTaskTone(row("queued"), live)).toBe("idle");
    // A saved run is not working, whatever its last status was.
    expect(orchestrationTaskTone(row("checking"), { live: false })).toBe("idle");
  });

  it("summarizes checks with the failing commands", () => {
    expect(checkSummary(undefined)).toBeUndefined();
    expect(checkSummary([check("a", true)])?.label).toBe("Check passed");
    const mixed = checkSummary([check("a", true), check("b", false), check("c", true)])!;
    expect(mixed.label).toBe("2/3 checks passed");
    expect(mixed.failing.map((entry) => entry.command)).toEqual(["b"]);
  });

  it("formats per-task and run usage only once work has happened", () => {
    expect(taskUsageText({})).toBeUndefined();
    expect(
      taskUsageText({ activeMs: 240_000, turns: 3, tokens: { input: 10_000, output: 2000 } }),
    ).toBe("4m · 3 turns · 12K tokens");
    expect(taskUsageText({ activeMs: 5000, turns: 1 })).toBe("5s · 1 turn");
    expect(runUsageLine(run([task({})]))).toBeUndefined();
    expect(
      runUsageLine(run([task({ turns: 2 }), task({ turns: 1, tokens: { input: 500, output: 500 } })]), 0),
    ).toMatch(/^2m elapsed · 3 worker turns · 1(\.0)?K tokens$/);
  });

  it("lists verdicts of the reviews that read a task", () => {
    const reviewed = run([
      task({ id: "a" }),
      task({
        id: "r",
        sessionId: "rs",
        title: "Review A",
        kind: "review",
        reviewOf: ["a"],
        report: { status: "done", summary: "ok", changedFiles: [], checks: [], blockers: [] },
      }),
      task({ id: "q", kind: "review", reviewOf: ["a"], status: "running" }),
    ]);
    expect(taskReviews(reviewed, "a")).toEqual([
      { sessionId: "rs", title: "Review A", verdict: "approved" },
      { sessionId: "s", title: "Task", verdict: undefined },
    ]);
    expect(taskReviews(reviewed, "r")).toEqual([]);
  });

  it("reads a budget pause from the run's error", () => {
    expect(
      budgetPauseDetail({
        status: "paused",
        error: "Run budget reached: 30 of 30 minutes used. Its agents were stopped; raise the budget or Resume to continue.",
      }),
    ).toBe("30 of 30 minutes used");
    expect(budgetPauseDetail({ status: "paused", error: "Lead stopped" })).toBeUndefined();
    expect(
      budgetPauseDetail({ status: "active", error: "Run budget reached: x." }),
    ).toBeUndefined();
  });
});
