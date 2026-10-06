import { describe, expect, it, vi } from "vitest";
import {
  completeOrchestrationProposal,
  completeOrRepairOrchestrationProposal,
  orchestrationRepairPrompt,
  orchestrationPlanningPrompt,
  proposalBlock,
  validateOrchestrationBrief,
  validateOrchestrationSettings,
  validateProposedTasks,
  type OrchestrationProposal,
} from "./orchestrationPlan";
import { newSession } from "../../sessions/model/session";
import { sanitizeSessionForPersist } from "../../sessions/data/sessionStore";
import { stopStreaming } from "../../../integrations/harness/core/apply";

const draft: OrchestrationProposal = {
  version: 1,
  leadId: "lead",
  cwd: "/repo",
  request: "Build settings",
  author: { harness: "claude", model: "claude:test", name: "Lead" },
  settings: {
    choices: [{ harness: "codex", model: "codex:test", name: "Worker" }],
    maxWorkers: 2,
  },
  status: "planning",
  title: "Planning",
  summary: "",
  tasks: [],
};
const task = {
  id: "ui",
  title: "Settings UI",
  prompt: "Build the view",
  harness: "codex",
  model: "codex:test",
  files: ["src/settings"],
  dependsOn: [],
};
const payload = {
  title: "Settings",
  summary: "Build the view, then validate",
  tasks: [task],
};

describe("orchestration proposals", () => {
  it("recovers an omitted harness from an exact, unambiguous catalog model without another turn", async () => {
    const repair = vi.fn();
    const result = await completeOrRepairOrchestrationProposal(
      draft,
      JSON.stringify({ ...payload, tasks: [{ ...task, harness: undefined }] }),
      repair,
      () => true,
    );
    expect(result.status).toBe("ready");
    expect(result.tasks[0].harness).toBe("codex");
    expect(repair).not.toHaveBeenCalled();
    expect(result.response).toBeUndefined();
  });

  it("never guesses ambiguous harnesses or replaces an explicit unavailable choice", () => {
    const settings = {
      ...draft.settings,
      choices: [
        { harness: "codex" as const, model: "shared", name: "One" },
        { harness: "opencode" as const, model: "shared", name: "Two" },
      ],
    };
    expect(() =>
      validateProposedTasks(
        [{ ...task, model: "shared", harness: undefined }],
        settings,
      ),
    ).toThrow("a harness for assignment 1 (ui)");
    expect(() =>
      validateProposedTasks([{ ...task, harness: "opencode" }], draft.settings),
    ).toThrow("outside the available catalog");
    expect(() =>
      validateProposedTasks(
        [{ ...task, model: "unknown", harness: undefined }],
        settings,
      ),
    ).toThrow("available catalog");
  });

  it("repairs malformed output once with the failed response, exact error and catalog", async () => {
    const invalid = JSON.stringify({
      ...payload,
      tasks: [{ ...task, model: "unknown" }],
    });
    const repair = vi.fn(async () => JSON.stringify(payload));
    const result = await completeOrRepairOrchestrationProposal(
      draft,
      invalid,
      repair,
      () => true,
    );
    expect(result.status).toBe("ready");
    expect(repair).toHaveBeenCalledOnce();
    const prompt = repair.mock.calls[0][0];
    expect(prompt).toContain("assignment 1 (ui)");
    expect(prompt).toContain(invalid);
    expect(prompt).toContain("do not inspect the project again or run tools");
    expect(prompt).toContain('"model":"codex:test"');
  });

  it("stops after one unsuccessful repair and retains its response for manual retry", async () => {
    const repair = vi.fn(async () => "Still invalid");
    const result = await completeOrRepairOrchestrationProposal(
      draft,
      "Invalid",
      repair,
      () => true,
    );
    expect(repair).toHaveBeenCalledOnce();
    expect(result.status).toBe("invalid");
    expect(result.tasks).toEqual([]);
    expect(result.response).toBe("Still invalid");
    expect(orchestrationRepairPrompt(result)).toContain("Still invalid");
  });

  it("does not spend a repair turn after cancellation or retry a failed provider", async () => {
    const repair = vi.fn(async () => {
      throw new Error("Provider unavailable");
    });
    const result = await completeOrRepairOrchestrationProposal(
      draft,
      "Invalid",
      repair,
      () => false,
    );
    expect(result.status).toBe("invalid");
    expect(repair).not.toHaveBeenCalled();
    await expect(
      completeOrRepairOrchestrationProposal(
        draft,
        "Invalid",
        repair,
        () => true,
      ),
    ).rejects.toThrow("Provider unavailable");
    expect(repair).toHaveBeenCalledOnce();
  });

  it("prompts the current lead with the available model catalog and no execution authority", () => {
    const prompt = orchestrationPlanningPrompt(
      draft.request,
      draft.settings,
      draft.cwd,
    );
    expect(prompt).toContain("do not edit files, start workers");
    expect(prompt).toContain('"model":"codex:test"');
    expect(prompt).toContain("until the user confirms");
    expect(prompt).toContain("<monocode_proposal>");
    expect(prompt).toContain("fewest useful tasks");
    expect(prompt).toContain("Do not ask the user to assemble a team");
    expect(prompt).toContain("disjoint files");
    expect(prompt).toContain("acceptance checks");
    expect(prompt).toContain('exact checkout root is "/repo"');
    expect(prompt).toContain("returned without the root prefix");
    expect(prompt).toContain('"brief":');
    expect(prompt).toContain("does not re-explore");
  });
  it("carries a concise brief and rejects one that is too long or not text", () => {
    const ready = completeOrchestrationProposal(
      draft,
      JSON.stringify({ ...payload, brief: "  Use pnpm; UI lives in src/ui.  " }),
    );
    expect(ready.status).toBe("ready");
    expect(ready.brief).toBe("Use pnpm; UI lives in src/ui.");
    expect(
      completeOrchestrationProposal(draft, JSON.stringify({ ...payload, brief: " " }))
        .brief,
    ).toBeUndefined();
    expect(
      completeOrchestrationProposal(draft, JSON.stringify(payload)).brief,
    ).toBeUndefined();

    const long = completeOrchestrationProposal(
      draft,
      JSON.stringify({ ...payload, brief: "x".repeat(8001) }),
    );
    expect(long.status).toBe("invalid");
    expect(long.error).toContain("Keep the brief under 8000 characters");
    const wrong = completeOrchestrationProposal(
      draft,
      JSON.stringify({ ...payload, brief: ["notes"] }),
    );
    expect(wrong.status).toBe("invalid");
    expect(wrong.error).toContain("The brief must be one plain string");
    expect(validateOrchestrationBrief(undefined)).toBeUndefined();
  });
  it("routes worker and assignment caps through the limits", () => {
    expect(() =>
      validateOrchestrationSettings({ ...draft.settings, maxWorkers: 5 }),
    ).toThrow("Choose 1 to 4 parallel workers");
    expect(
      validateOrchestrationSettings(
        { ...draft.settings, maxWorkers: 6 },
        { maxWorkers: 8 },
      ).maxWorkers,
    ).toBe(6);
    expect(() =>
      validateProposedTasks(
        [task, { ...task, id: "api", files: ["src/api"] }],
        draft.settings,
        "/repo",
        { maxTasks: 1 },
      ),
    ).toThrow("Provide 1 to 1 assignments");
  });
  it("turns the lead's structured response into a ready card without changing the discovered catalog", () => {
    const result = completeOrchestrationProposal(
      draft,
      `Commentary\n<monocode_proposal>${JSON.stringify({ ...payload, settings: { choices: [] } })}</monocode_proposal>`,
    );
    expect(result.status).toBe("ready");
    expect(result.tasks).toEqual(payload.tasks);
    expect(result.settings).toEqual(draft.settings);
    expect(result.author).toEqual(draft.author);
  });
  it("validates discovered paths against the proposal's concrete worktree", () => {
    const worktreeDraft = {
      ...draft,
      checkoutCwd: "/repo-worktrees/feature",
    };
    const result = completeOrchestrationProposal(
      worktreeDraft,
      JSON.stringify({
        ...payload,
        tasks: [
          {
            ...task,
            files: ["/repo-worktrees/feature/src/settings"],
          },
        ],
      }),
    );
    expect(result.status).toBe("ready");
    expect(result.tasks[0].files).toEqual(["src/settings"]);
    expect(orchestrationRepairPrompt(worktreeDraft)).toContain(
      'exact checkout root is "/repo-worktrees/feature"',
    );
  });
  it("accepts fenced JSON and rejects prose or a model outside the available catalog", () => {
    expect(
      completeOrchestrationProposal(
        draft,
        "```json\n" + JSON.stringify(payload) + "\n```",
      ).status,
    ).toBe("ready");
    expect(
      completeOrchestrationProposal(draft, "I will implement it now").status,
    ).toBe("invalid");
    const invalid = completeOrchestrationProposal(
      draft,
      JSON.stringify({
        ...payload,
        tasks: [{ ...task, model: "codex:unselected" }],
      }),
    );
    expect(invalid.status).toBe("invalid");
    expect(invalid.error).toContain("available catalog");
    expect(invalid.tasks).toEqual([]);
  });
  it("validates cycles, unknown dependencies and path escapes before execution", () => {
    const settings = draft.settings;
    expect(() =>
      validateProposedTasks([{ ...task, dependsOn: ["ui"] }], settings),
    ).toThrow("cycle");
    expect(() =>
      validateProposedTasks([{ ...task, dependsOn: ["missing"] }], settings),
    ).toThrow("unknown assignment");
    expect(() =>
      validateProposedTasks([{ ...task, files: ["../outside"] }], settings),
    ).toThrow('Assignment "ui" has invalid file scope "../outside"');
    expect(() => validateProposedTasks([task, task], settings)).toThrow(
      "unique",
    );
    expect(
      validateProposedTasks(
        [
          { ...task, dependsOn: ["data"] },
          { ...task, id: "data" },
        ],
        settings,
      ),
    ).toHaveLength(2);
  });
  it("validates acceptance checks, review tasks and reviewOf ordering", () => {
    const settings = draft.settings;
    const reviewer = {
      ...task,
      id: "review",
      kind: "review",
      reviewOf: ["ui"],
      files: [],
    };
    const [work, review] = validateProposedTasks(
      [{ ...task, checks: ["npm test", "npm test", " npx tsc "] }, reviewer],
      settings,
    );
    expect(work.checks).toEqual(["npm test", "npx tsc"]);
    expect(work.kind).toBeUndefined();
    expect(review).toMatchObject({
      kind: "review",
      reviewOf: ["ui"],
      files: [],
    });
    expect(
      validateProposedTasks(
        [task, { ...reviewer, files: undefined }],
        settings,
      )[1].files,
    ).toEqual([]);
    expect(
      validateProposedTasks([{ ...task, checks: [] }], settings)[0].checks,
    ).toBeUndefined();

    const fails = (tasks: unknown[], message: string) =>
      expect(() => validateProposedTasks(tasks, settings)).toThrow(message);
    fails([{ ...task, checks: Array(6).fill("npm test") }], "at most 5");
    fails([{ ...task, checks: [""] }], "non-empty command");
    fails([{ ...task, checks: ["x".repeat(501)] }], "under 500 characters");
    fails([{ ...task, checks: "npm test" }], "must be an array");
    fails([task, { ...reviewer, files: ["src"] }], "must have empty files");
    fails([task, { ...reviewer, reviewOf: [] }], "needs reviewOf");
    fails([task, { ...reviewer, reviewOf: ["missing"] }], 'unknown assignment "missing"');
    fails([task, { ...reviewer, reviewOf: ["review"] }], "not itself or another review");
    fails(
      [task, reviewer, { ...reviewer, id: "meta", reviewOf: ["review"] }],
      "not itself or another review",
    );
    fails([task, { ...reviewer, checks: ["npm test"] }], "cannot have checks");
    fails([{ ...task, reviewOf: ["ui"] }], "is not a review");
    fails([{ ...task, kind: "audit" }], 'kind must be "work" or "review"');
    // A review waits for the work it reads, so reviewing a dependent is a cycle.
    fails(
      [{ ...task, dependsOn: ["review"] }, reviewer],
      "cycle",
    );
  });
  it("asks the planner for focused checks and optional reviewers", () => {
    const prompt = orchestrationPlanningPrompt("Do it", draft.settings, "/repo");
    expect(prompt).toContain('"checks":["npx vitest run src/feature"]');
    expect(prompt).toContain('"kind":"review","reviewOf":["task-1"]');
    expect(prompt).toContain("cloned dependency folders such as node_modules");
    expect(
      validateOrchestrationSettings({ ...draft.settings, autoAccept: true })
        .autoAccept,
    ).toBe(true);
    expect(() =>
      validateOrchestrationSettings({ ...draft.settings, autoAccept: "yes" }),
    ).toThrow("autoAccept must be true or false");
  });
  it("rebases absolute scopes inside the checkout and identifies outside scopes", () => {
    expect(
      validateProposedTasks(
        [
          {
            ...task,
            files: [
              "/repo/src/settings",
              "src/settings",
              "/repo",
              "./src/shared",
            ],
          },
        ],
        draft.settings,
        draft.cwd,
      )[0].files,
    ).toEqual(["src/settings", ".", "src/shared"]);
    expect(() =>
      validateProposedTasks(
        [{ ...task, files: ["/repo-other/src"] }],
        draft.settings,
        draft.cwd,
      ),
    ).toThrow(
      'Assignment "ui" uses file scope "/repo-other/src" outside the selected checkout "/repo"',
    );
  });
  it("rebases Windows scopes case-insensitively with portable separators", () => {
    expect(
      validateProposedTasks(
        [
          {
            ...task,
            files: ["c:\\work\\repo\\src\\settings", "C:\\Work\\Repo"],
          },
        ],
        draft.settings,
        "C:\\Work\\Repo",
      )[0].files,
    ).toEqual(["src/settings", "."]);
    expect(() =>
      validateProposedTasks(
        [{ ...task, files: ["C:src\\settings"] }],
        draft.settings,
        "C:\\Work\\Repo",
      ),
    ).toThrow('Assignment "ui" has invalid file scope "C:src\\settings"');
  });
  it("keeps an explicitly selected worker effort and rejects malformed settings", () => {
    expect(
      validateProposedTasks(
        [
          {
            ...task,
            modelSettings: { reasoningEffort: "xhigh" },
          },
        ],
        draft.settings,
      )[0].modelSettings,
    ).toEqual({ reasoningEffort: "xhigh" });
    expect(() =>
      validateProposedTasks(
        [{ ...task, modelSettings: { reasoningEffort: 42 } }],
        draft.settings,
      ),
    ).toThrow("model settings");
  });
  it("keeps model edits and assignments through persistence", () => {
    const proposal = completeOrchestrationProposal(
      draft,
      JSON.stringify(payload),
    );
    proposal.tasks[0].prompt = "User edited the instructions";
    const session = {
      ...newSession("claude", "/repo"),
      blocks: [proposalBlock("proposal", proposal)],
    };
    expect(sanitizeSessionForPersist(session).blocks[0].orchestration).toEqual(
      proposal,
    );
  });
  it("makes interrupted planning non-executable on stop and reload", () => {
    const session = {
      ...newSession("claude", "/repo"),
      busy: true,
      blocks: [proposalBlock("proposal", draft)],
    };
    expect(stopStreaming(session).blocks[0].orchestration?.status).toBe(
      "invalid",
    );
    expect(
      sanitizeSessionForPersist(session).blocks[0].orchestration?.status,
    ).toBe("invalid");
  });
});
