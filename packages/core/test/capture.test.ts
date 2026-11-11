import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { capture } from "../src/capture.ts";
import type { Store } from "../src/store.ts";
import { heuristicSummarizer, type Summarizer, type Summary } from "../src/summarize.ts";
import type { ContextRecord } from "../src/types.ts";
import { multiRepoWorkspace } from "./workspace.ts";

function memoryStore(): Store {
  const records = new Map<string, ContextRecord>();
  return {
    listBySession: async (key: string) => [...records.values()].filter((record) => record.sessionKey === key),
    upsert: async (record: ContextRecord) => {
      records.set(`${record.sessionKey} ${record.repo}`, record);
    },
    delete: async (id: string) => {
      for (const [key, record] of records) if (record.id === id) return records.delete(key);
      return false;
    },
  } as unknown as Store;
}

describe("capture paths", () => {
  test("attributes only git changes made after the session started", async () => {
    const root = mkdtempSync(join(tmpdir(), "grapevine-capture-"));
    mkdirSync(join(root, "src"));
    const startedAt = new Date(Date.now() - 60_000);
    const before = new Date(startedAt.getTime() - 3_600_000);
    for (const name of ["edited.ts", "generated.ts", "dirty-before.ts"]) writeFileSync(join(root, "src", name), "x");
    utimesSync(join(root, "src", "dirty-before.ts"), before, before);

    const [record] = await capture({
      transcript: {
        sessionId: "s1",
        startedAt: startedAt.toISOString(),
        turns: [{ role: "user", text: "Regenerate the client" }],
        touchedPaths: [join(root, "src", "edited.ts")],
        ranCommands: true,
      },
      agent: "test",
      store: memoryStore(),
      summarizer: heuristicSummarizer(),
      git: {
        root,
        repo: "github.com/acme/app",
        author: "dev@acme.com",
        changedPaths: ["src/edited.ts", "src/generated.ts", "src/dirty-before.ts", "src/deleted.ts"],
      },
    });

    expect(record?.paths.sort()).toEqual(["src/edited.ts", "src/generated.ts"]);
  });

  test("ignores git changes for sessions that ran no commands or have no known start", async () => {
    const root = mkdtempSync(join(tmpdir(), "grapevine-capture-"));
    writeFileSync(join(root, "parallel-session.ts"), "x");
    const git = { root, repo: "github.com/acme/app", author: "dev@acme.com", changedPaths: ["parallel-session.ts"] };
    const turns = [{ role: "user" as const, text: "Explain this" }];
    const startedAt = new Date(Date.now() - 60_000).toISOString();

    for (const transcript of [
      { sessionId: "no-commands", startedAt, turns, touchedPaths: [] },
      { sessionId: "no-start", turns, touchedPaths: [], ranCommands: true },
    ]) {
      const records = await capture({ transcript, agent: "test", store: memoryStore(), summarizer: heuristicSummarizer(), git });
      expect(records.map((record) => record.paths)).toEqual([[]]);
    }
  });
});

describe("capture summaries", () => {
  test("stores verified items with their paths and the HEAD commit, and warns about dropped items", async () => {
    const root = mkdtempSync(join(tmpdir(), "grapevine-capture-"));
    const warnings: string[] = [];
    const summarizer: Summarizer = {
      name: "fake",
      async summarize({ rendered }) {
        expect(rendered).toContain("[2] ASSISTANT: Capped backoff");
        return {
          task: "Fix retries",
          status: "done",
          decisions: [{ text: "Capped backoff in retry.ts", paths: ["src/retry.ts"], turns: [2] }],
          deadEnds: [{ text: "Invented approach", paths: [], turns: [] }],
          openQuestions: [],
          pending: [{ text: "Backoff change is waiting for review", paths: [], turns: [2] }],
        };
      },
    };

    const [record] = await capture({
      transcript: {
        sessionId: "s2",
        turns: [
          { role: "user", text: "Fix retries" },
          { role: "assistant", text: "Capped backoff in src/retry.ts" },
        ],
        touchedPaths: [join(root, "src", "retry.ts")],
      },
      agent: "test",
      store: memoryStore(),
      summarizer,
      git: { root, repo: "github.com/acme/app", author: "dev@acme.com", changedPaths: [], head: "abc123" },
      onWarning: (message) => warnings.push(message),
    });

    expect(record?.decisions).toEqual([{ text: "Capped backoff in retry.ts", paths: ["src/retry.ts"] }]);
    expect(record?.deadEnds).toEqual([]);
    expect(record?.pending).toEqual([{ text: "Backoff change is waiting for review", paths: [] }]);
    expect(record?.commit).toBe("abc123");
    expect(warnings).toEqual(["Dropped 1 summary item(s) that no transcript turn supports"]);
  });

  test("keeps the existing summary when the summarizer fails", async () => {
    const store = memoryStore();
    const git = { root: mkdtempSync(join(tmpdir(), "grapevine-capture-")), repo: "r", author: "a", changedPaths: [] };
    const transcript = { sessionId: "s3", turns: [{ role: "user" as const, text: "Fix retries" }], touchedPaths: [] };
    const decisions = [{ text: "Capped backoff", paths: [] }];
    const [first] = await capture({ transcript, agent: "test", store, summarizer: heuristicSummarizer(), git });
    await store.upsert({ ...first!, task: "Model task", decisions, status: "done" });

    const failing: Summarizer = { name: "broken", summarize: () => Promise.reject(new Error("429")) };
    const records = await capture({ transcript, agent: "test", store, summarizer: failing, git, onWarning: () => {} });
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ id: first!.id, task: "Model task", decisions, status: "done" });
  });

  test("keeps a model's summary when a later capture has no model", async () => {
    const store = memoryStore();
    const root = mkdtempSync(join(tmpdir(), "grapevine-capture-"));
    const git = { root, repo: "r", author: "a", changedPaths: [] };
    const turns = [{ role: "user" as const, text: "Fix retries" }];
    const decisions = [{ text: "Capped backoff", paths: [] }];
    const options = { agent: "test", store, summarizer: heuristicSummarizer(), git };
    const [first] = await capture({ ...options, transcript: { sessionId: "s4", turns, touchedPaths: [] } });
    await store.upsert({ ...first!, task: "Model task", decisions, status: "done" });

    // The key went missing, so the heuristic runs. It still records the new file.
    const transcript = { sessionId: "s4", turns, touchedPaths: [join(root, "src/retry.ts")] };
    const records = await capture({ ...options, transcript });
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ id: first!.id, task: "Model task", decisions, status: "done", paths: ["src/retry.ts"] });
  });
});

describe("capture across repos", () => {
  const turns = [
    { role: "user" as const, text: "Share the retry helper between app and lib" },
    { role: "assistant" as const, text: "Capped backoff in b.ts and moved the retry helper into lib. Opened PR 12 for review." },
  ];
  const summary: Summary = {
    task: "Share the retry helper",
    status: "in_progress",
    decisions: [
      { text: "Capped backoff in b.ts", paths: [".worktrees/app-fix/src/b.ts"], turns: [2] },
      { text: "Moved the retry helper into lib", paths: ["app/src/a.ts", "lib/index.ts"], turns: [2] },
    ],
    deadEnds: [],
    openQuestions: [{ text: "Should the helper retry on timeouts?", paths: [], turns: [1] }],
    pending: [{ text: "PR 12 is waiting for review", paths: [], turns: [2] }],
  };

  test("writes one record per repo, with repo-relative paths and each repo's own items", async () => {
    // The session's folder is given through a symlink, as temp folders are on macOS.
    const dir = join(tmpdir(), basename(multiRepoWorkspace()));
    const store = memoryStore();
    let shown: string[] = [];
    const summarizer: Summarizer = {
      name: "fake",
      async summarize({ paths }) {
        shown = paths;
        return summary;
      },
    };
    const options = {
      transcript: {
        sessionId: "multi",
        turns,
        touchedPaths: [
          join(dir, "app", "src", "a.ts"),
          join(dir, ".worktrees", "app-fix", "src", "b.ts"),
          join(dir, ".worktrees", "app-fix", "src", "c.ts"),
          join(dir, "lib", "index.ts"),
          "lib/util.ts",
          join(dir, "notes.md"),
          "/somewhere/else.ts",
        ],
      },
      agent: "test",
      store,
      summarizer,
      cwd: dir,
      detectPr: false,
    };

    const records = await capture(options);
    expect(shown.sort()).toEqual([
      ".worktrees/app-fix/src/b.ts",
      ".worktrees/app-fix/src/c.ts",
      "app/src/a.ts",
      "lib/index.ts",
      "lib/util.ts",
      "notes.md",
    ]);
    expect(records.map((record) => [record.repo, record.paths.sort()])).toEqual([
      ["github.com/acme/app", ["src/a.ts", "src/b.ts", "src/c.ts"]],
      ["github.com/acme/lib", ["index.ts", "util.ts"]],
      [`local/${basename(dir)}`, ["notes.md"]],
    ]);
    const [app, lib, local] = records;
    // Most of the app files are in the worktree, so the record carries its branch.
    expect(app).toMatchObject({ branch: "fix", author: "dev@acme.com", task: "Share the retry helper" });
    expect(app?.commit).toMatch(/^[0-9a-f]{40}$/);
    expect(app?.decisions).toEqual([
      { text: "Capped backoff in b.ts", paths: ["src/b.ts"] },
      { text: "Moved the retry helper into lib", paths: ["src/a.ts"] },
    ]);
    expect(app?.openQuestions).toHaveLength(1);
    expect(app?.pending).toEqual([{ text: "PR 12 is waiting for review", paths: [] }]);
    expect(lib).toMatchObject({ branch: "main", decisions: [{ text: "Moved the retry helper into lib", paths: ["index.ts"] }] });
    expect(lib?.openQuestions).toEqual([]);
    expect(lib?.pending).toEqual([]);
    expect(local).toMatchObject({ decisions: [], pending: [], task: "Share the retry helper" });

    const again = await capture(options);
    expect(again.map((record) => record.id)).toEqual(records.map((record) => record.id));
    expect(await store.listBySession("test:multi")).toHaveLength(3);

    // Once the worktree is removed, its files still belong to the repo earlier captures put them in.
    rmSync(join(dir, ".worktrees"), { recursive: true });
    const after = await capture({
      ...options,
      transcript: {
        ...options.transcript,
        touchedPaths: [...options.transcript.touchedPaths, join(dir, ".worktrees", "app-fix", "src", "d.ts")],
      },
    });
    expect(after.map((record) => [record.repo, record.paths.sort()])).toEqual([
      ["github.com/acme/app", ["src/a.ts", "src/b.ts", "src/c.ts", "src/d.ts"]],
      ["github.com/acme/lib", ["index.ts", "util.ts"]],
      [`local/${basename(dir)}`, ["notes.md"]],
    ]);
    expect(after[0]).toMatchObject({ id: app!.id, branch: "fix", author: "dev@acme.com", commit: app!.commit });
    expect(after[0]?.decisions).toEqual(app!.decisions);
  });

  test("replaces a record written before the workspace's checkouts were told apart", async () => {
    const dir = multiRepoWorkspace();
    const store = memoryStore();
    const legacy: ContextRecord = {
      id: "legacy",
      sessionKey: "test:legacy",
      repo: `local/${basename(dir)}`,
      author: "dev",
      agent: "test",
      updatedAt: "2026-01-01T00:00:00Z",
      task: "Old task",
      paths: ["app/src/a.ts", "lib/old.ts"],
      decisions: [],
      deadEnds: [],
      openQuestions: [],
      pending: [],
      status: "in_progress",
    };
    await store.upsert(legacy);
    const options = {
      transcript: { sessionId: "legacy", turns, touchedPaths: [join(dir, "app", "src", "a.ts")] },
      agent: "test",
      store,
      cwd: dir,
      detectPr: false,
    };

    const failing: Summarizer = { name: "broken", summarize: () => Promise.reject(new Error("429")) };
    await capture({ ...options, summarizer: failing, onWarning: () => {} });
    expect((await store.listBySession("test:legacy")).map((record) => record.repo)).toContain(legacy.repo);

    const records = await capture({ ...options, summarizer: heuristicSummarizer() });
    expect(records.map((record) => [record.repo, record.paths])).toEqual([
      ["github.com/acme/app", ["src/a.ts"]],
      ["github.com/acme/lib", ["old.ts"]],
    ]);
    expect((await store.listBySession("test:legacy")).map((record) => record.repo).sort()).toEqual([
      "github.com/acme/app",
      "github.com/acme/lib",
    ]);
  });
});
