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
});
