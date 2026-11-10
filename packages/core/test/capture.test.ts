import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { capture } from "../src/capture.ts";
import type { Store } from "../src/store.ts";
import { heuristicSummarizer, type Summarizer } from "../src/summarize.ts";
import type { ContextRecord } from "../src/types.ts";

function memoryStore(): Store {
  const records = new Map<string, ContextRecord>();
  return {
    getBySession: async (key: string) => records.get(key) ?? null,
    upsert: async (record: ContextRecord) => {
      records.set(record.sessionKey, record);
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

    const record = await capture({
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
      const record = await capture({ transcript, agent: "test", store: memoryStore(), summarizer: heuristicSummarizer(), git });
      expect(record?.paths).toEqual([]);
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
        };
      },
    };

    const record = await capture({
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
    expect(record?.commit).toBe("abc123");
    expect(warnings).toEqual(["Dropped 1 summary item(s) that no transcript turn supports"]);
  });

  test("keeps the existing summary when the summarizer fails", async () => {
    const store = memoryStore();
    const git = { root: mkdtempSync(join(tmpdir(), "grapevine-capture-")), repo: "r", author: "a", changedPaths: [] };
    const transcript = { sessionId: "s3", turns: [{ role: "user" as const, text: "Fix retries" }], touchedPaths: [] };
    const decisions = [{ text: "Capped backoff", paths: [] }];
    await store.upsert({ ...(await capture({ transcript, agent: "test", store, summarizer: heuristicSummarizer(), git }))!, task: "Model task", decisions, status: "done" });

    const failing: Summarizer = { name: "broken", summarize: () => Promise.reject(new Error("429")) };
    const record = await capture({ transcript, agent: "test", store, summarizer: failing, git, onWarning: () => {} });
    expect(record).toMatchObject({ task: "Model task", decisions, status: "done" });
  });
});
