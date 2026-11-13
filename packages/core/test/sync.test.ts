import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Store } from "../src/store.ts";
import {
  lastPulledAt,
  loadSyncTarget,
  parseSharedRecord,
  pull,
  pullIfStale,
  push,
  queueChange,
  queuedChanges,
  queueWrites,
  type SharedRecord,
  type SyncTarget,
} from "../src/sync.ts";
import type { ContextRecord } from "../src/types.ts";

function record(id: string, overrides: Partial<ContextRecord> = {}): ContextRecord {
  return {
    id,
    sessionKey: `test:${id}`,
    repo: "github.com/acme/app",
    author: "dev",
    agent: "test",
    updatedAt: "2026-11-01T00:00:00.000Z",
    task: `Task ${id}`,
    paths: ["src/a.ts"],
    decisions: [{ text: "Use X because Y", paths: ["src/a.ts"] }],
    deadEnds: [],
    openQuestions: [],
    pending: [],
    status: "done",
    ...overrides,
  };
}

function memoryStore(): Store & { records: Map<string, ContextRecord> } {
  const records = new Map<string, ContextRecord>();
  const ofSession = (key: string) => [...records.values()].filter((found) => found.sessionKey === key);
  return {
    records,
    upsert: async (next) => {
      const id = ofSession(next.sessionKey).find((found) => found.repo === next.repo)?.id ?? next.id;
      records.set(id, { ...next, id });
    },
    get: async (id) => records.get(id) ?? null,
    listBySession: async (key) => ofSession(key),
    delete: async (id) => records.delete(id),
    deleteBySession: async (key) => ofSession(key).map((found) => records.delete(found.id)).length > 0,
    search: async () => [],
    recent: async () => [...records.values()],
    close: () => {},
  };
}

/** A team's shared place, held in memory. Its version is a counter that moves on every put. */
function fakeTarget() {
  const held = new Map<string, { record: SharedRecord; version: number }>();
  const calls: string[] = [];
  let down = false;
  let puts = 0;
  const check = (call: string) => {
    calls.push(call);
    if (down) throw new Error("target is down");
  };
  const target: SyncTarget = {
    put: async (shared) => {
      check(`put ${shared.id}`);
      held.set(shared.id, { record: structuredClone(shared), version: (puts += 1) });
    },
    remove: async (id) => {
      check(`remove ${id}`);
      held.delete(id);
    },
    list: async () => {
      check("list");
      return [...held].map(([id, { version }]) => ({ id, version: String(version) }));
    },
    get: async (id) => {
      check(`get ${id}`);
      return held.get(id)?.record ?? null;
    },
  };
  return { target, held, calls, setDown: (value: boolean) => void (down = value) };
}

/** One person's machine: a local store and its sync state. */
function machine(target: SyncTarget) {
  const local = memoryStore();
  const dir = mkdtempSync(join(tmpdir(), "grapevine-sync-"));
  const warnings: string[] = [];
  const options = { target, store: local, dir, onWarning: (message: string) => void warnings.push(message) };
  return { local, own: queueWrites(local, dir), dir, warnings, options };
}

describe("sync", () => {
  test("shares a capture with a teammate, then its update and its removal", async () => {
    const team = fakeTarget();
    const ana = machine(team.target);
    const ben = machine(team.target);

    await ana.own.upsert(record("a", { transcriptRef: "/home/ana/session.jsonl" }));
    expect(await push(ana.options)).toEqual({ put: 1, removed: 0, failed: 0 });
    expect(queuedChanges(ana.dir)).toEqual([]);
    expect(team.held.get("a")?.record).not.toHaveProperty("transcriptRef");

    expect(await pull(ben.options)).toEqual({ fetched: 1, removed: 0, failed: 0 });
    expect(await ben.local.get("a")).toEqual({ ...record("a") });
    expect(lastPulledAt(ben.dir)).toBeDefined();

    // Nothing changed, so a second pull only lists.
    team.calls.length = 0;
    expect(await pull(ben.options)).toEqual({ fetched: 0, removed: 0, failed: 0 });
    expect(team.calls).toEqual(["list"]);

    await ana.own.upsert(record("a", { task: "Second pass" }));
    await push(ana.options);
    expect(await pull(ben.options)).toEqual({ fetched: 1, removed: 0, failed: 0 });
    expect((await ben.local.get("a"))?.task).toBe("Second pass");

    await ana.own.deleteBySession("test:a");
    expect(await push(ana.options)).toEqual({ put: 0, removed: 1, failed: 0 });
    expect(await pull(ben.options)).toEqual({ fetched: 0, removed: 1, failed: 0 });
    expect(await ben.local.get("a")).toBeNull();
  });

  test("keeps a change queued while the target is down and sends it on the next push", async () => {
    const team = fakeTarget();
    const ana = machine(team.target);
    await ana.own.upsert(record("a"));

    team.setDown(true);
    expect(await push(ana.options)).toEqual({ put: 0, removed: 0, failed: 1 });
    expect(queuedChanges(ana.dir)).toMatchObject([{ id: "a", op: "put", attempts: 1, error: "Error: target is down" }]);
    expect(ana.warnings).toEqual(["sync: could not put a: Error: target is down"]);
    await expect(pull(ana.options)).rejects.toThrow("target is down");
    expect(await ana.local.get("a")).not.toBeNull();

    team.setDown(false);
    expect(await push(ana.options)).toEqual({ put: 1, removed: 0, failed: 0 });
    expect(queuedChanges(ana.dir)).toEqual([]);
    expect(team.held.has("a")).toBe(true);
  });

  test("leaves this machine's own records as they are locally", async () => {
    const team = fakeTarget();
    const ana = machine(team.target);
    await ana.own.upsert(record("pushed"));
    await push(ana.options);
    await ana.own.upsert(record("waiting"));

    // The target hands back altered copies, as a store that rewrites what it keeps would.
    team.held.set("pushed", { record: record("pushed", { task: "Rewritten" }), version: 90 });
    team.held.set("waiting", { record: record("waiting", { task: "Stale" }), version: 91 });
    expect(await pull(ana.options)).toEqual({ fetched: 0, removed: 0, failed: 0 });
    expect((await ana.local.get("pushed"))?.task).toBe("Task pushed");
    expect((await ana.local.get("waiting"))?.task).toBe("Task waiting");

    // A teammate's record that disappears from the target is deleted here; this machine's own are not.
    team.held.set("theirs", { record: record("theirs"), version: 92 });
    await pull(ana.options);
    team.held.clear();
    expect(await pull(ana.options)).toEqual({ fetched: 0, removed: 1, failed: 0 });
    expect([...ana.local.records.keys()].sort()).toEqual(["pushed", "waiting"]);
  });

  test("removes from the target only what this machine pushed", async () => {
    const team = fakeTarget();
    const ana = machine(team.target);
    team.held.set("theirs", { record: record("theirs"), version: 1 });
    await pull(ana.options);

    // A record that never left the machine has nothing to remove, and a teammate's is not ours to remove.
    await ana.own.upsert(record("never-sent"));
    await ana.own.delete("never-sent");
    await ana.own.delete("theirs");
    team.calls.length = 0;
    expect(await push(ana.options)).toEqual({ put: 0, removed: 0, failed: 0 });
    expect(team.calls).toEqual([]);
    expect(queuedChanges(ana.dir)).toEqual([]);
    expect(team.held.has("theirs")).toBe(true);
  });

  test("skips a malformed record without stopping the pull", async () => {
    const team = fakeTarget();
    const ben = machine(team.target);
    team.held.set("bad", { record: { id: "bad", task: 7 } as unknown as SharedRecord, version: 1 });
    team.held.set("wrong-id", { record: record("someone-else"), version: 2 });
    team.held.set("good", { record: record("good"), version: 3 });

    expect(await pull(ben.options)).toEqual({ fetched: 1, removed: 0, failed: 2 });
    expect([...ben.local.records.keys()]).toEqual(["good"]);
    expect(ben.warnings).toHaveLength(2);
  });

  test("pulls again only once the last attempt is old enough", async () => {
    const team = fakeTarget();
    const ben = machine(team.target);
    const at = (minutes: number) => new Date(Date.UTC(2026, 10, 1, 0, minutes));
    const options = { ...ben.options, maxAgeMs: 5 * 60_000 };

    expect(await pullIfStale({ ...options, now: at(0) })).not.toBeNull();
    expect(await pullIfStale({ ...options, now: at(4) })).toBeNull();
    expect(await pullIfStale({ ...options, now: at(6) })).not.toBeNull();

    // A failed attempt counts, so a target that is down is not asked on every lookup.
    team.setDown(true);
    await expect(pullIfStale({ ...options, now: at(20) })).rejects.toThrow();
    expect(await pullIfStale({ ...options, now: at(21) })).toBeNull();
  });

  test("keeps one queued change per record, the latest", () => {
    const dir = mkdtempSync(join(tmpdir(), "grapevine-sync-"));
    queueChange(dir, "a/with:odd chars", "put", new Date("2026-11-01T00:00:00Z"));
    queueChange(dir, "b", "put", new Date("2026-11-01T00:00:01Z"));
    queueChange(dir, "a/with:odd chars", "remove", new Date("2026-11-01T00:00:02Z"));
    expect(queuedChanges(dir).map((change) => [change.id, change.op])).toEqual([
      ["b", "put"],
      ["a/with:odd chars", "remove"],
    ]);
  });
});

describe("parseSharedRecord", () => {
  test("drops unknown fields and rejects a malformed record", () => {
    const parsed = parseSharedRecord({ ...record("a"), transcriptRef: "/home/ana/session.jsonl", extra: 1 });
    expect(parsed).toEqual(record("a"));
    expect(() => parseSharedRecord({ ...record("a"), status: "finished" })).toThrow();
    expect(() => parseSharedRecord({ ...record("a"), paths: "src/a.ts" })).toThrow();
  });
});

describe("loadSyncTarget", () => {
  test("loads a module by path and passes it the configured options", async () => {
    const home = mkdtempSync(join(tmpdir(), "grapevine-home-"));
    writeFileSync(
      join(home, "target.ts"),
      `export function createSyncTarget(options, context) {
        return { put: async () => {}, remove: async () => {}, list: async () => [{ id: options.team, version: context.home }], get: async () => null };
      }`,
    );
    for (const spec of ["./target.ts", join(home, "target.ts")]) {
      const target = await loadSyncTarget({ target: spec, options: { team: "acme" } }, home);
      expect(await target.list()).toEqual([{ id: "acme", version: home }]);
    }
  });

  test("explains a module that is not a sync target", async () => {
    const home = mkdtempSync(join(tmpdir(), "grapevine-home-"));
    writeFileSync(join(home, "empty.ts"), "export const nothing = 1;");
    await expect(loadSyncTarget({ target: "./empty.ts" }, home)).rejects.toThrow("does not export a createSyncTarget function");
  });
});
