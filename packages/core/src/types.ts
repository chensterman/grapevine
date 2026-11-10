export type RecordStatus = "in_progress" | "done" | "paused" | "abandoned";

export const RECORD_STATUSES: readonly RecordStatus[] = ["in_progress", "done", "paused", "abandoned"];

/** One decision, dead end, or open question. */
export interface RecordItem {
  text: string;
  /** Repo-relative files the item is about, drawn from the record's paths. */
  paths: string[];
}

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
  decisions: RecordItem[];
  deadEnds: RecordItem[];
  openQuestions: RecordItem[];
  status: RecordStatus;
  /** HEAD when the record was last captured, used to flag files that changed since. */
  commit?: string;
  /** Pointer to the raw transcript on the author's machine. Never uploaded. */
  transcriptRef?: string;
}
