import { afterEach, describe, expect, test } from "bun:test";
import type { ContextRecord, Store } from "@chensterman/grapevine-core";
import { openSqliteStore, toFtsQuery } from "../src/index.ts";

function record(overrides: Partial<ContextRecord> & { id: string }): ContextRecord {
  return {
    sessionKey: `test:${overrides.id}`,
    repo: "github.com/acme/app",
    author: "dev@acme.com",
    agent: "test",
    updatedAt: new Date().toISOString(),
    task: "Something",
    paths: [],
    decisions: [],
    deadEnds: [],
    openQuestions: [],
    status: "done",
    ...overrides,
  };
}

let store: Store;
afterEach(() => store?.close());

describe("SqliteStore", () => {
  test("round-trips records and upserts by session key", async () => {
    store = openSqliteStore(":memory:");
    const original = record({ id: "a", task: "First pass", paths: ["src/a.ts"], decisions: ["Use X because Y"], branch: "b" });
    await store.upsert(original);
    expect(await store.get("a")).toEqual(original);

    await store.upsert({ ...original, id: "ignored-new-id", task: "Second pass", paths: ["src/b.ts"], branch: undefined });
    const updated = await store.getBySession("test:a");
    expect(updated?.id).toBe("a");
    expect(updated?.task).toBe("Second pass");
    expect(updated?.paths).toEqual(["src/b.ts"]);
    expect(updated?.branch).toBeUndefined();
    expect(await store.recent({})).toHaveLength(1);
  });

  test("deletes a session's record from every index", async () => {
    store = openSqliteStore(":memory:");
    await store.upsert(record({ id: "a", task: "Retry backoff", paths: ["src/retry.ts"] }));
    expect(await store.deleteBySession("test:a")).toBe(true);
    expect(await store.deleteBySession("test:a")).toBe(false);
    expect(await store.recent({})).toEqual([]);
    expect(await store.search({ paths: ["src/retry.ts"] })).toEqual([]);
    expect(await store.search({ text: "backoff" })).toEqual([]);
  });

  test("searches by path proximity within a repo", async () => {
    store = openSqliteStore(":memory:");
    await store.upsert(record({ id: "exact", paths: ["src/webhooks/retry.ts"] }));
    await store.upsert(record({ id: "sibling", paths: ["src/webhooks/backoff.ts"] }));
    await store.upsert(record({ id: "far", paths: ["docs/guide.md"] }));
    await store.upsert(record({ id: "other-repo", repo: "github.com/acme/other", paths: ["src/webhooks/retry.ts"] }));

    const results = await store.search({ repo: "github.com/acme/app", paths: ["src/webhooks/retry.ts"] });
    expect(results.map((result) => result.record.id)).toEqual(["exact", "sibling"]);
    expect(results[0]?.matchedPaths).toEqual(["src/webhooks/retry.ts"]);

    const everywhere = await store.search({ paths: ["src/webhooks/retry.ts"] });
    expect(everywhere.map((result) => result.record.id)).toContain("other-repo");
  });

  test("searches decisions and dead ends by text", async () => {
    store = openSqliteStore(":memory:");
    await store.upsert(record({ id: "redis", task: "Cache layer", deadEnds: ["Redis cluster mode broke MULTI"] }));
    await store.upsert(record({ id: "ui", task: "Button styles" }));
    const results = await store.search({ text: "redis multi" });
    expect(results.map((result) => result.record.id)).toEqual(["redis"]);
  });

  test("falls back to recent records and excludes the caller's session", async () => {
    store = openSqliteStore(":memory:");
    await store.upsert(record({ id: "old", updatedAt: "2026-01-01T00:00:00Z" }));
    await store.upsert(record({ id: "new", updatedAt: "2026-02-01T00:00:00Z" }));
    const results = await store.search({ excludeSessionKey: "test:new" });
    expect(results.map((result) => result.record.id)).toEqual(["old"]);
  });

  test("treats user text as literal FTS tokens", async () => {
    store = openSqliteStore(":memory:");
    expect(toFtsQuery('foo" OR bar*) NEAR(')).toBe('"foo" OR "or" OR "bar" OR "near"');
    expect(toFtsQuery("!!")).toBeNull();
    expect(await store.search({ text: 'unbalanced " (' })).toEqual([]);
  });
});
