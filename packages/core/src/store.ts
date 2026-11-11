import type { ContextRecord } from "./types.ts";

export interface SearchQuery {
  /** Omit to search every repo. */
  repos?: string[];
  /** Repo-relative paths the caller is about to work on. */
  paths?: string[];
  text?: string;
  excludeSessionKey?: string;
  limit?: number;
}

export interface RecentQuery {
  /** Omit to list every repo. */
  repos?: string[];
  limit?: number;
}

export interface ScoredRecord {
  record: ContextRecord;
  score: number;
  matchedPaths: string[];
}

/** Storage backend. Async so remote backends (HTTP server, git sync) fit the same interface. */
export interface Store {
  /** Inserts or replaces the record for `record.sessionKey` in `record.repo`, keeping the existing id. */
  upsert(record: ContextRecord): Promise<void>;
  get(id: string): Promise<ContextRecord | null>;
  /** A session has one record per repo it changed. */
  listBySession(sessionKey: string): Promise<ContextRecord[]>;
  /** Returns whether the record existed. */
  delete(id: string): Promise<boolean>;
  /** Removes every record for a session. Returns whether any existed. */
  deleteBySession(sessionKey: string): Promise<boolean>;
  search(query: SearchQuery): Promise<ScoredRecord[]>;
  recent(query: RecentQuery): Promise<ContextRecord[]>;
  close(): void;
}
