// @vitest-environment happy-dom
import { beforeEach, describe, expect, it } from "vitest";
import {
  DEFAULT_DEPENDENCY_DIRS,
  DEFAULT_ORCHESTRATION_PREFERENCES,
  loadOrchestrationPreferences,
  parseDependencyDirs,
  saveOrchestrationPreferences,
  validateDependencyDir,
} from "./orchestration";
import {
  DEFAULT_ORCHESTRATION_LIMITS,
  ORCHESTRATION_LIMIT_RANGES,
} from "../../orchestration/model/orchestrationLimits";

beforeEach(() => localStorage.clear());

describe("orchestration preferences", () => {
  it("defaults to the model's limits, the native dependency folders and pre-warming on", () => {
    const prefs = loadOrchestrationPreferences();
    expect(prefs).toEqual(DEFAULT_ORCHESTRATION_PREFERENCES);
    expect(prefs.limits).toEqual(DEFAULT_ORCHESTRATION_LIMITS);
    expect(prefs.dependencyDirs).toEqual(DEFAULT_DEPENDENCY_DIRS);
    expect(prefs).toMatchObject({ autoAccept: false, quickMode: false, prewarm: true });
  });

  it("clamps limits to their ranges and keeps unrelated values on save", () => {
    saveOrchestrationPreferences({ quickMode: true });
    const saved = saveOrchestrationPreferences({
      limits: { ...DEFAULT_ORCHESTRATION_LIMITS, maxWorkers: 99, maxCheckRetries: -3 },
    });
    expect(saved.limits.maxWorkers).toBe(ORCHESTRATION_LIMIT_RANGES.maxWorkers[1]);
    expect(saved.limits.maxCheckRetries).toBe(0);
    expect(loadOrchestrationPreferences()).toMatchObject({
      quickMode: true,
      limits: { maxWorkers: 8, maxTasks: DEFAULT_ORCHESTRATION_LIMITS.maxTasks },
    });
  });

  it("falls back to defaults for malformed stored values", () => {
    localStorage.setItem(
      "monocode.orchestration",
      JSON.stringify({
        limits: { maxWorkers: "lots" },
        dependencyDirs: ["ok", "../escape"],
        prewarm: "yes",
      }),
    );
    const prefs = loadOrchestrationPreferences();
    expect(prefs.limits.maxWorkers).toBe(DEFAULT_ORCHESTRATION_LIMITS.maxWorkers);
    expect(prefs.dependencyDirs).toEqual(DEFAULT_DEPENDENCY_DIRS);
    expect(prefs.prewarm).toBe(true);
    localStorage.setItem("monocode.orchestration", "{");
    expect(loadOrchestrationPreferences()).toEqual(DEFAULT_ORCHESTRATION_PREFERENCES);
  });

  it("keeps an explicitly empty dependency list", () => {
    saveOrchestrationPreferences({ dependencyDirs: [] });
    expect(loadOrchestrationPreferences().dependencyDirs).toEqual([]);
  });
});

describe("dependency folders", () => {
  it("parses comma and line separated names and collapses duplicates", () => {
    expect(parseDependencyDirs("node_modules, .venv\nvendor\n\nnode_modules")).toEqual({
      dirs: ["node_modules", ".venv", "vendor"],
    });
    expect(parseDependencyDirs("  ")).toEqual({ dirs: [] });
  });

  it("rejects paths and dot names like the native command", () => {
    expect(() => validateDependencyDir("a/b")).toThrow("path separator");
    expect(() => validateDependencyDir("a\\b")).toThrow("path separator");
    expect(() => validateDependencyDir("..")).toThrow("not a folder name");
    expect(() => validateDependencyDir(".")).toThrow("not a folder name");
    expect(parseDependencyDirs("node_modules, src/deps").error).toContain("src/deps");
    expect(parseDependencyDirs(Array.from({ length: 40 }, (_, i) => `d${i}`).join(",")).error).toContain(
      "at most",
    );
  });
});
