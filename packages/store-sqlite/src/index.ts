import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import {
  type Candidate,
  type ContextRecord,
  normalizePath,
  type RecentQuery,
  type RecordStatus,
  rankCandidates,
  type ScoredRecord,
  type SearchQuery,
  type Store,
} from "@chensterman/grapevine-core";

const SCHEMA_VERSION = 1;
const CANDIDATE_LIMIT = 200;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS records (
  id TEXT PRIMARY KEY,
  session_key TEXT NOT NULL UNIQUE,
  repo TEXT NOT NULL,
  branch TEXT,
  pr TEXT,
  issue TEXT,
  author TEXT NOT NULL,
  agent TEXT NOT NULL,
  started_at TEXT,
  updated_at TEXT NOT NULL,
  task TEXT NOT NULL,
  status TEXT NOT NULL,
  decisions TEXT NOT NULL,
  dead_ends TEXT NOT NULL,
  open_questions TEXT NOT NULL,
  transcript_ref TEXT
);
CREATE INDEX IF NOT EXISTS records_repo_updated ON records (repo, updated_at DESC);
CREATE TABLE IF NOT EXISTS record_paths (
  record_id TEXT NOT NULL REFERENCES records (id) ON DELETE CASCADE,
  path TEXT NOT NULL,
  PRIMARY KEY (record_id, path)
);
CREATE INDEX IF NOT EXISTS record_paths_path ON record_paths (path);
CREATE VIRTUAL TABLE IF NOT EXISTS records_fts USING fts5 (
  record_id UNINDEXED, task, decisions, dead_ends, open_questions, paths
);
PRAGMA user_version = ${SCHEMA_VERSION};
`;

interface RecordRow {
  id: string;
  session_key: string;
  repo: string;
  branch: string | null;
  pr: string | null;
  issue: string | null;
  author: string;
  agent: string;
  started_at: string | null;
  updated_at: string;
  task: string;
  status: string;
  decisions: string;
  dead_ends: string;
  open_questions: string;
  transcript_ref: string | null;
}

/** `packages/core/src/a.ts` -> `packages/core`, `src/a.ts` -> `src`, `a.ts` -> `a.ts`. */
function pathPrefix(path: string): string {
  const segments = path.split("/");
  const depth = Math.max(1, Math.min(2, segments.length - 1));
  return segments.slice(0, depth).join("/");
}

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (char) => `\\${char}`);
}

/** Turns free text into an FTS5 OR-query of quoted tokens, so user input can't break the syntax. */
export function toFtsQuery(text: string): string | null {
  const tokens = [...new Set(text.toLowerCase().match(/[\p{L}\p{N}_]{2,}/gu) ?? [])].slice(0, 16);
  return tokens.length ? tokens.map((token) => `"${token}"`).join(" OR ") : null;
}

class SqliteStore implements Store {
  constructor(private readonly db: Database) {}

  async upsert(record: ContextRecord): Promise<void> {
    this.db.transaction(() => {
      const existing = this.db
        .query<{ id: string }, { sessionKey: string }>("SELECT id FROM records WHERE session_key = $sessionKey")
        .get({ sessionKey: record.sessionKey });
      const id = existing?.id ?? record.id;
      this.db
        .query(
          `INSERT INTO records (id, session_key, repo, branch, pr, issue, author, agent, started_at, updated_at,
             task, status, decisions, dead_ends, open_questions, transcript_ref)
           VALUES ($id, $sessionKey, $repo, $branch, $pr, $issue, $author, $agent, $startedAt, $updatedAt,
             $task, $status, $decisions, $deadEnds, $openQuestions, $transcriptRef)
           ON CONFLICT (id) DO UPDATE SET
             repo = excluded.repo, branch = excluded.branch, pr = excluded.pr, issue = excluded.issue,
             author = excluded.author, agent = excluded.agent, started_at = excluded.started_at,
             updated_at = excluded.updated_at, task = excluded.task, status = excluded.status,
             decisions = excluded.decisions, dead_ends = excluded.dead_ends,
             open_questions = excluded.open_questions, transcript_ref = excluded.transcript_ref`,
        )
        .run({
          id,
          sessionKey: record.sessionKey,
          repo: record.repo,
          branch: record.branch ?? null,
          pr: record.pr ?? null,
          issue: record.issue ?? null,
          author: record.author,
          agent: record.agent,
          startedAt: record.startedAt ?? null,
          updatedAt: record.updatedAt,
          task: record.task,
          status: record.status,
          decisions: JSON.stringify(record.decisions),
          deadEnds: JSON.stringify(record.deadEnds),
          openQuestions: JSON.stringify(record.openQuestions),
          transcriptRef: record.transcriptRef ?? null,
        });

      this.db.query("DELETE FROM record_paths WHERE record_id = $id").run({ id });
      const insertPath = this.db.query("INSERT OR IGNORE INTO record_paths (record_id, path) VALUES ($id, $path)");
      for (const path of record.paths) insertPath.run({ id, path: normalizePath(path) });

      this.db.query("DELETE FROM records_fts WHERE record_id = $id").run({ id });
      this.db
        .query(
          `INSERT INTO records_fts (record_id, task, decisions, dead_ends, open_questions, paths)
           VALUES ($id, $task, $decisions, $deadEnds, $openQuestions, $paths)`,
        )
        .run({
          id,
          task: record.task,
          decisions: record.decisions.join("\n"),
          deadEnds: record.deadEnds.join("\n"),
          openQuestions: record.openQuestions.join("\n"),
          paths: record.paths.join(" "),
        });
    })();
  }

  async get(id: string): Promise<ContextRecord | null> {
    const row = this.db.query<RecordRow, { id: string }>("SELECT * FROM records WHERE id = $id").get({ id });
    return row ? (this.hydrate([row])[0] ?? null) : null;
  }

  async getBySession(sessionKey: string): Promise<ContextRecord | null> {
    const row = this.db
      .query<RecordRow, { sessionKey: string }>("SELECT * FROM records WHERE session_key = $sessionKey")
      .get({ sessionKey });
    return row ? (this.hydrate([row])[0] ?? null) : null;
  }

  async deleteBySession(sessionKey: string): Promise<boolean> {
    return this.db.transaction(() => {
      const row = this.db
        .query<{ id: string }, { sessionKey: string }>("SELECT id FROM records WHERE session_key = $sessionKey")
        .get({ sessionKey });
      if (!row) return false;
      this.db.query("DELETE FROM records_fts WHERE record_id = $id").run({ id: row.id });
      this.db.query("DELETE FROM records WHERE id = $id").run({ id: row.id });
      return true;
    })();
  }

  async recent(query: RecentQuery): Promise<ContextRecord[]> {
    const rows = this.db
      .query<RecordRow, { repo: string | null; limit: number }>(
        "SELECT * FROM records WHERE ($repo IS NULL OR repo = $repo) ORDER BY updated_at DESC LIMIT $limit",
      )
      .all({ repo: query.repo ?? null, limit: query.limit ?? 10 });
    return this.hydrate(rows);
  }

  async search(query: SearchQuery): Promise<ScoredRecord[]> {
    const limit = query.limit ?? 5;
    const paths = (query.paths ?? []).map(normalizePath).filter(Boolean);
    const fts = query.text ? toFtsQuery(query.text) : null;
    const repo = query.repo ?? null;

    if (paths.length === 0 && !fts) {
      const recent = await this.recent({ repo: query.repo, limit: limit + 1 });
      return recent
        .filter((record) => record.sessionKey !== query.excludeSessionKey)
        .slice(0, limit)
        .map((record) => ({ record, score: 1, matchedPaths: [] }));
    }

    const ids = new Set<string>();
    const byPrefix = this.db.query<{ record_id: string }, { like: string; repo: string | null; limit: number }>(
      `SELECT DISTINCT p.record_id FROM record_paths p JOIN records r ON r.id = p.record_id
       WHERE p.path LIKE $like ESCAPE '\\' AND ($repo IS NULL OR r.repo = $repo)
       ORDER BY r.updated_at DESC LIMIT $limit`,
    );
    for (const prefix of new Set(paths.map(pathPrefix))) {
      for (const row of byPrefix.all({ like: `${escapeLike(prefix)}%`, repo, limit: CANDIDATE_LIMIT })) {
        ids.add(row.record_id);
      }
    }

    const textScores = new Map<string, number>();
    if (fts) {
      const rows = this.db
        .query<{ record_id: string; rank: number }, { fts: string; repo: string | null; limit: number }>(
          `SELECT records_fts.record_id AS record_id, bm25(records_fts) AS rank
           FROM records_fts JOIN records r ON r.id = records_fts.record_id
           WHERE records_fts MATCH $fts AND ($repo IS NULL OR r.repo = $repo)
           ORDER BY rank LIMIT $limit`,
        )
        .all({ fts, repo, limit: CANDIDATE_LIMIT });
      const best = rows[0]?.rank ?? 0;
      for (const row of rows) {
        ids.add(row.record_id);
        textScores.set(row.record_id, best < 0 ? row.rank / best : 1);
      }
    }

    const records = this.loadMany([...ids]).filter((record) => record.sessionKey !== query.excludeSessionKey);
    const candidates: Candidate[] = records.map((record) => ({ record, textScore: textScores.get(record.id) ?? 0 }));
    return rankCandidates(candidates, paths).slice(0, limit);
  }

  close(): void {
    this.db.close();
  }

  private loadMany(ids: string[]): ContextRecord[] {
    if (ids.length === 0) return [];
    const placeholders = ids.map(() => "?").join(", ");
    const rows = this.db.query<RecordRow, string[]>(`SELECT * FROM records WHERE id IN (${placeholders})`).all(...ids);
    return this.hydrate(rows);
  }

  private hydrate(rows: RecordRow[]): ContextRecord[] {
    if (rows.length === 0) return [];
    const placeholders = rows.map(() => "?").join(", ");
    const pathRows = this.db
      .query<{ record_id: string; path: string }, string[]>(
        `SELECT record_id, path FROM record_paths WHERE record_id IN (${placeholders}) ORDER BY path`,
      )
      .all(...rows.map((row) => row.id));
    const pathsById = new Map<string, string[]>();
    for (const { record_id, path } of pathRows) {
      pathsById.set(record_id, [...(pathsById.get(record_id) ?? []), path]);
    }
    return rows.map((row) => ({
      id: row.id,
      sessionKey: row.session_key,
      repo: row.repo,
      branch: row.branch ?? undefined,
      pr: row.pr ?? undefined,
      issue: row.issue ?? undefined,
      author: row.author,
      agent: row.agent,
      startedAt: row.started_at ?? undefined,
      updatedAt: row.updated_at,
      task: row.task,
      paths: pathsById.get(row.id) ?? [],
      decisions: JSON.parse(row.decisions) as string[],
      deadEnds: JSON.parse(row.dead_ends) as string[],
      openQuestions: JSON.parse(row.open_questions) as string[],
      status: row.status as RecordStatus,
      transcriptRef: row.transcript_ref ?? undefined,
    }));
  }
}

export function openSqliteStore(path: string): Store {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path, { create: true, strict: true });
  db.exec("PRAGMA busy_timeout = 5000; PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;");
  db.exec(SCHEMA);
  return new SqliteStore(db);
}
