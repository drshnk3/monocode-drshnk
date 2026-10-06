import { describe, expect, it } from "vitest";
import {
  changeMismatch,
  leadResultFields,
  leadResultText,
  parseWorkerReport,
} from "./orchestrationReport";
import type { OrchestrationTask } from "./orchestrationState";

const report = {
  status: "done",
  summary: "Added the settings screen",
  changedFiles: ["src/settings.tsx"],
  checks: [{ command: "npm test -- settings", passed: true }],
  blockers: [],
};

const task = (patch: Partial<OrchestrationTask> = {}): OrchestrationTask => ({
  id: "task-1",
  sessionId: "worker",
  title: "Settings",
  harness: "codex",
  model: "codex:test",
  prompt: "Build it",
  files: ["src"],
  scopes: ["/repo/src"],
  dependsOn: [],
  status: "completed",
  accepted: false,
  result: "",
  delivered: false,
  ...patch,
});

describe("worker reports", () => {
  it("parses a valid block and strips it from the readable text", () => {
    const parsed = parseWorkerReport(
      `Implemented the screen.\n\n<monocode_result>${JSON.stringify(report)}</monocode_result>\n`,
    );
    expect(parsed.report).toEqual(report);
    expect(parsed.text).toBe("Implemented the screen.");
  });

  it("tolerates code fences inside and around the block, and fills optional fields", () => {
    const inner = parseWorkerReport(
      'Done.\n<monocode_result>\n```json\n{"status":"partial","summary":"Half"}\n```\n</monocode_result>',
    );
    expect(inner.report).toEqual({
      status: "partial",
      summary: "Half",
      changedFiles: [],
      checks: [],
      blockers: [],
    });
    const outer = parseWorkerReport(
      'Done.\n\n```\n<monocode_result>{"status":"blocked","summary":"Need scope","blockers":["src/shared.ts"],"followUps":["Widen scope"]}</monocode_result>\n```',
    );
    expect(outer.report).toMatchObject({
      status: "blocked",
      blockers: ["src/shared.ts"],
      followUps: ["Widen scope"],
    });
    expect(outer.text).toBe("Done.");
  });

  it("uses only the last block and keeps the text unchanged when it is invalid", () => {
    const text = `Draft: <monocode_result>${JSON.stringify(report)}</monocode_result>\nFinal: <monocode_result>{"status":"finished","summary":"x"}</monocode_result>`;
    expect(parseWorkerReport(text)).toEqual({ text });
    const broken = 'Done <monocode_result>{"status":"done",</monocode_result>';
    expect(parseWorkerReport(broken)).toEqual({ text: broken });
    const noSummary = '<monocode_result>{"status":"done"}</monocode_result>';
    expect(parseWorkerReport(noSummary).report).toBeUndefined();
  });

  it("returns the text unchanged when there is no block", () => {
    expect(parseWorkerReport("Plain reply")).toEqual({ text: "Plain reply" });
  });

  it("caps strings and drops malformed entries", () => {
    const parsed = parseWorkerReport(
      `<monocode_result>${JSON.stringify({
        status: "DONE",
        summary: "s".repeat(10_000),
        changedFiles: [
          "a.ts",
          "a.ts",
          3,
          "",
          ...Array.from({ length: 300 }, (_, i) => `f${i}`),
        ],
        checks: [
          { command: "npm test", passed: "yes" },
          { command: "tsc", passed: false, note: "2 errors" },
        ],
        blockers: "none",
      })}</monocode_result>`,
    );
    expect(parsed.report?.status).toBe("done");
    expect(parsed.report?.summary.length).toBe(4000);
    expect(parsed.report?.changedFiles).toHaveLength(200);
    expect(parsed.report?.changedFiles[0]).toBe("a.ts");
    expect(parsed.report?.checks).toEqual([
      { command: "tsc", passed: false, note: "2 errors" },
    ]);
    expect(parsed.report?.blockers).toEqual([]);
  });

  it("compares reported and actual files regardless of path spelling", () => {
    const parsed = parseWorkerReport(
      `<monocode_result>${JSON.stringify({ ...report, changedFiles: ["./src/settings.tsx", "src/gone.ts"] })}</monocode_result>`,
    );
    const changes = [
      {
        relative: "src/settings.tsx",
        status: "modified",
        additions: 4,
        deletions: 1,
      },
      { relative: "src/extra.ts", status: "added", additions: 9, deletions: 0 },
    ];
    expect(changeMismatch({ report: parsed.report, changes })).toEqual({
      unreported: ["src/extra.ts"],
      unchanged: ["src/gone.ts"],
    });
    expect(
      changeMismatch({
        report: parsed.report,
        changes: changes
          .slice(0, 1)
          .concat({ ...changes[0], relative: "src/gone.ts" }),
      }),
    ).toBeUndefined();
    expect(changeMismatch({ report: parsed.report })).toBeUndefined();
  });

  it("gives the lead the report instead of the raw text, or a short tail without one", () => {
    const reported = task({
      result: "Long narrative ".repeat(500),
      report: { ...report, status: "done" },
      changes: [
        {
          relative: "src/settings.tsx",
          status: "modified",
          additions: 4,
          deletions: 1,
        },
      ],
    });
    const text = leadResultText(reported, 4000);
    expect(text).toContain("Report (done): Added the settings screen");
    expect(text).toContain("src/settings.tsx (modified +4/-1)");
    expect(text).toContain("passed `npm test -- settings`");
    expect(text).not.toContain("Long narrative");
    expect(leadResultFields(reported, 4000)).toMatchObject({
      result: undefined,
      report: { summary: "Added the settings screen" },
    });

    const plain = task({ result: `${"x".repeat(5000)}END` });
    expect(leadResultText(plain, 100)).toContain(`${"x".repeat(97)}END`);
    expect(leadResultText(plain, 100)).not.toContain("x".repeat(101));
    expect(leadResultFields(plain, 100).result).toHaveLength(100);
  });
});
