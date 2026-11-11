import { describe, expect, test } from "bun:test";
import { formatRecord } from "../src/format.ts";
import type { ContextRecord } from "../src/types.ts";

const record: ContextRecord = {
  id: "a",
  sessionKey: "test:a",
  repo: "github.com/acme/app",
  author: "dev@acme.com",
  agent: "test",
  updatedAt: new Date().toISOString(),
  task: "Fix retries",
  paths: ["src/retry.ts", "src/queue.ts"],
  decisions: [
    { text: "Capped backoff", paths: ["src/retry.ts"] },
    { text: "Kept the queue", paths: ["src/queue.ts"] },
  ],
  deadEnds: [],
  openQuestions: [],
  pending: [{ text: "PR 12 is waiting for a review", paths: [] }],
  status: "done",
};

describe("formatRecord", () => {
  test("marks items whose files changed since the record", () => {
    const text = formatRecord(record, { changedSince: () => ["src/retry.ts"] });
    expect(text).toContain("Changed since this session: src/retry.ts.");
    expect(text).toContain("- Capped backoff (changed since: src/retry.ts)");
    expect(text).toContain("- Kept the queue\n");
  });

  test("shows no markers without changes", () => {
    expect(formatRecord(record)).not.toContain("changed since");
  });

  test("shows pending items only while the record is fresh", () => {
    const day = 86_400_000;
    const capturedAt = Date.parse(record.updatedAt);
    expect(formatRecord(record, { now: new Date(capturedAt + 6 * day) })).toContain(
      "Pending when last captured:\n- PR 12 is waiting for a review",
    );
    const stale = formatRecord(record, { now: new Date(capturedAt + 8 * day) });
    expect(stale).not.toContain("PR 12");
    expect(stale).toContain("- Capped backoff");
  });
});
