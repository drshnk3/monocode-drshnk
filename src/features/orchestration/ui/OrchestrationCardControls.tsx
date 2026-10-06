import { useLayoutEffect, useRef, useState } from "react";
import { resizeComposer } from "../../sessions/model/composerResize";
import { useLockOverscroll } from "../../../shared/hooks/useLockOverscroll";
import { Popover } from "../../../shared/ui/Popover";
import { Plus, X } from "../../../shared/ui/icons";
import { MAX_TASK_CHECKS } from "../model/orchestrationState";
import {
  MAX_ORCHESTRATION_BRIEF,
  briefLength,
  budgetField,
  reviewCandidates,
} from "../model/orchestrationCard";
import type { OrchestrationBudget } from "../model/orchestrationLimits";
import type {
  OrchestrationProposal,
  ProposedTask,
} from "../model/orchestrationPlan";
import {
  MAX_TEMPLATE_NAME,
  saveOrchestrationTemplate,
  templateFromProposal,
} from "../model/orchestrationTemplates";

/** Shared look of the card's editable fields and quiet buttons. */
export const cardField =
  "w-full rounded-md border border-content/12 bg-background-base/40 px-2 py-1.5 text-[12px] leading-5 text-content outline-none placeholder:text-content/35 focus:border-content/30";
export const cardFieldLabel =
  "mb-1 block text-[11px] leading-tight text-content/45";
export const cardSecondary =
  "flex h-7 items-center gap-1.5 rounded-md px-2.5 text-[11px] text-content/50 hover:bg-content/8 hover:text-content disabled:opacity-35";
const chip = (on: boolean) =>
  `rounded-[5px] px-1.5 py-0.5 text-[11px] leading-4 ${
    on
      ? "bg-selection-hover font-medium text-content"
      : "text-content/45 hover:bg-content/8 hover:text-content"
  }`;

/** A textarea that grows like the composer, up to `max-h-40`. */
export function GrowingField({
  label,
  value,
  className,
  placeholder,
  onChange,
}: {
  label: string;
  value: string;
  className: string;
  placeholder?: string;
  onChange(value: string): void;
}) {
  const ref = useRef<HTMLTextAreaElement>(null);
  const lockOverscroll = useLockOverscroll<HTMLTextAreaElement>();
  // Controlled, so one layout effect covers typing and edits from the lead.
  useLayoutEffect(() => {
    if (ref.current) resizeComposer(ref.current);
  }, [value]);
  return (
    <textarea
      ref={(el) => {
        ref.current = el;
        lockOverscroll(el);
      }}
      rows={1}
      aria-label={label}
      placeholder={placeholder}
      className={`${className} max-h-40 resize-none overscroll-none`}
      value={value}
      onChange={(event) => onChange(event.target.value)}
    />
  );
}

export function InlineError({ message }: { message?: string }) {
  if (!message) return null;
  return (
    <p role="alert" className="text-[11px] leading-4 text-red-400">
      {message}
    </p>
  );
}

/** The run brief: shared notes every worker receives. Collapsed by default. */
export function BriefSection({
  brief,
  editable,
  error,
  onChange,
}: {
  brief?: string;
  editable: boolean;
  error?: string;
  onChange(brief: string): void;
}) {
  const [open, setOpen] = useState(false);
  const length = briefLength(brief);
  if (!editable && !length) return null;
  return (
    <div className="border-t border-stroke px-3 py-1.5">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
        className="flex w-full items-center gap-1.5 py-0.5 text-left text-[11px] text-content/45 hover:text-content/70"
      >
        <span>Brief</span>
        <span className="truncate text-content/35">
          {length ? "· shared with every worker" : "· none"}
        </span>
        <span
          className={`ml-auto shrink-0 tabular-nums ${
            length > MAX_ORCHESTRATION_BRIEF ? "text-red-400" : "text-content/35"
          }`}
        >
          {length.toLocaleString()}/{MAX_ORCHESTRATION_BRIEF.toLocaleString()}
        </span>
      </button>
      {open && (
        <div className="space-y-1 pt-1.5 pb-1">
          {editable ? (
            <GrowingField
              label="Run brief"
              value={brief ?? ""}
              placeholder="Conventions, key files and focused check commands every worker needs"
              className={cardField}
              onChange={onChange}
            />
          ) : (
            <p className="whitespace-pre-wrap text-[12px] leading-5 text-content/60">
              {brief}
            </p>
          )}
        </div>
      )}
      <InlineError message={error} />
    </div>
  );
}

/** Work or review, and for a reviewer the work tasks it reads. */
export function TaskKindField({
  task,
  index,
  proposal,
  onKind,
  onReviewOf,
}: {
  task: ProposedTask;
  index: number;
  proposal: Pick<OrchestrationProposal, "tasks">;
  onKind(kind: "work" | "review"): void;
  onReviewOf(ids: string[]): void;
}) {
  const review = task.kind === "review";
  const candidates = reviewCandidates(proposal, task.id);
  return (
    <div className="space-y-1.5">
      <div className="flex items-center gap-2">
        <span className="text-[11px] text-content/45">Kind</span>
        <div
          role="radiogroup"
          aria-label={`Kind of task ${index + 1}`}
          className="flex items-center gap-0.5 rounded-md bg-content/5 p-0.5"
        >
          {(["work", "review"] as const).map((kind) => (
            <button
              key={kind}
              type="button"
              role="radio"
              aria-checked={(kind === "review") === review}
              // Nothing to review in a one-task plan.
              disabled={kind === "review" && !review && !candidates.length}
              onClick={() => onKind(kind)}
              className={`${chip((kind === "review") === review)} disabled:opacity-35`}
            >
              {kind === "work" ? "Work" : "Review"}
            </button>
          ))}
        </div>
      </div>
      {review && (
        <div className="flex flex-wrap items-center gap-1">
          <span className="mr-1 text-[11px] text-content/45">Reviews</span>
          {candidates.map((candidate) => {
            const on = !!task.reviewOf?.includes(candidate.id);
            return (
              <button
                key={candidate.id}
                type="button"
                aria-pressed={on}
                onClick={() =>
                  onReviewOf(
                    on
                      ? (task.reviewOf ?? []).filter((id) => id !== candidate.id)
                      : [...(task.reviewOf ?? []), candidate.id],
                  )
                }
                className={`max-w-48 truncate border border-content/10 ${chip(on)}`}
                title={candidate.title}
              >
                {candidate.title}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

/** Up to five commands the app runs in the worker's checkout after each turn. */
export function TaskChecksField({
  checks,
  index,
  onChange,
}: {
  checks: string[];
  index: number;
  onChange(checks: string[] | undefined): void;
}) {
  const set = (next: string[]) => onChange(next.length ? next : undefined);
  return (
    <div>
      <span className={cardFieldLabel}>
        Checks · run by MonoCode after each turn
      </span>
      <div className="space-y-1">
        {checks.map((command, position) => (
          <div key={position} className="flex items-center gap-1">
            <input
              aria-label={`Check ${position + 1} for task ${index + 1}`}
              className={`${cardField} font-mono text-[11px]`}
              value={command}
              placeholder="npx vitest run src/feature"
              spellCheck={false}
              onChange={(event) =>
                set(
                  checks.map((entry, at) =>
                    at === position ? event.target.value : entry,
                  ),
                )
              }
            />
            <button
              type="button"
              aria-label={`Remove check ${position + 1} for task ${index + 1}`}
              onClick={() => set(checks.filter((_, at) => at !== position))}
              className="grid size-6 shrink-0 place-items-center rounded-md text-content/40 hover:bg-content/8 hover:text-content"
            >
              <X className="size-3" />
            </button>
          </div>
        ))}
        {checks.length < MAX_TASK_CHECKS && (
          <button
            type="button"
            onClick={() => set([...checks, ""])}
            className="flex h-6 items-center gap-1 rounded-md px-1.5 text-[11px] text-content/45 hover:bg-content/8 hover:text-content"
          >
            <Plus className="size-3" />
            Add check
          </button>
        )}
      </div>
    </div>
  );
}

/** Auto-accept and the optional budget, editable while the card is ready. */
export function RunOptions({
  proposal,
  editable,
  hasChecks,
  autoAccept,
  error,
  onSettings,
}: {
  proposal: OrchestrationProposal;
  editable: boolean;
  hasChecks: boolean;
  autoAccept: boolean;
  error?: string;
  onSettings(patch: Partial<OrchestrationProposal["settings"]>): void;
}) {
  const budget = proposal.settings.budget;
  if (!editable) {
    const parts = [
      autoAccept ? "Auto-accept when checks pass" : "",
      budget?.maxMinutes ? `${budget.maxMinutes} min budget` : "",
      budget?.maxWorkerTurns ? `${budget.maxWorkerTurns} turn budget` : "",
    ].filter(Boolean);
    return parts.length ? (
      <div className="border-t border-stroke px-3 py-1.5 text-[11px] text-content/45">
        {parts.join(" · ")}
      </div>
    ) : null;
  }
  const budgetInput = (key: keyof OrchestrationBudget, label: string) => (
    <label className="flex items-center gap-1">
      <input
        type="number"
        min={1}
        step={1}
        inputMode="numeric"
        aria-label={`Budget ${label}`}
        placeholder="–"
        value={budget?.[key] ?? ""}
        onChange={(event) =>
          onSettings({ budget: budgetField(budget, key, event.target.value) })
        }
        className="h-6 w-12 rounded-md border border-content/12 bg-background-base/40 px-1.5 text-right text-[11px] tabular-nums text-content outline-none placeholder:text-content/30 focus:border-content/30"
      />
      <span>{label}</span>
    </label>
  );
  return (
    <div className="space-y-1 border-t border-stroke px-3 py-2 text-[11px] text-content/45">
      <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1.5">
        <button
          type="button"
          role="switch"
          aria-checked={autoAccept}
          disabled={!hasChecks}
          title={
            hasChecks
              ? "Accept each task as soon as all of its checks pass"
              : "Add checks to a task to auto-accept it"
          }
          onClick={() => onSettings({ autoAccept: !autoAccept })}
          className="flex items-center gap-1.5 hover:text-content/70 disabled:cursor-not-allowed disabled:opacity-50"
        >
          <span
            className={`relative h-3.5 w-6 shrink-0 rounded-full transition-colors ${
              autoAccept ? "bg-accent" : "bg-content/20"
            }`}
          >
            <span
              className={`absolute top-0.5 size-2.5 rounded-full bg-white transition-[left] ${
                autoAccept ? "left-3" : "left-0.5"
              }`}
            />
          </span>
          Auto-accept when checks pass
        </button>
        <div className="flex items-center gap-2">
          <span>Budget</span>
          {budgetInput("maxMinutes", "min")}
          {budgetInput("maxWorkerTurns", "turns")}
        </div>
      </div>
      {!hasChecks && (
        <p className="text-content/35">
          Auto-accept needs at least one task with checks.
        </p>
      )}
      <InlineError message={error} />
    </div>
  );
}

/** Name and store the card's current assignments as a reusable template. */
export function SaveTemplateButton({
  proposal,
}: {
  proposal: OrchestrationProposal;
}) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [error, setError] = useState<string>();
  const [saved, setSaved] = useState(false);
  const anchor = useRef<HTMLButtonElement>(null);
  const save = () => {
    try {
      saveOrchestrationTemplate(templateFromProposal(proposal, name));
      setSaved(true);
      setOpen(false);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    }
  };
  return (
    <>
      <button
        type="button"
        ref={anchor}
        aria-expanded={open}
        className={cardSecondary}
        onClick={() => {
          setName(proposal.title);
          setError(undefined);
          setSaved(false);
          setOpen(!open);
        }}
      >
        {saved ? "Saved" : "Save as template"}
      </button>
      {open && (
        <Popover
          anchor={anchor}
          side="bottom"
          align="end"
          width={260}
          onDismiss={() => setOpen(false)}
          data-model-picker
          className="space-y-2 p-2.5"
        >
          <label className="block">
            <span className={cardFieldLabel}>Template name</span>
            <input
              autoFocus
              aria-label="Template name"
              className={cardField}
              value={name}
              maxLength={MAX_TEMPLATE_NAME}
              onChange={(event) => {
                setName(event.target.value);
                setError(undefined);
              }}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  event.stopPropagation();
                  save();
                }
              }}
            />
          </label>
          <p className="text-[11px] leading-4 text-content/45">
            Saves the brief and each task's instructions, model, scope, checks
            and review links. Pick it from the orchestrator pill next time.
          </p>
          <InlineError message={error} />
          <div className="flex justify-end">
            <button
              type="button"
              disabled={!name.trim()}
              onClick={save}
              className="flex h-7 items-center rounded-md bg-content px-2.5 text-[11px] font-medium text-background-base hover:bg-content/80 disabled:opacity-40"
            >
              Save template
            </button>
          </div>
        </Popover>
      )}
    </>
  );
}
