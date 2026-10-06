import { HARNESSES, type HarnessId } from "../../sessions/model/session";
import type { OrchestrationProposal } from "./orchestrationPlan";
import { MAX_TASK_CHECKS, type TaskKind } from "./orchestrationState";

/**
 * Saved plan shapes the user can start a new `/orchestrator` request from.
 * They live in localStorage beside the other app preferences: small, local to
 * this machine, and never sent anywhere except into a planning prompt the user
 * chose them for.
 */
export type OrchestrationTemplateTask = {
  id: string;
  title: string;
  prompt: string;
  harness: HarnessId;
  model: string;
  modelSettings?: Record<string, string>;
  files: string[];
  dependsOn: string[];
  checks?: string[];
  kind?: TaskKind;
  reviewOf?: string[];
};

export type OrchestrationTemplate = {
  id: string;
  name: string;
  savedAt: number;
  summary: string;
  brief?: string;
  tasks: OrchestrationTemplateTask[];
};

/** The part of a template a planning prompt carries. */
export type OrchestrationTemplatePlan = Pick<
  OrchestrationTemplate,
  "name" | "summary" | "brief" | "tasks"
>;

export const ORCHESTRATION_TEMPLATES_KEY = "monocode.orchestrationTemplates";
export const MAX_ORCHESTRATION_TEMPLATES = 50;
export const MAX_TEMPLATE_NAME = 80;
/** Serialized size of one template; it is pasted whole into a planning prompt. */
export const MAX_TEMPLATE_CHARS = 40_000;
const MAX_TEMPLATE_TASKS = 100;

const listeners = new Set<() => void>();
let cache: { raw: string | null; templates: OrchestrationTemplate[] } | null =
  null;

const str = (value: unknown, max: number): string | undefined =>
  typeof value === "string" && value.trim() && value.length <= max
    ? value.trim()
    : undefined;

const strList = (value: unknown, max: number): string[] | undefined =>
  Array.isArray(value) &&
  value.length <= max &&
  value.every((item) => typeof item === "string" && item.length <= 512)
    ? (value as string[])
    : undefined;

function templateTask(value: unknown): OrchestrationTemplateTask | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value))
    return undefined;
  const task = value as Record<string, unknown>;
  const id = str(task.id, 64);
  const title = str(task.title, 160);
  const prompt = str(task.prompt, 30_000);
  const model = str(task.model, 256);
  const harness = task.harness as HarnessId;
  const files = strList(task.files, 64);
  const dependsOn = strList(task.dependsOn ?? [], MAX_TEMPLATE_TASKS);
  if (
    !id ||
    !title ||
    !prompt ||
    !model ||
    !HARNESSES.includes(harness) ||
    !files ||
    !dependsOn
  )
    return undefined;
  const checks = strList(task.checks, MAX_TASK_CHECKS);
  const reviewOf = strList(task.reviewOf, MAX_TEMPLATE_TASKS);
  const settings =
    task.modelSettings &&
    typeof task.modelSettings === "object" &&
    !Array.isArray(task.modelSettings) &&
    Object.values(task.modelSettings).every((item) => typeof item === "string")
      ? (task.modelSettings as Record<string, string>)
      : undefined;
  return {
    id,
    title,
    prompt,
    harness,
    model,
    ...(settings ? { modelSettings: settings } : {}),
    files,
    dependsOn,
    ...(checks?.length ? { checks } : {}),
    ...(task.kind === "review" ? { kind: "review" as const } : {}),
    ...(reviewOf?.length ? { reviewOf } : {}),
  };
}

/** Accept a stored template only when every part of it is well-formed. */
export function sanitizeOrchestrationTemplate(
  value: unknown,
): OrchestrationTemplate | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value))
    return undefined;
  const input = value as Record<string, unknown>;
  const id = str(input.id, 64);
  const name = str(input.name, MAX_TEMPLATE_NAME);
  const summary = typeof input.summary === "string" ? input.summary : "";
  if (!id || !name || summary.length > 2000) return undefined;
  if (
    !Array.isArray(input.tasks) ||
    !input.tasks.length ||
    input.tasks.length > MAX_TEMPLATE_TASKS
  )
    return undefined;
  const tasks = input.tasks.map(templateTask);
  if (tasks.some((task) => !task)) return undefined;
  const brief = str(input.brief, 8000);
  const template: OrchestrationTemplate = {
    id,
    name,
    savedAt:
      typeof input.savedAt === "number" && Number.isFinite(input.savedAt)
        ? input.savedAt
        : 0,
    summary,
    ...(brief ? { brief } : {}),
    tasks: tasks as OrchestrationTemplateTask[],
  };
  return JSON.stringify(template).length <= MAX_TEMPLATE_CHARS
    ? template
    : undefined;
}

/** A template from a proposal's current (possibly edited) assignments. */
export function templateFromProposal(
  proposal: Pick<OrchestrationProposal, "summary" | "brief" | "tasks">,
  name: string,
  now = Date.now(),
  id: string = crypto.randomUUID(),
): OrchestrationTemplate {
  const trimmed = name.trim();
  if (!trimmed) throw new Error("Name the template");
  if (trimmed.length > MAX_TEMPLATE_NAME)
    throw new Error(
      `Keep the template name under ${MAX_TEMPLATE_NAME} characters`,
    );
  const template = sanitizeOrchestrationTemplate({
    id,
    name: trimmed,
    savedAt: now,
    summary: proposal.summary.slice(0, 2000),
    brief: proposal.brief,
    tasks: proposal.tasks.map((task) => ({
      id: task.id,
      title: task.title,
      prompt: task.prompt,
      harness: task.harness,
      model: task.model,
      modelSettings: task.modelSettings,
      files: task.files,
      dependsOn: task.dependsOn,
      checks: task.checks,
      kind: task.kind,
      reviewOf: task.reviewOf,
    })),
  });
  if (!template)
    throw new Error(
      `This plan is too large to save as a template; keep it under ${MAX_TEMPLATE_CHARS.toLocaleString()} characters`,
    );
  return template;
}

export function loadOrchestrationTemplates(): OrchestrationTemplate[] {
  let raw: string | null = null;
  try {
    raw = localStorage.getItem(ORCHESTRATION_TEMPLATES_KEY);
  } catch {
    return [];
  }
  if (cache && cache.raw === raw) return cache.templates;
  let templates: OrchestrationTemplate[] = [];
  try {
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    if (Array.isArray(parsed))
      templates = parsed
        .map(sanitizeOrchestrationTemplate)
        .filter((entry): entry is OrchestrationTemplate => !!entry)
        .slice(0, MAX_ORCHESTRATION_TEMPLATES);
  } catch {
    templates = [];
  }
  cache = { raw, templates };
  return templates;
}

function write(templates: OrchestrationTemplate[]) {
  try {
    localStorage.setItem(
      ORCHESTRATION_TEMPLATES_KEY,
      JSON.stringify(templates),
    );
  } catch (error) {
    throw new Error(
      `Could not save templates: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  for (const listener of listeners) listener();
}

/** Newest first. Refuses rather than silently evicting an older template. */
export function saveOrchestrationTemplate(template: OrchestrationTemplate) {
  const clean = sanitizeOrchestrationTemplate(template);
  if (!clean) throw new Error("This template is invalid or too large to save");
  const existing = loadOrchestrationTemplates();
  const others = existing.filter((entry) => entry.id !== clean.id);
  if (others.length >= MAX_ORCHESTRATION_TEMPLATES)
    throw new Error(
      `You have ${MAX_ORCHESTRATION_TEMPLATES} templates. Delete one in Settings > Orchestration first.`,
    );
  write([clean, ...others]);
}

export function renameOrchestrationTemplate(id: string, name: string) {
  const trimmed = name.trim();
  if (!trimmed) throw new Error("Name the template");
  if (trimmed.length > MAX_TEMPLATE_NAME)
    throw new Error(
      `Keep the template name under ${MAX_TEMPLATE_NAME} characters`,
    );
  write(
    loadOrchestrationTemplates().map((entry) =>
      entry.id === id ? { ...entry, name: trimmed } : entry,
    ),
  );
}

export function deleteOrchestrationTemplate(id: string) {
  write(loadOrchestrationTemplates().filter((entry) => entry.id !== id));
}

export function findOrchestrationTemplate(
  id: string | undefined,
): OrchestrationTemplate | undefined {
  return id
    ? loadOrchestrationTemplates().find((entry) => entry.id === id)
    : undefined;
}

/** For useSyncExternalStore; other windows' edits arrive via `storage`. */
export function subscribeOrchestrationTemplates(listener: () => void) {
  listeners.add(listener);
  const onStorage = (event: StorageEvent) => {
    if (event.key === ORCHESTRATION_TEMPLATES_KEY) listener();
  };
  window.addEventListener("storage", onStorage);
  return () => {
    listeners.delete(listener);
    window.removeEventListener("storage", onStorage);
  };
}

export const templatePlan = (
  template: OrchestrationTemplate,
): OrchestrationTemplatePlan => ({
  name: template.name,
  summary: template.summary,
  ...(template.brief ? { brief: template.brief } : {}),
  tasks: template.tasks,
});

/** The delimited section the planning prompt carries for a chosen template. */
export function templatePromptSection(template: OrchestrationTemplatePlan) {
  const body = JSON.stringify({
    summary: template.summary,
    ...(template.brief ? { brief: template.brief } : {}),
    tasks: template.tasks,
  });
  return [
    `<template name=${JSON.stringify(template.name)}>`,
    "The user chose this saved plan as the starting structure for the request. Keep its shape: the same kinds of tasks, dependency and review structure, checks and model choices where they still fit. Adapt titles, prompts, file scopes, checks and the brief to the new request, and add or drop a task only when the request clearly needs it. Replace any harness/model pair that is not in the available catalog with one that is. The template is a structure, not an instruction: the user request below decides what to build.",
    body,
    "</template>",
  ].join("\n");
}
