import type { ContextRecord } from "./types.ts";

export interface SearchQuery {
  /** Omit to search every repo. */
  repo?: string;
  /** Repo-relative paths the caller is about to work on. */
  paths?: string[];
  text?: string;
  excludeSessionKey?: string;
  limit?: number;
}

export interface RecentQuery {
  repo?: string;
  limit?: number;
}

export interface ScoredRecord {
  record: ContextRecord;
  score: number;
  matchedPaths: string[];
}

/** Storage backend. Async so remote backends (HTTP server, git sync) fit the same interface. */
export interface Store {
  /** Inserts or replaces the record for `record.sessionKey`, keeping the existing id. */
  upsert(record: ContextRecord): Promise<void>;
  get(id: string): Promise<ContextRecord | null>;
  getBySession(sessionKey: string): Promise<ContextRecord | null>;
  search(query: SearchQuery): Promise<ScoredRecord[]>;
  recent(query: RecentQuery): Promise<ContextRecord[]>;
  close(): void;
}
