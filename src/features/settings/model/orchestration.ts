import {
  resolveOrchestrationLimits,
  type OrchestrationLimits,
} from "../../orchestration/model/orchestrationLimits";

const ORCHESTRATION_PREFERENCES_KEY = "monocode.orchestration";

/** Defaults the native worktree command uses when none are passed. */
export const DEFAULT_DEPENDENCY_DIRS: readonly string[] = Object.freeze([
  "node_modules",
  ".venv",
  "venv",
]);
export const MAX_DEPENDENCY_DIRS = 32;
const MAX_DEPENDENCY_DIR = 128;

export type OrchestrationPreferences = {
  /** Run caps a new run starts with; each is clamped to its allowed range. */
  limits: OrchestrationLimits;
  /** Ignored folder basenames cloned into every worker worktree. */
  dependencyDirs: string[];
  /** A new proposal card starts with auto-accept on. */
  autoAccept: boolean;
  /** Start small, valid proposals without waiting for a click. */
  quickMode: boolean;
  /** Prepare worker worktrees while a proposal waits for confirmation. */
  prewarm: boolean;
};

export const DEFAULT_ORCHESTRATION_PREFERENCES: Readonly<OrchestrationPreferences> =
  Object.freeze({
    limits: resolveOrchestrationLimits(),
    dependencyDirs: [...DEFAULT_DEPENDENCY_DIRS],
    autoAccept: false,
    quickMode: false,
    prewarm: true,
  });

/**
 * One folder basename, with the same rule as the native command: no path
 * separators, not "." or "..". Throws a message fit for the settings field.
 */
export function validateDependencyDir(value: string): string {
  const name = value.trim();
  if (!name) throw new Error("Folder names cannot be empty");
  if (name === "." || name === "..")
    throw new Error(`"${name}" is not a folder name`);
  if (/[/\\]/.test(name))
    throw new Error(
      `"${name}" contains a path separator; list folder names only, such as node_modules`,
    );
  if (name.includes("\0") || name.length > MAX_DEPENDENCY_DIR)
    throw new Error(`"${name.slice(0, 40)}" is not a valid folder name`);
  return name;
}

/** Parse a comma- or line-separated list; duplicates collapse. */
export function parseDependencyDirs(
  text: string,
): { dirs: string[]; error?: undefined } | { dirs?: undefined; error: string } {
  try {
    const dirs = [
      ...new Set(
        text
          .split(/[,\n]/)
          .map((part) => part.trim())
          .filter(Boolean)
          .map(validateDependencyDir),
      ),
    ];
    if (dirs.length > MAX_DEPENDENCY_DIRS)
      return { error: `List at most ${MAX_DEPENDENCY_DIRS} folders` };
    return { dirs };
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}

const bool = (value: unknown, fallback: boolean) =>
  typeof value === "boolean" ? value : fallback;

/** Complete a stored value; anything malformed falls back to its default. */
export function resolveOrchestrationPreferences(
  value: unknown,
): OrchestrationPreferences {
  const input =
    value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {};
  const defaults = DEFAULT_ORCHESTRATION_PREFERENCES;
  let dependencyDirs = [...defaults.dependencyDirs];
  if (
    Array.isArray(input.dependencyDirs) &&
    input.dependencyDirs.every((item) => typeof item === "string")
  ) {
    const parsed = parseDependencyDirs(
      (input.dependencyDirs as string[]).join("\n"),
    );
    if (parsed.dirs) dependencyDirs = parsed.dirs;
  }
  return {
    limits: resolveOrchestrationLimits(
      input.limits && typeof input.limits === "object"
        ? (input.limits as Partial<OrchestrationLimits>)
        : undefined,
    ),
    dependencyDirs,
    autoAccept: bool(input.autoAccept, defaults.autoAccept),
    quickMode: bool(input.quickMode, defaults.quickMode),
    prewarm: bool(input.prewarm, defaults.prewarm),
  };
}

export function loadOrchestrationPreferences(): OrchestrationPreferences {
  try {
    const raw = localStorage.getItem(ORCHESTRATION_PREFERENCES_KEY);
    return resolveOrchestrationPreferences(raw ? JSON.parse(raw) : undefined);
  } catch {
    return resolveOrchestrationPreferences(undefined);
  }
}

/** Merge, clamp and store; returns what was actually saved. */
export function saveOrchestrationPreferences(
  patch: Partial<OrchestrationPreferences>,
): OrchestrationPreferences {
  const current = loadOrchestrationPreferences();
  const next = resolveOrchestrationPreferences({
    ...current,
    ...patch,
    limits: { ...current.limits, ...patch.limits },
  });
  try {
    localStorage.setItem(ORCHESTRATION_PREFERENCES_KEY, JSON.stringify(next));
  } catch {
    // private mode / quota
  }
  return next;
}
