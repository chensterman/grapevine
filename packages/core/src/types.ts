export type RecordStatus = "in_progress" | "done" | "paused" | "abandoned";

export const RECORD_STATUSES: readonly RecordStatus[] = ["in_progress", "done", "paused", "abandoned"];

/** A distilled summary of one coding-agent session, indexed by the code it touched. */
export interface ContextRecord {
  id: string;
  /** `${agent}:${sessionId}`. One record per session, updated as the session continues. */
  sessionKey: string;
  /** Normalized remote, e.g. `github.com/org/repo`, or `local/<dir>` when there is no remote. */
  repo: string;
  branch?: string;
  pr?: string;
  issue?: string;
  author: string;
  agent: string;
  startedAt?: string;
  updatedAt: string;
  task: string;
  /** Repo-relative paths the session changed. */
  paths: string[];
  decisions: string[];
  deadEnds: string[];
  openQuestions: string[];
  status: RecordStatus;
  /** Pointer to the raw transcript on the author's machine. Never uploaded. */
  transcriptRef?: string;
}
