import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { z } from "zod";
import type { SyncConfig } from "./config.ts";
import type { Store } from "./store.ts";
import { type ContextRecord, RECORD_STATUSES, type RecordStatus } from "./types.ts";

/** A record as it leaves the machine: everything but the pointer to the local transcript. */
export type SharedRecord = Omit<ContextRecord, "transcriptRef">;

export interface RemoteEntry {
  id: string;
  /** Any string that changes when the record does, like a content hash or an update time. */
  version: string;
}

/**
 * A shared place that keeps a team's records: a server, a git repo, a document store. Search and ranking
 * stay on each machine's local store, so a target only has to keep records and hand them back.
 */
export interface SyncTarget {
  /** Stores the record under `record.id`, replacing any earlier version. */
  put(record: SharedRecord): Promise<void>;
  /** Removes the record. Removing one the target does not hold is not an error. */
  remove(id: string): Promise<void>;
  /** Every record the target holds now. */
  list(): Promise<RemoteEntry[]>;
  /** The record, or null when the target does not hold it. */
  get(id: string): Promise<SharedRecord | null>;
}

/** What a sync target module exports as `createSyncTarget`. `options` is `sync.options` from the config. */
export type CreateSyncTarget = (
  options: Record<string, unknown>,
  context: { home: string },
) => SyncTarget | Promise<SyncTarget>;

/**
 * Loads the module named by `sync.target`: a file path (absolute, `~/…`, or `./…` from the grapevine
 * home), or the name of a package installed where grapevine can import it.
 */
export async function loadSyncTarget(config: SyncConfig, home: string): Promise<SyncTarget> {
  const spec = config.target;
  const path = spec.startsWith("~/") ? join(homedir(), spec.slice(2)) : spec.startsWith(".") ? resolve(home, spec) : spec;
  const module = (await import(isAbsolute(path) ? pathToFileURL(path).href : path)) as { createSyncTarget?: unknown };
  if (typeof module.createSyncTarget !== "function") {
    throw new Error(`Sync target "${spec}" does not export a createSyncTarget function`);
  }
  return (module.createSyncTarget as CreateSyncTarget)(config.options ?? {}, { home });
}

const ItemSchema = z.object({ text: z.string(), paths: z.array(z.string()) });

const SharedRecordSchema = z.object({
  id: z.string().min(1),
  sessionKey: z.string().min(1),
  repo: z.string().min(1),
  branch: z.string().optional(),
  pr: z.string().optional(),
  issue: z.string().optional(),
  author: z.string(),
  agent: z.string(),
  startedAt: z.string().optional(),
  updatedAt: z.string(),
  task: z.string(),
  paths: z.array(z.string()),
  readPaths: z.array(z.string()).optional(),
  decisions: z.array(ItemSchema),
  deadEnds: z.array(ItemSchema),
  openQuestions: z.array(ItemSchema),
  pending: z.array(ItemSchema),
  status: z.enum(RECORD_STATUSES as [RecordStatus, ...RecordStatus[]]),
  commit: z.string().optional(),
});

/** Checks a record that came from outside this machine and drops fields grapevine does not know. Throws when it is malformed. */
export function parseSharedRecord(value: unknown): SharedRecord {
  return SharedRecordSchema.parse(value);
}

export type SyncOp = "put" | "remove";

export interface QueuedChange {
  id: string;
  op: SyncOp;
  queuedAt: string;
  attempts: number;
  /** Why the last attempt failed. */
  error?: string;
}

interface Seen {
  /** When a pull was last started, whether or not it finished. */
  triedAt?: string;
  pulledAt?: string;
  /** The version of each record pulled from the target. */
  versions: Record<string, string>;
}

/** Where sync keeps its state: the changes waiting to be pushed and what it has seen of the target. */
export function syncDir(home: string): string {
  return join(home, "sync");
}

const queueFile = (dir: string, id: string) => join(dir, "outbox", `${encodeURIComponent(id)}.json`);
const ownFile = (dir: string) => join(dir, "own.json");
const seenFile = (dir: string) => join(dir, "seen.json");

function readJson<T>(path: string, fallback: T): T {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch {
    return fallback;
  }
}

/** Writes through a rename, so another process never reads half a file. */
function writeJson(path: string, value: unknown): void {
  const temp = `${path}.${process.pid}.tmp`;
  writeFileSync(temp, JSON.stringify(value));
  renameSync(temp, path);
}

const readSeen = (dir: string): Seen => ({ versions: {}, ...readJson<Partial<Seen>>(seenFile(dir), {}) });

function writeSeen(dir: string, seen: Seen): void {
  mkdirSync(dir, { recursive: true });
  writeJson(seenFile(dir), seen);
}

/** Ids of the records this machine pushed. The local copy of those is the one that counts. */
const readOwn = (dir: string): Set<string> => new Set(readJson<string[]>(ownFile(dir), []));

function setOwn(dir: string, id: string, own: boolean): void {
  const ids = readOwn(dir);
  if (ids.has(id) === own) return;
  if (own) ids.add(id);
  else ids.delete(id);
  mkdirSync(dir, { recursive: true });
  writeJson(ownFile(dir), [...ids]);
}

/** Queues a record to be pushed or removed. One change is kept per record, so a later one replaces an earlier one. */
export function queueChange(dir: string, id: string, op: SyncOp, now = new Date()): void {
  mkdirSync(join(dir, "outbox"), { recursive: true });
  writeJson(queueFile(dir, id), { id, op, queuedAt: now.toISOString(), attempts: 0 } satisfies QueuedChange);
}

/** The changes waiting to be pushed, oldest first. */
export function queuedChanges(dir: string): QueuedChange[] {
  const outbox = join(dir, "outbox");
  if (!existsSync(outbox)) return [];
  return readdirSync(outbox)
    .filter((name) => name.endsWith(".json"))
    .flatMap((name) => readJson<QueuedChange | null>(join(outbox, name), null) ?? [])
    .sort((a, b) => a.queuedAt.localeCompare(b.queuedAt));
}

/** When the last pull finished. */
export function lastPulledAt(dir: string): string | undefined {
  return readSeen(dir).pulledAt;
}

/**
 * Wraps the local store so that each record this machine writes or deletes is also queued for the sync
 * target. Use it for the machine's own captures only: records pulled from the target go to the bare store.
 */
export function queueWrites(store: Store, dir: string): Store {
  return {
    async upsert(record) {
      await store.upsert(record);
      // The store keeps the id a session's record already has, which can differ from the one passed in.
      const stored = (await store.listBySession(record.sessionKey)).find((found) => found.repo === record.repo);
      queueChange(dir, stored?.id ?? record.id, "put");
    },
    async delete(id) {
      const existed = await store.delete(id);
      if (existed) queueChange(dir, id, "remove");
      return existed;
    },
    async deleteBySession(sessionKey) {
      const records = await store.listBySession(sessionKey);
      const existed = await store.deleteBySession(sessionKey);
      for (const record of records) queueChange(dir, record.id, "remove");
      return existed;
    },
    get: (id) => store.get(id),
    listBySession: (sessionKey) => store.listBySession(sessionKey),
    search: (query) => store.search(query),
    recent: (query) => store.recent(query),
    close: () => store.close(),
  };
}

export interface SyncOptions {
  target: SyncTarget;
  /** The bare local store, not one wrapped by `queueWrites`. */
  store: Store;
  /** From `syncDir`. */
  dir: string;
  onWarning?: (message: string) => void;
  now?: Date;
}

export interface PushResult {
  put: number;
  removed: number;
  /** Changes that stay queued for the next push. */
  failed: number;
}

/** Sends the queued changes to the target. A change that fails stays queued and is tried again on the next push. */
export async function push({ target, store, dir, onWarning }: SyncOptions): Promise<PushResult> {
  const result: PushResult = { put: 0, removed: 0, failed: 0 };
  for (const change of queuedChanges(dir)) {
    const file = queueFile(dir, change.id);
    // A change queued for the same record while this one was being sent must stay queued.
    const unchanged = () => readJson<QueuedChange | null>(file, null)?.queuedAt === change.queuedAt;
    try {
      // A queued put whose record has since gone from the local store is handled as a remove.
      const record = change.op === "put" ? await store.get(change.id) : null;
      if (record) {
        const { transcriptRef: _local, ...shared } = record;
        await target.put(shared);
        setOwn(dir, change.id, true);
        result.put += 1;
      } else if (readOwn(dir).has(change.id)) {
        // Only a record this machine pushed is removed: one that never left has nothing to remove, and a
        // teammate's record is not this machine's to delete.
        await target.remove(change.id);
        setOwn(dir, change.id, false);
        result.removed += 1;
      }
      if (unchanged()) rmSync(file, { force: true });
    } catch (error) {
      result.failed += 1;
      onWarning?.(`sync: could not ${change.op} ${change.id}: ${String(error)}`);
      if (unchanged()) writeJson(file, { ...change, attempts: change.attempts + 1, error: String(error) });
    }
  }
  return result;
}

export interface PullResult {
  /** Records that were new or had changed. */
  fetched: number;
  /** Records the target no longer holds. */
  removed: number;
  failed: number;
}

/**
 * Brings the local store in line with the target: fetches records that are new or changed and deletes the
 * ones the target dropped. Records this machine pushed, or has queued, are left as they are locally.
 */
export async function pull({ target, store, dir, onWarning, now = new Date() }: SyncOptions): Promise<PullResult> {
  const seen = readSeen(dir);
  writeSeen(dir, { ...seen, triedAt: now.toISOString() });
  const entries = await target.list();
  const mine = new Set([...readOwn(dir), ...queuedChanges(dir).map((change) => change.id)]);
  const result: PullResult = { fetched: 0, removed: 0, failed: 0 };

  for (const { id, version } of entries) {
    if (mine.has(id) || seen.versions[id] === version) continue;
    try {
      const remote = await target.get(id);
      if (!remote) continue;
      const record = parseSharedRecord(remote);
      if (record.id !== id) throw new Error(`the target returned record ${record.id}`);
      await store.upsert(record);
      seen.versions[id] = version;
      result.fetched += 1;
    } catch (error) {
      result.failed += 1;
      onWarning?.(`sync: could not fetch ${id}: ${String(error)}`);
    }
  }

  const listed = new Set(entries.map((entry) => entry.id));
  for (const id of Object.keys(seen.versions)) {
    if (listed.has(id)) continue;
    await store.delete(id);
    delete seen.versions[id];
    result.removed += 1;
  }
  writeSeen(dir, { ...seen, triedAt: now.toISOString(), pulledAt: now.toISOString() });
  return result;
}

/** Pulls unless a pull was started within `maxAgeMs`, so a target that is down is not asked on every lookup. */
export async function pullIfStale(options: SyncOptions & { maxAgeMs: number }): Promise<PullResult | null> {
  const now = options.now ?? new Date();
  const triedAt = Date.parse(readSeen(options.dir).triedAt ?? "");
  if (!Number.isNaN(triedAt) && now.getTime() - triedAt < options.maxAgeMs) return null;
  return pull({ ...options, now });
}
