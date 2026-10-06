import { useContext, useEffect, useState, useSyncExternalStore } from "react";
import { findModel } from "../../sessions/model/models";
import { busyTask, orchestrator } from "../model/orchestration";
import {
  budgetPauseDetail,
  checkSummary,
  orchestrationTaskLabel,
  orchestrationTaskTone,
  runUsageLine,
  taskReviews,
  taskUsageText,
  type OrchestrationSummary,
  type TaskTone,
} from "../model/orchestrationSummary";
import type { OrchestrationTask } from "../model/orchestrationState";
import { HARNESS_TITLE } from "../../sessions/model/session";
import { HarnessIcon } from "../../sessions/ui/HarnessIcon";
import {
  OrchestrationActions,
  OrchestrationWorkers,
} from "./OrchestrationActions";
import { Check, ChevronDown, ChevronRight, CircleAlert } from "../../../shared/ui/icons";
import { TerminalSpinner } from "../../sessions/ui/TerminalSpinner";

const TONE_CLASS: Record<TaskTone, string> = {
  attention: "text-amber-400",
  active: "text-accent",
  done: "text-emerald-400",
  idle: "text-content/45",
};

/** Checks, reviews, acceptance and usage of one live task, in a few lines. */
function TaskOutcome({
  task,
  reviews,
}: {
  task: OrchestrationTask;
  reviews: ReturnType<typeof taskReviews>;
}) {
  const [output, setOutput] = useState(false);
  const checks = checkSummary(task.checkResults);
  const usage = taskUsageText(task);
  const failing = checks?.failing ?? [];
  const retries = task.checkRetries ? (
    <span className="text-content/35">
      · {task.checkRetries} fix {task.checkRetries === 1 ? "turn" : "turns"}
    </span>
  ) : null;
  if (
    !checks &&
    !usage &&
    !reviews.length &&
    !task.autoAccepted &&
    !task.autoAcceptError
  )
    return null;
  return (
    <div className="space-y-1 text-[11px] leading-4 text-content/45">
      {checks && (
        <div>
          {failing.length ? (
            <button
              type="button"
              aria-expanded={output}
              title={`Failing: ${failing.map((check) => check.command).join(", ")}`}
              onClick={() => setOutput(!output)}
              className="flex items-center gap-1 text-amber-400 hover:text-amber-300"
            >
              <CircleAlert className="size-3" strokeWidth={1.75} />
              <span>{checks.label}</span>
              {retries}
            </button>
          ) : (
            <p
              className="flex items-center gap-1"
              title={task.checkResults?.map((check) => check.command).join("\n")}
            >
              <Check className="size-3" strokeWidth={2.25} />
              <span>{checks.label}</span>
              {retries}
            </p>
          )}
          {output &&
            failing.map((check) => (
              <div key={check.command} className="mt-1">
                <code className="block truncate font-mono text-content/60">
                  {check.command}
                  {check.timedOut
                    ? " · timed out"
                    : check.exitCode != null
                      ? ` · exit ${check.exitCode}`
                      : ""}
                </code>
                {check.outputTail.trim() && (
                  <pre className="mt-0.5 max-h-32 overflow-auto whitespace-pre-wrap break-words rounded bg-content/5 p-1.5 font-mono text-[10px] leading-4 text-content/55">
                    {check.outputTail.trim().slice(-1500)}
                  </pre>
                )}
              </div>
            ))}
        </div>
      )}
      {reviews.map((review) => (
        <p
          key={review.sessionId}
          className={
            review.verdict === "approved"
              ? "text-emerald-400"
              : review.verdict === "changes requested"
                ? "text-amber-400"
                : undefined
          }
        >
          {review.title} ·{" "}
          {review.verdict
            ? review.verdict === "approved"
              ? "Approved"
              : review.verdict === "changes requested"
                ? "Changes requested"
                : "No verdict"
            : "Reviewing"}
        </p>
      ))}
      {task.autoAccepted && <p className="text-emerald-400">Auto-accepted</p>}
      {task.autoAcceptError && (
        <p className="text-amber-400">
          Auto-accept failed: {task.autoAcceptError}
        </p>
      )}
      {usage && <p className="tabular-nums">{usage}</p>}
    </div>
  );
}

export function OrchestrationSidebarAgents({
  leadId,
  summary,
}: {
  leadId: string;
  summary: OrchestrationSummary;
}) {
  const actions = useContext(OrchestrationActions);
  const workers = useContext(OrchestrationWorkers);
  const runs = useSyncExternalStore(
    orchestrator.subscribe,
    orchestrator.snapshot,
    orchestrator.snapshot,
  );
  const [error, setError] = useState<string>();
  const [pending, setPending] = useState(false);
  // Rows expand independently, so several agents can be watched side by side.
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  // Revealing a worker from its toast opens that row without closing others.
  const revealed = workers.selectedId;
  useEffect(() => {
    if (revealed)
      setExpanded((current) =>
        current.has(revealed) ? current : new Set(current).add(revealed),
      );
  }, [revealed]);
  const toggle = (sessionId: string, isOpen: boolean) => {
    setExpanded((current) => {
      const next = new Set(current);
      if (isOpen) next.delete(sessionId);
      else next.add(sessionId);
      return next;
    });
    if (isOpen && revealed === sessionId) workers.inspect(null);
  };
  // A saved run has no live entry, so the card stays read-only after a reload.
  const run = runs.find((entry) => entry.leadId === leadId);
  // Checks hold the task's scope too, so they count as work still running.
  const stopping = !!run?.tasks.some(busyTask);
  const budgetDetail = run ? budgetPauseDetail(run) : undefined;
  const usageLine = run ? runUsageLine(run) : undefined;
  const resumeBlocker =
    run?.status === "paused" ? orchestrator.resumeBlocker(leadId) : undefined;
  const leadBusy =
    run?.status === "paused" && orchestrator.resumeLeadBusy(leadId);
  const perform = async (operation: () => Promise<void>) => {
    setPending(true);
    setError(undefined);
    try {
      await operation();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setPending(false);
    }
  };
  const done = summary.tasks.filter(
    (task) => task.status === "completed",
  ).length;
  const action =
    "rounded px-1.5 py-0.5 text-[11px] text-content/55 hover:bg-content/10 hover:text-content disabled:opacity-35";
  // Sits inside an already-lit row, so it needs its own surface to read as a
  // button rather than as another line of text.
  const solidAction =
    "rounded bg-content/15 px-1.5 py-0.5 text-[11px] text-content/75 hover:bg-content/25 hover:text-content disabled:opacity-35";
  return (
    <div className="relative mt-1.5">
      <div className="mb-0.5 px-0.5 flex items-center justify-between text-[11px] text-content/45">
        <span>
          {summary.tasks.length}{" "}
          {summary.tasks.length === 1 ? "agent" : "agents"}
        </span>
        <span className="tabular-nums">
          {done}/{summary.tasks.length} done
        </span>
      </div>
      {/*
        Offset by the rows' own padding so a chevron lands on the card's
        content edge, under the harness icon of the header above.

        No height cap and no scroller: the card grows with whatever the user
        expanded, and the sidebar it sits in does the only scrolling. Nesting
        a second scroll region here made rows clip mid-line.
      */}
      <div
        aria-label="Orchestrated agents"
        className="-mx-2 flex touch-pan-y flex-col gap-px"
        onPointerDown={(event) => event.stopPropagation()}
        onClick={(event) => event.stopPropagation()}
      >
        {summary.tasks.map((task) => {
          // Something waiting on an answer opens itself; it cannot be missed.
          const open = expanded.has(task.sessionId) || !!task.needsInput;
          const live = run?.tasks.find(
            (entry) => entry.sessionId === task.sessionId,
          );
          const label = orchestrationTaskLabel(task, summary);
          const tone = orchestrationTaskTone(task, summary);
          const working = tone === "active";
          // A saved provider model may not be in this window's catalog yet.
          // Keep its identity instead of substituting the harness default.
          const model = findModel(task.model)?.name ?? task.model;
          return (
            <div
              key={task.sessionId}
              data-orchestration-agent={task.sessionId}
              // Expanding lights the whole row, header and detail together.
              className={`rounded-md ${open ? "bg-selection" : ""}`}
            >
              <button
                type="button"
                title={`${task.title} · ${HARNESS_TITLE[task.harness]} · ${model} · ${label}`}
                aria-label={`Agent details: ${task.title}`}
                aria-expanded={open}
                onClick={() => toggle(task.sessionId, open)}
                // Named, because the whole session card is already a `group`.
                className={`group/agent flex w-full min-w-0 items-center gap-1.5 rounded-md px-2 py-1.5 text-left ${
                  open ? "" : "hover:bg-content/10"
                }`}
              >
                {/* One slot: the chevron stands in for the harness mark
                    whenever this row is open or under the pointer. */}
                <span className="grid size-3.5 shrink-0 place-items-center text-content/45">
                  {open ? (
                    <ChevronDown className="size-3" strokeWidth={1.75} />
                  ) : (
                    <>
                      <HarnessIcon
                        harness={task.harness}
                        className="size-3.5 opacity-75 group-focus-visible/agent:hidden group-hover/agent:hidden"
                      />
                      <ChevronRight
                        className="hidden size-3 group-focus-visible/agent:block group-hover/agent:block"
                        strokeWidth={1.75}
                      />
                    </>
                  )}
                </span>
                <span className="min-w-0 flex-1 truncate text-[12px] leading-snug text-content/80">
                  {task.title}
                </span>
                <span
                  className={`flex shrink-0 items-center gap-1 text-[11px] ${TONE_CLASS[tone]}`}
                >
                  {tone === "attention" ? (
                    <CircleAlert className="size-3" strokeWidth={1.75} />
                  ) : working ? (
                    <TerminalSpinner className="inline-block w-3 select-none text-center text-[11px] leading-none text-accent" />
                  ) : task.status === "completed" ? (
                    <Check className="size-3" strokeWidth={2.25} />
                  ) : null}
                  <span>{label}</span>
                </span>
              </button>
              {/* Indented to the title's column: the icon slot and its gap. */}
              {open && (
                <div className="space-y-2 pb-3 pl-6.5 pr-2">
                  <p
                    className="flex min-w-0 items-center gap-1.5 text-[11px] text-content/45"
                    title={`${model} · ${HARNESS_TITLE[task.harness]}`}
                  >
                    <HarnessIcon
                      harness={task.harness}
                      className="size-3.5 shrink-0"
                    />
                    <span className="min-w-0 truncate">{model}</span>
                  </p>
                  {live?.error && (
                    <p className="text-[11px] text-red-400">{live.error}</p>
                  )}
                  {live && run && (
                    <TaskOutcome
                      task={live}
                      reviews={taskReviews(run, live.id)}
                    />
                  )}
                  <div className="flex flex-wrap items-center gap-1">
                    {workers.openDetails && (
                      <button
                        type="button"
                        title="Open this agent beside the orchestrator"
                        className={solidAction}
                        onClick={() =>
                          workers.openDetails?.({
                            sessionId: task.sessionId,
                            leadId,
                            title: task.title,
                            harness: task.harness,
                          })
                        }
                      >
                        See details
                      </button>
                    )}
                    {live && ["queued", "running"].includes(live.status) && (
                      <button
                        type="button"
                        className={solidAction}
                        disabled={pending}
                        onClick={() =>
                          void perform(() =>
                            orchestrator.cancelTask(leadId, live.id),
                          )
                        }
                      >
                        Cancel task
                      </button>
                    )}
                  </div>
                </div>
              )}
            </div>
          );
        })}
      </div>
      {usageLine && (
        <p
          className="px-0.5 pt-1 text-[11px] tabular-nums text-content/40"
          title="Run time · worker turns, including automatic check fixes · provider-reported tokens"
        >
          {usageLine}
        </p>
      )}
      {(error || (run?.error && !budgetDetail)) && (
        <p role="alert" className="py-1 text-[11px] text-red-400">
          {error ?? run?.error}
        </p>
      )}
      {/* Stopping a run belongs to the composer, which stops the lead and its
          agents together. Resume has no other home, so it stays. */}
      {run?.status === "paused" && (
        <div className="mt-1.5 space-y-1.5 border-t border-stroke pt-1.5">
          {budgetDetail && (
            <p className="px-0.5 text-[11px] leading-relaxed text-amber-400">
              Budget reached: {budgetDetail}.
            </p>
          )}
          <p className="px-0.5 text-[11px] leading-relaxed text-content/45">
            {stopping
              ? "Stopping interrupted work before this run can resume."
              : leadBusy
                ? "Waiting for the lead's interrupted turn to finish before this run can resume."
                : budgetDetail
                  ? "Resume grants the same budget again from here and continues interrupted and queued work."
                  : "Resume continues interrupted workers from their retained checkouts and starts queued work. Policy-blocked tasks stay stopped for review."}
          </p>
          {resumeBlocker && (
            <p className="px-0.5 text-[11px] leading-relaxed text-amber-400">
              {resumeBlocker.title || "Another conversation"} is still running
              in this project.
            </p>
          )}
          <div className="-mr-1.5 flex items-center justify-end gap-1">
            {resumeBlocker && actions && (
              <button
                type="button"
                className={action}
                disabled={pending}
                onClick={() => actions.open(resumeBlocker.id)}
              >
                Open blocker
              </button>
            )}
            <button
              type="button"
              className={action}
              disabled={pending || stopping || leadBusy || !!resumeBlocker}
              title={
                stopping
                  ? "Wait for interrupted agents to stop"
                  : leadBusy
                    ? "Wait for the lead's interrupted turn to finish"
                    : resumeBlocker
                      ? `Stop ${resumeBlocker.title || "the other conversation"} before resuming`
                      : "Continue interrupted and queued work"
              }
              onClick={() =>
                void perform(() =>
                  orchestrator.start(
                    leadId,
                    run.allowedHarnesses,
                    run.maxWorkers,
                  ),
                )
              }
            >
              Resume
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
