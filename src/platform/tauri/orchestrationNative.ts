import { invoke } from "@tauri-apps/api/core";

/** Outcome of one acceptance check run by the app inside a worker checkout. */
export type CheckRunResult = {
  /** Null when the process was killed (timeout) or ended by a signal. */
  exitCode: number | null;
  /** Combined stdout and stderr, keeping only the tail. */
  output: string;
  timedOut: boolean;
  durationMs: number;
};

/** Run a shell command in `cwd`; the native side caps concurrent checks. */
export const runOrchestrationCheck = (input: {
  cwd: string;
  command: string;
  timeoutMs: number;
  scratchDir?: string;
}) => invoke<CheckRunResult>("orchestration_run_check", input);

export type WorkerPatchFile = {
  relative: string;
  status: string;
  additions: number;
  deletions: number;
  binary: boolean;
};

export type WorkerPatch = {
  files: WorkerPatchFile[];
  /** Unified diff of the session's changes, cut at `maxBytes`. */
  patch: string;
  truncated: boolean;
};

/** Changes a worker session made in `root`, relative to its checkpoint baseline. */
export const sessionCheckpointPatch = (
  sessionId: string,
  root: string,
  maxBytes: number,
) =>
  invoke<WorkerPatch>("session_checkpoint_patch", { sessionId, root, maxBytes });
