// @vitest-environment happy-dom
import { beforeEach, describe, expect, it } from "vitest";
import {
  MAX_ORCHESTRATION_TEMPLATES,
  MAX_TEMPLATE_NAME,
  ORCHESTRATION_TEMPLATES_KEY,
  deleteOrchestrationTemplate,
  findOrchestrationTemplate,
  loadOrchestrationTemplates,
  renameOrchestrationTemplate,
  saveOrchestrationTemplate,
  templateFromProposal,
  templatePlan,
} from "./orchestrationTemplates";
import {
  orchestrationPlanningPrompt,
  orchestrationRepairPrompt,
  type OrchestrationProposal,
} from "./orchestrationPlan";

const proposal: OrchestrationProposal = {
  version: 1,
  leadId: "lead",
  cwd: "/repo",
  request: "Build settings",
  author: { harness: "claude", model: "claude:test", name: "Lead" },
  settings: {
    choices: [{ harness: "codex", model: "codex:test", name: "Worker" }],
    maxWorkers: 2,
  },
  status: "ready",
  title: "Settings",
  summary: "UI then review",
  brief: "Use the shared Toggle.",
  tasks: [
    {
      id: "ui",
      title: "Settings UI",
      prompt: "Build the view",
      harness: "codex",
      model: "codex:test",
      files: ["src/settings"],
      dependsOn: [],
      checks: ["npx vitest run src/settings"],
    },
    {
      id: "review",
      title: "Review UI",
      prompt: "Check it",
      harness: "codex",
      model: "codex:test",
      files: [],
      dependsOn: [],
      kind: "review",
      reviewOf: ["ui"],
    },
  ],
};

beforeEach(() => localStorage.clear());

describe("orchestration templates", () => {
  it("saves a proposal's shape and loads it back, newest first", () => {
    saveOrchestrationTemplate(templateFromProposal(proposal, "First", 1, "t1"));
    saveOrchestrationTemplate(templateFromProposal(proposal, " Second ", 2, "t2"));
    const templates = loadOrchestrationTemplates();
    expect(templates.map((entry) => entry.name)).toEqual(["Second", "First"]);
    expect(templates[0]).toMatchObject({
      summary: "UI then review",
      brief: "Use the shared Toggle.",
      tasks: [
        { id: "ui", checks: ["npx vitest run src/settings"], files: ["src/settings"] },
        { id: "review", kind: "review", reviewOf: ["ui"], files: [] },
      ],
    });
    // Run-time card state is not part of a template.
    expect(JSON.stringify(templates[0])).not.toContain("Build settings");
  });

  it("renames and deletes", () => {
    saveOrchestrationTemplate(templateFromProposal(proposal, "Old", 1, "t1"));
    renameOrchestrationTemplate("t1", "New name");
    expect(findOrchestrationTemplate("t1")?.name).toBe("New name");
    expect(() => renameOrchestrationTemplate("t1", "  ")).toThrow("Name");
    deleteOrchestrationTemplate("t1");
    expect(loadOrchestrationTemplates()).toEqual([]);
  });

  it("caps the count and refuses rather than evicting", () => {
    for (let index = 0; index < MAX_ORCHESTRATION_TEMPLATES; index++)
      saveOrchestrationTemplate(
        templateFromProposal(proposal, `T${index}`, index, `t${index}`),
      );
    expect(() =>
      saveOrchestrationTemplate(templateFromProposal(proposal, "One more", 99, "x")),
    ).toThrow(`${MAX_ORCHESTRATION_TEMPLATES} templates`);
    // Re-saving an existing id replaces it instead of counting twice.
    saveOrchestrationTemplate(templateFromProposal(proposal, "Again", 100, "t3"));
    expect(loadOrchestrationTemplates()).toHaveLength(MAX_ORCHESTRATION_TEMPLATES);
  });

  it("rejects names and plans that are too large", () => {
    expect(() =>
      templateFromProposal(proposal, "x".repeat(MAX_TEMPLATE_NAME + 1)),
    ).toThrow("under");
    const huge = {
      ...proposal,
      tasks: proposal.tasks.map((task) => ({ ...task, prompt: "y".repeat(25_000) })),
    };
    expect(() => templateFromProposal(huge, "Huge")).toThrow("too large");
  });

  it("drops malformed stored entries instead of failing", () => {
    localStorage.setItem(
      ORCHESTRATION_TEMPLATES_KEY,
      JSON.stringify([
        { id: "bad", name: "Bad", tasks: [{ id: "x" }] },
        templateFromProposal(proposal, "Good", 1, "good"),
      ]),
    );
    expect(loadOrchestrationTemplates().map((entry) => entry.id)).toEqual(["good"]);
    localStorage.setItem(ORCHESTRATION_TEMPLATES_KEY, "{not json");
    expect(loadOrchestrationTemplates()).toEqual([]);
  });

  it("puts a chosen template in a delimited section of the planning prompt", () => {
    const template = templatePlan(templateFromProposal(proposal, "Settings flow", 1, "t1"));
    const prompt = orchestrationPlanningPrompt(
      "Add a profile page",
      proposal.settings,
      "/repo",
      template,
    );
    const section = prompt.match(/<template name="Settings flow">([\s\S]*?)<\/template>/);
    expect(section?.[1]).toContain("Keep its shape");
    expect(section?.[1]).toContain('"reviewOf":["ui"]');
    // The request still comes last and decides what to build.
    expect(prompt.indexOf("</template>")).toBeLessThan(prompt.indexOf("<user_request>"));
    expect(
      orchestrationPlanningPrompt("Add a profile page", proposal.settings, "/repo"),
    ).not.toContain("<template");
    // A repair turn keeps the template the user chose.
    expect(
      orchestrationRepairPrompt({ ...proposal, template, error: "bad" }),
    ).toContain('<template name="Settings flow">');
  });
});
