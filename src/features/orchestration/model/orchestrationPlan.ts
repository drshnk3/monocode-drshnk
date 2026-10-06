import { HARNESSES, type Block, type HarnessId, type Session } from "../../sessions/model/session";
import { isEqualOrInside, pathKey } from "../../../shared/lib/paths";
import {
  DEFAULT_ORCHESTRATION_LIMITS,
  type OrchestrationLimits,
} from "./orchestrationLimits";
import {
  MAX_CHECK_COMMAND,
  MAX_TASK_CHECKS,
  type TaskKind,
} from "./orchestrationState";

/** Longest shared brief a proposal may carry into every worker prompt. */
export const MAX_ORCHESTRATION_BRIEF = 8000;

export type OrchestrationChoice = {
  harness: HarnessId;
  model: string;
  name: string;
};
export type OrchestrationSettings = {
  choices: OrchestrationChoice[];
  maxWorkers: number;
  /** Accept tasks whose app-run checks all pass without waiting for the lead. */
  autoAccept?: boolean;
};
export type ProposedTask = {
  id: string;
  title: string;
  prompt: string;
  harness: HarnessId;
  model: string;
  modelSettings?: Record<string, string>;
  files: string[];
  dependsOn: string[];
  /** Absent means "work". */
  kind?: TaskKind;
  reviewOf?: string[];
  checks?: string[];
};

/**
 * Acceptance checks for one task: absent or empty means none. Shared by the
 * proposal card and the delegate action so both reject the same input.
 */
export function validateTaskChecks(
  value: unknown,
  label: string,
): string[] | undefined {
  if (value == null) return undefined;
  if (!Array.isArray(value) || value.length > MAX_TASK_CHECKS)
    throw new Error(
      `${label} checks must be an array of at most ${MAX_TASK_CHECKS} shell commands`,
    );
  const checks = value.map((item) => {
    if (typeof item !== "string" || !item.trim())
      throw new Error(`${label} checks must be non-empty command strings`);
    if (item.trim().length > MAX_CHECK_COMMAND)
      throw new Error(
        `Keep each of ${label}'s checks under ${MAX_CHECK_COMMAND} characters; use a focused command such as one test file or a typecheck`,
      );
    return item.trim();
  });
  const unique = [...new Set(checks)];
  return unique.length ? unique : undefined;
}

/** "work" or "review"; absent means "work". */
export function validateTaskKind(value: unknown, label: string): TaskKind {
  if (value == null || value === "work") return "work";
  if (value === "review") return "review";
  throw new Error(`${label} kind must be "work" or "review"`);
}
export type OrchestrationProposal = {
  version: 1;
  leadId: string;
  /** Project identity retained for history and proposal ownership. */
  cwd: string;
  /** Concrete checkout inspected while preparing this proposal. */
  checkoutCwd?: string;
  request: string;
  author: OrchestrationChoice;
  settings: OrchestrationSettings;
  status: "planning" | "ready" | "invalid" | "starting" | "approved";
  title: string;
  summary: string;
  /** Conventions, key files and architecture notes shared by every worker. */
  brief?: string;
  tasks: ProposedTask[];
  error?: string;
  /** Kept only for invalid cards so a retry can repair the response directly. */
  response?: string;
};

function required(value: unknown, label: string, max = 30_000): string {
  if (typeof value !== "string" || !value.trim() || value.length > max)
    throw new Error(`Provide ${label}`);
  return value.trim();
}
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Expected an assignment object");
  return value as Record<string, unknown>;
}
function stringList(value: unknown, label: string, max: number): string[] {
  if (!Array.isArray(value) || value.length > max)
    throw new Error(`Invalid ${label}`);
  return [
    ...new Set(
      value
        .filter((item) => item !== "")
        .map((item) => required(item, label, 512)),
    ),
  ];
}

function scopePath(value: string): string {
  const slashed = value.replace(/\\/g, "/");
  const prefix = slashed.startsWith("//")
    ? "//"
    : /^[A-Za-z]:\//.test(slashed)
      ? slashed.slice(0, 3)
      : slashed.startsWith("/")
        ? "/"
        : "";
  const rest = slashed.slice(prefix.length);
  const parts = rest.split("/").filter((part) => part && part !== ".");
  return `${prefix}${parts.join("/")}` || ".";
}

function projectRelativeScope(
  value: string,
  cwd: string | undefined,
  assignmentId: string,
): string {
  const slashed = value.replace(/\\/g, "/");
  if (slashed.split("/").includes(".."))
    throw new Error(
      `Assignment "${assignmentId}" has invalid file scope "${value}". Use project-relative paths without '..', or '.' for the whole project`,
    );
  const normalized = scopePath(value);
  if (/^[A-Za-z]:/.test(normalized) && !/^[A-Za-z]:\//.test(normalized))
    throw new Error(
      `Assignment "${assignmentId}" has invalid file scope "${value}". Use project-relative paths, or '.' for the whole project`,
    );
  const absolute =
    normalized.startsWith("/") || /^[A-Za-z]:\//.test(normalized);
  if (!absolute) return normalized;
  if (!cwd || !isEqualOrInside(normalized, scopePath(cwd)))
    throw new Error(
      `Assignment "${assignmentId}" uses file scope "${value}" outside the selected checkout${cwd ? ` "${cwd}"` : ""}. Orchestration currently supports one checkout per run`,
    );
  const root = scopePath(cwd);
  if (pathKey(normalized) === pathKey(root)) return ".";
  return normalized.slice(root.length).replace(/^\/+/, "");
}

function stringRecord(value: unknown, label: string): Record<string, string> {
  const input = record(value);
  const entries = Object.entries(input);
  if (entries.length > 32) throw new Error(`Invalid ${label}`);
  return Object.fromEntries(
    entries.map(([key, entry]) => [
      required(key, label, 128),
      required(entry, label, 256),
    ]),
  );
}

export function validateOrchestrationSettings(
  value: unknown,
  limits: Pick<OrchestrationLimits, "maxWorkers"> = DEFAULT_ORCHESTRATION_LIMITS,
): OrchestrationSettings {
  const input = record(value);
  if (
    !Number.isInteger(input.maxWorkers) ||
    Number(input.maxWorkers) < 1 ||
    Number(input.maxWorkers) > limits.maxWorkers
  )
    throw new Error(`Choose 1 to ${limits.maxWorkers} parallel workers`);
  if (
    !Array.isArray(input.choices) ||
    !input.choices.length ||
    input.choices.length > 4096
  )
    throw new Error(
      "No worker models are available, or the model catalog is too large. Check your connected harnesses.",
    );
  const choices = input.choices.map((value) => {
    const item = record(value);
    const harness = required(item.harness, "a harness", 32) as HarnessId;
    if (!HARNESSES.includes(harness)) throw new Error("Unknown worker harness");
    return {
      harness,
      model: required(item.model, "a model", 256),
      name: required(item.name, "a model name", 256),
    };
  });
  if (input.autoAccept != null && typeof input.autoAccept !== "boolean")
    throw new Error("autoAccept must be true or false");
  return {
    maxWorkers: Number(input.maxWorkers),
    ...(input.autoAccept === true ? { autoAccept: true } : {}),
    choices: choices.filter(
      (choice, index) =>
        choices.findIndex(
          (entry) =>
            entry.harness === choice.harness && entry.model === choice.model,
        ) === index,
    ),
  };
}

/** Validate the entire graph before enabling any process or acquiring scopes. */
export function validateProposedTasks(
  value: unknown,
  settings: OrchestrationSettings,
  cwd?: string,
  limits: Pick<OrchestrationLimits, "maxTasks"> = DEFAULT_ORCHESTRATION_LIMITS,
): ProposedTask[] {
  if (!Array.isArray(value) || !value.length || value.length > limits.maxTasks)
    throw new Error(`Provide 1 to ${limits.maxTasks} assignments`);
  const tasks = value.map((value, index) => {
    const task = record(value);
    const label = `assignment ${index + 1}${typeof task.id === "string" ? ` (${task.id})` : ""}`;
    const model = required(task.model, `a model for ${label}`, 256);
    // Models already identify their harness in our catalog. Recover an omitted
    // redundant field without another model call, but never override a choice.
    const matches = settings.choices.filter((choice) => choice.model === model);
    const harnesses = [...new Set(matches.map((choice) => choice.harness))];
    const missingHarness = task.harness == null || task.harness === "";
    const harness = required(
      missingHarness && harnesses.length === 1 ? harnesses[0] : task.harness,
      `a harness for ${label}; use an exact harness/model pair from the available catalog`,
      32,
    ) as HarnessId;
    if (
      !settings.choices.some(
        (choice) => choice.harness === harness && choice.model === model,
      )
    )
      throw new Error(
        `The harness/model pair for ${label} is outside the available catalog: ${harness} / ${model}`,
      );
    const id = required(task.id, "an assignment ID", 64);
    if (!/^[A-Za-z0-9_-]+$/.test(id))
      throw new Error(
        "Assignment IDs must contain letters, numbers, underscores or hyphens",
      );
    const kind = validateTaskKind(task.kind, `Assignment "${id}"`);
    const files = [
      ...new Set(
        stringList(
          kind === "review" ? (task.files ?? []) : task.files,
          "file scopes",
          64,
        ).map((path) => projectRelativeScope(path, cwd, id)),
      ),
    ];
    const checks = validateTaskChecks(task.checks, `Assignment "${id}"`);
    const reviewOf =
      task.reviewOf == null
        ? []
        : stringList(task.reviewOf, "reviewed assignments", limits.maxTasks);
    if (kind === "review") {
      if (files.length)
        throw new Error(
          `Review assignment "${id}" must have empty files: reviewers read and never write`,
        );
      if (!reviewOf.length)
        throw new Error(
          `Review assignment "${id}" needs reviewOf: the IDs of the assignments it reviews`,
        );
      if (checks)
        throw new Error(
          `Review assignment "${id}" cannot have checks; put them on the assignments it reviews, whose checkouts hold the changes`,
        );
    } else {
      if (!files.length)
        throw new Error(
          `Assignment "${id}" has no file scopes. Use project-relative paths, or '.' for the whole project`,
        );
      if (reviewOf.length)
        throw new Error(
          `Assignment "${id}" has reviewOf but is not a review; set "kind":"review" and empty files, or remove reviewOf`,
        );
    }
    return {
      id,
      title: required(task.title, "a task title", 160),
      prompt: required(task.prompt, "task instructions"),
      harness,
      model,
      ...(task.modelSettings === undefined
        ? {}
        : {
            modelSettings: stringRecord(task.modelSettings, "model settings"),
          }),
      files,
      dependsOn: stringList(
        task.dependsOn ?? [],
        "dependencies",
        limits.maxTasks,
      ),
      ...(kind === "review" ? { kind, reviewOf } : {}),
      ...(checks ? { checks } : {}),
    };
  });
  const ids = new Set(tasks.map((task) => task.id));
  if (ids.size !== tasks.length)
    throw new Error("Assignment IDs must be unique");
  for (const task of tasks) {
    for (const reviewed of task.reviewOf ?? []) {
      const target = tasks.find((entry) => entry.id === reviewed);
      if (!target)
        throw new Error(
          `Review assignment "${task.id}" reviews unknown assignment "${reviewed}"`,
        );
      if (reviewed === task.id || target.kind === "review")
        throw new Error(
          `Review assignment "${task.id}" must review work assignments, not itself or another review`,
        );
    }
  }
  const visited = new Set<string>();
  const visiting = new Set<string>();
  const visit = (id: string) => {
    if (!ids.has(id))
      throw new Error("A dependency references an unknown assignment");
    if (visiting.has(id))
      throw new Error("Assignments have a dependency cycle");
    if (visited.has(id)) return;
    visiting.add(id);
    // A review waits for the work it reads, so reviewOf orders like dependsOn.
    const task = tasks.find((entry) => entry.id === id)!;
    [...task.dependsOn, ...(task.reviewOf ?? [])].forEach(visit);
    visiting.delete(id);
    visited.add(id);
  };
  tasks.forEach((task) => visit(task.id));
  return tasks;
}

/** An optional brief: absent or blank means none, anything else must fit. */
export function validateOrchestrationBrief(value: unknown): string | undefined {
  if (value == null) return undefined;
  if (typeof value !== "string")
    throw new Error(
      "The brief must be one plain string of shared notes, or omitted",
    );
  const brief = value.trim();
  if (brief.length > MAX_ORCHESTRATION_BRIEF)
    throw new Error(
      `Keep the brief under ${MAX_ORCHESTRATION_BRIEF} characters; it is ${brief.length}. Keep only conventions, key files and architecture notes every worker needs`,
    );
  return brief || undefined;
}

export function orchestrationPlanningPrompt(
  request: string,
  settings: OrchestrationSettings,
  cwd: string,
): string {
  return [
    "Prepare an orchestration proposal for the user to review in MonoCode. Investigate and plan only: do not edit files, start workers, or invoke the MonoCode control CLI. No execution is authorized until the user confirms the assignment card.",
    "You are the orchestrator: the user selected you in the composer model picker. Decide the task breakdown and choose each worker's harness and model from the available catalog below. Do not ask the user to assemble a team. They can change your choices in the card before confirming.",
    "Keep planning efficient: inspect only what is needed to understand the request and relevant project conventions. Use the fewest useful tasks, with clear deliverables and acceptance checks. Do not create agents for trivial steps or duplicate investigation. Prefer a fast, economical model for straightforward work and a more capable model when complexity warrants it; do not invent model capabilities or prices. Reuse a suitable harness/model across tasks when that is sufficient. Explain your overall division of work briefly in the summary.",
    'Use only exact harness/model pairs from the catalog. Give each task self-contained instructions and project-relative write scopes; directories own their descendants. Parallelize independent work with disjoint files. Serialize shared-file edits with dependencies and avoid concurrent repository-wide commands. Assign project-wide generation or final combined validation to a task with files ["."]. Workers must not commit, push, switch branches, or write outside the selected checkout. If the user requested Git or cross-checkout finalization, do not create a worker for it: the lead performs only those explicitly authorized final operations after every worker is reviewed, integrated, and the orchestration run is finished. All workers use app-managed isolated checkouts; do not ask them to create or switch worktrees.',
    `The exact checkout root is ${JSON.stringify(cwd)}. Every files entry must be "." or a path relative to this root. For example, a discovered absolute path beneath this root must be returned without the root prefix. Never use an absolute path or '..'.`,
    `Also write a brief: concise shared notes from your investigation that every worker needs, such as project conventions, key files and their roles, architecture notes and the commands for focused checks. Every worker receives it ahead of its own task so it does not re-explore the project; do not repeat task instructions there. Keep it well under ${MAX_ORCHESTRATION_BRIEF} characters, or omit it when there is nothing worth sharing.`,
    `Give each work task acceptance checks when a fast, focused command can verify it: up to ${MAX_TASK_CHECKS} shell commands such as one targeted test file or a typecheck, never a full slow suite. MonoCode runs them itself in the worker's checkout after each finished turn and sends failures back to the worker automatically. Worker checkouts include the project's cloned dependency folders such as node_modules, so the usual project commands work there. Omit checks when nothing quick can verify the task.`,
    'For substantial or risky work, you may add a review task: "kind":"review", "reviewOf" listing the work task IDs it inspects, and "files":[]. A reviewer reads the completed patches the app gives it and reports approval or requested changes; it never edits files, so do not create one for trivial changes.',
    "Return your final proposal as one JSON object inside <monocode_proposal>...</monocode_proposal>. The app renders it as an editable card, so do not ask for approval in prose. No Markdown inside the JSON fields except the brief. Tasks may reference any task ID; the graph of dependsOn and reviewOf must be acyclic.",
    'Schema: {"title":"Short project title","summary":"What you will do and how the work fits together","brief":"Shared conventions, key files and architecture notes for every worker","tasks":[{"id":"task-1","title":"Short task title","prompt":"Self-contained instructions, constraints and checks","harness":"exact harness ID","model":"exact model ID","files":["src/feature"],"dependsOn":[],"checks":["npx vitest run src/feature"]},{"id":"review-1","kind":"review","reviewOf":["task-1"],"title":"Review the feature","prompt":"What to scrutinize","harness":"exact harness ID","model":"exact model ID","files":[],"dependsOn":[]}]}',
    `Parallel worker limit: ${settings.maxWorkers}`,
    `<available_models>\n${JSON.stringify(settings.choices)}\n</available_models>`,
    `<user_request>\n${request}\n</user_request>`,
  ].join("\n\n");
}

export function completeOrchestrationProposal(
  draft: OrchestrationProposal,
  response: string,
  error?: string,
): OrchestrationProposal {
  try {
    if (error) throw new Error(error);
    const tagged = response.match(
      /<monocode_proposal>\s*([\s\S]*?)\s*<\/monocode_proposal>/,
    );
    const fenced = response.match(/```(?:json)?\s*([\s\S]*?)```/);
    const raw = (tagged?.[1] ?? fenced?.[1] ?? response).trim();
    const input = record(JSON.parse(raw));
    const brief = validateOrchestrationBrief(input.brief);
    return {
      ...draft,
      title: required(input.title, "a proposal title", 160),
      summary: required(input.summary, "a proposal summary", 2000),
      brief,
      tasks: validateProposedTasks(
        input.tasks,
        draft.settings,
        draft.checkoutCwd ?? draft.cwd,
      ),
      status: "ready",
      error: undefined,
      response: undefined,
    };
  } catch (reason) {
    return {
      ...draft,
      status: "invalid",
      response: response.slice(-200_000),
      error:
        error ??
        `Could not prepare the assignment card: ${reason instanceof Error ? reason.message : String(reason)}`,
    };
  }
}

export function orchestrationRepairPrompt(
  proposal: OrchestrationProposal,
): string {
  return [
    orchestrationPlanningPrompt(
      proposal.request,
      proposal.settings,
      proposal.checkoutCwd ?? proposal.cwd,
    ),
    "Correct the previous proposal using the validation error below. Reuse your investigation and task breakdown; do not inspect the project again or run tools. Return only the corrected <monocode_proposal> JSON. Include an exact harness and model on every task. Do not execute any assignments.",
    `Validation error: ${proposal.error ?? "The previous proposal was invalid"}`,
    `<previous_response>\n${proposal.response?.slice(-60_000) ?? ""}\n</previous_response>`,
  ].join("\n\n");
}

/** At most one corrective turn; provider failures and cancellation never loop. */
export async function completeOrRepairOrchestrationProposal(
  draft: OrchestrationProposal,
  response: string,
  repair: (prompt: string) => Promise<string>,
  canRepair: () => boolean,
): Promise<OrchestrationProposal> {
  const first = completeOrchestrationProposal(draft, response);
  if (first.status !== "invalid" || !canRepair()) return first;
  const corrected = await repair(orchestrationRepairPrompt(first));
  return completeOrchestrationProposal(draft, corrected);
}

export function proposalMarkdown(proposal: OrchestrationProposal): string {
  return [
    `# ${proposal.title}`,
    proposal.summary,
    ...proposal.tasks.map(
      (task) =>
        `## ${task.title}\n${task.harness} · ${proposal.settings.choices.find((choice) => choice.harness === task.harness && choice.model === task.model)?.name ?? task.model}\n${task.prompt}\n${
          task.kind === "review"
            ? `Reviews: ${task.reviewOf?.join(", ") ?? ""}`
            : `Files: ${task.files.join(", ")}`
        }\nDepends on: ${task.dependsOn.join(", ") || "None"}${
          task.checks?.length ? `\nChecks: ${task.checks.join("; ")}` : ""
        }`,
    ),
  ].join("\n\n");
}

export function withOrchestrationProposal(
  session: Session,
  blockId: string,
  proposal: OrchestrationProposal,
): Session {
  return {
    ...session,
    blocks: session.blocks.map((block) =>
      block.id === blockId
        ? {
            ...block,
            text: proposalMarkdown(proposal),
            orchestration: proposal,
            streaming: proposal.status === "planning",
          }
        : block,
    ),
  };
}

export function proposalBlock(
  id: string,
  proposal: OrchestrationProposal,
): Block {
  return {
    id,
    role: "plan",
    text: proposalMarkdown(proposal),
    orchestration: proposal,
    streaming: true,
  };
}

/** A reload must never turn a half-generated card into an executable plan. */
export function restoreOrchestrationProposal(
  value: OrchestrationProposal,
): OrchestrationProposal {
  if (value.status === "planning")
    return {
      ...value,
      status: "invalid",
      error: "Planning was interrupted. Generate the assignments again.",
    };
  if (value.status === "starting") return { ...value, status: "ready" };
  return value;
}
