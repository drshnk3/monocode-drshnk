import type {
  CheckResult,
  OrchestrationTask,
  WorkerChange,
  WorkerCheck,
  WorkerReport,
} from "./orchestrationState";

const RESULT_BLOCK = /<monocode_result\b[^>]*>([\s\S]*?)<\/monocode_result>/gi;
/** A block plus a Markdown fence wrapped directly around it, for stripping. */
const FENCED_RESULT_BLOCK =
  /(?:\r?\n[ \t]*)*(?:```[\w-]*[ \t]*\r?\n[ \t]*)?<monocode_result\b[^>]*>[\s\S]*?<\/monocode_result>(?:[ \t]*\r?\n[ \t]*```)?/gi;

const MAX_SUMMARY = 4000;
const MAX_ENTRY = 512;
const MAX_NOTE = 1000;
const MAX_FILES = 200;
const MAX_ITEMS = 32;
/** Changed-file entries kept per task; the full list remains available through diff. */
export const MAX_RECORDED_CHANGES = 500;

const STATUSES = new Set<WorkerReport["status"]>([
  "done",
  "partial",
  "blocked",
]);

const clip = (value: string, max: number) =>
  value.length > max ? `${value.slice(0, max - 1)}…` : value;

function entries(value: unknown, max: number, length: number): string[] {
  if (!Array.isArray(value)) return [];
  return [
    ...new Set(
      value
        .filter((item): item is string => typeof item === "string")
        .map((item) => item.trim())
        .filter(Boolean)
        .map((item) => clip(item, length)),
    ),
  ].slice(0, max);
}

function checks(value: unknown): WorkerCheck[] {
  if (!Array.isArray(value)) return [];
  return value
    .flatMap((item): WorkerCheck[] => {
      if (!item || typeof item !== "object") return [];
      const check = item as Record<string, unknown>;
      if (typeof check.command !== "string" || !check.command.trim()) return [];
      if (typeof check.passed !== "boolean") return [];
      const note =
        typeof check.note === "string" && check.note.trim()
          ? clip(check.note.trim(), MAX_NOTE)
          : undefined;
      return [
        {
          command: clip(check.command.trim(), MAX_ENTRY),
          passed: check.passed,
          ...(note ? { note } : {}),
        },
      ];
    })
    .slice(0, MAX_ITEMS);
}

/** Parse one block's body, tolerating a Markdown fence or text around the JSON. */
function parseBody(body: string): WorkerReport | undefined {
  const unfenced = body
    .trim()
    .replace(/^```[\w-]*\s*/, "")
    .replace(/\s*```$/, "");
  const start = unfenced.indexOf("{");
  const end = unfenced.lastIndexOf("}");
  if (start < 0 || end <= start) return undefined;
  let input: unknown;
  try {
    input = JSON.parse(unfenced.slice(start, end + 1));
  } catch {
    return undefined;
  }
  if (!input || typeof input !== "object" || Array.isArray(input))
    return undefined;
  const value = input as Record<string, unknown>;
  const status =
    typeof value.status === "string" ? value.status.trim().toLowerCase() : "";
  if (!STATUSES.has(status as WorkerReport["status"])) return undefined;
  if (typeof value.summary !== "string" || !value.summary.trim())
    return undefined;
  const followUps = entries(value.followUps, MAX_ITEMS, MAX_NOTE);
  return {
    status: status as WorkerReport["status"],
    summary: clip(value.summary.trim(), MAX_SUMMARY),
    changedFiles: entries(value.changedFiles, MAX_FILES, MAX_ENTRY),
    checks: checks(value.checks),
    blockers: entries(value.blockers, MAX_ITEMS, MAX_NOTE),
    ...(followUps.length ? { followUps } : {}),
  };
}

/**
 * Split a worker's final message into its structured report and the readable
 * text. Only the last block counts: earlier ones may be drafts or quotes. When
 * that block is missing or malformed the text is returned unchanged, so the
 * lead still sees what the worker wrote.
 */
export function parseWorkerReport(text: string): {
  report?: WorkerReport;
  text: string;
} {
  const blocks = [...text.matchAll(RESULT_BLOCK)];
  const last = blocks[blocks.length - 1];
  const report = last ? parseBody(last[1]) : undefined;
  if (!report) return { text };
  return { report, text: text.replace(FENCED_RESULT_BLOCK, "").trimEnd() };
}

const fileKey = (path: string) =>
  path.trim().replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/+$/, "");

/**
 * Where the worker's own changedFiles disagree with the files its session
 * actually changed. Undefined when they agree or either side is unknown.
 */
export function changeMismatch(
  task: Pick<OrchestrationTask, "report" | "changes">,
): { unreported: string[]; unchanged: string[] } | undefined {
  if (!task.report || !task.changes) return undefined;
  const reported = new Set(task.report.changedFiles.map(fileKey));
  const actual = new Set(
    task.changes.map((change) => fileKey(change.relative)),
  );
  const unreported = [...actual].filter((path) => !reported.has(path));
  const unchanged = [...reported].filter((path) => !actual.has(path));
  return unreported.length || unchanged.length
    ? { unreported, unchanged }
    : undefined;
}

const listed = (values: string[], max = 20) =>
  values.length > max
    ? `${values.slice(0, max).join(", ")} (+${values.length - max} more)`
    : values.join(", ");

const changeLine = (change: WorkerChange) =>
  `${change.relative} (${change.status} +${change.additions}/-${change.deletions})`;

/** A hint the lead can act on when a report and the checkout disagree. */
export function mismatchHint(
  task: Pick<OrchestrationTask, "report" | "changes">,
): string | undefined {
  const mismatch = changeMismatch(task);
  if (!mismatch) return undefined;
  return [
    "The worker's reported changedFiles differ from the files it actually changed",
    mismatch.unreported.length
      ? `; changed but not reported: ${listed(mismatch.unreported)}`
      : "",
    mismatch.unchanged.length
      ? `; reported but unchanged: ${listed(mismatch.unchanged)}`
      : "",
    ". Inspect the patch with diff before accepting it.",
  ].join("");
}

/** Failure output shown inline in a wake-up; get returns each full tail. */
const WAKE_CHECK_OUTPUT = 1500;

const seconds = (ms: number) => `${Math.max(0, Math.round(ms / 1000))}s`;

/** "passed `npm test` (12s)" or "FAILED `tsc` (exit 2, 4s)". */
export function checkResultLine(check: CheckResult): string {
  const how = check.timedOut
    ? `timed out after ${seconds(check.durationMs)}`
    : check.exitCode === null
      ? `no exit code, ${seconds(check.durationMs)}`
      : `exit ${check.exitCode}, ${seconds(check.durationMs)}`;
  return check.passed
    ? `passed \`${check.command}\` (${seconds(check.durationMs)})`
    : `FAILED \`${check.command}\` (${how})`;
}

/** A review task's report read as a verdict on the tasks it reviewed. */
export function reviewVerdict(
  task: Pick<OrchestrationTask, "status" | "report">,
): "approved" | "changes requested" | "no verdict" | undefined {
  if (task.status !== "completed") return undefined;
  if (!task.report) return "no verdict";
  return task.report.status === "done" ? "approved" : "changes requested";
}

/** App-run checks and what the app did with the result, for the lead. */
function checkLines(task: OrchestrationTask): string[] {
  const lines: string[] = [];
  const results = task.checkResults;
  if (results?.length) {
    const retries = task.checkRetries ?? 0;
    lines.push(
      `App-run checks${retries ? ` after ${retries} automatic fix turn${retries === 1 ? "" : "s"}` : ""}: ${results.map(checkResultLine).join("; ")}`,
    );
    for (const failed of results.filter((check) => !check.passed)) {
      const tail = failed.outputTail.slice(-WAKE_CHECK_OUTPUT).trim();
      if (tail) lines.push(`Output of \`${failed.command}\`:\n${tail}`);
    }
  }
  if (task.autoAccepted)
    lines.push(
      "Auto-accepted: its checks passed, so MonoCode integrated it into the lead checkout. Dependent tasks can start; no review is needed unless you want to inspect it.",
    );
  if (task.autoAcceptError)
    lines.push(
      `Auto-accept failed: ${task.autoAcceptError}. It is still completed and unaccepted: inspect it with diff, then accept it with review or send corrections with message.`,
    );
  return lines;
}

/**
 * Compact plain-text result for a lead wake-up: the structured report when
 * there is one, otherwise a short tail of the worker's text.
 */
export function leadResultText(
  task: OrchestrationTask,
  tailChars: number,
): string {
  const verdict = task.kind === "review" ? reviewVerdict(task) : undefined;
  const lines = [
    `${task.id} — ${task.title}: ${task.status}${verdict ? ` (review: ${verdict})` : ""}`,
  ];
  if (task.kind === "review" && task.reviewOf?.length)
    lines.push(`Reviewed tasks: ${task.reviewOf.join(", ")}`);
  if (task.error) lines.push(`Error: ${task.error}`);
  const report = task.report;
  if (report) {
    lines.push(`Report (${report.status}): ${report.summary}`);
    if (task.changes)
      lines.push(
        `Changed files: ${task.changes.length ? listed(task.changes.map(changeLine)) : "none"}`,
      );
    else if (report.changedFiles.length)
      lines.push(`Reported changed files: ${listed(report.changedFiles)}`);
    if (report.checks.length)
      lines.push(
        `Checks: ${report.checks
          .map(
            (check) =>
              `${check.passed ? "passed" : "FAILED"} \`${check.command}\`${check.note ? ` (${check.note})` : ""}`,
          )
          .join("; ")}`,
      );
    else lines.push("Checks: none reported");
    if (report.blockers.length)
      lines.push(`Blockers: ${report.blockers.join("; ")}`);
    if (report.followUps?.length)
      lines.push(`Follow-ups: ${report.followUps.join("; ")}`);
    const hint = mismatchHint(task);
    if (hint) lines.push(hint);
  } else {
    if (task.changes)
      lines.push(
        `Changed files: ${task.changes.length ? listed(task.changes.map(changeLine)) : "none"}`,
      );
    const tail = task.result.slice(-tailChars).trim();
    if (tail) lines.push(`No structured report. End of its reply:\n${tail}`);
  }
  lines.push(...checkLines(task));
  return lines.join("\n");
}

/**
 * The result fields of a task as the lead reads them through the CLI: the
 * report replaces the raw text, which is only included as a short tail when
 * the worker gave no report.
 */
export function leadResultFields(task: OrchestrationTask, tailChars: number) {
  const hint = mismatchHint(task);
  return task.report
    ? {
        result: undefined,
        report: task.report,
        changes: task.changes,
        ...(hint ? { changeMismatch: hint } : {}),
      }
    : {
        result: task.result.slice(-tailChars),
        report: undefined,
        changes: task.changes,
      };
}
