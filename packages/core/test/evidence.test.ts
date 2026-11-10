import { describe, expect, test } from "bun:test";
import { verifySummary } from "../src/evidence.ts";
import type { Summary } from "../src/summarize.ts";
import type { Transcript } from "../src/transcript.ts";

const transcript: Transcript = {
  sessionId: "s",
  touchedPaths: [],
  turns: [
    { role: "user", text: "Webhook retries hammer the endpoint during incidents" },
    { role: "assistant", text: "A fixed 1s delay still overwhelmed it, so I capped exponential backoff with jitter." },
    { role: "tool", text: "Edited src/webhooks/retry.ts" },
  ],
};

const item = (text: string, turns: number[], paths: string[] = []) => ({ text, paths, turns });

describe("verifySummary", () => {
  test("keeps supported items and drops ones citing missing or unrelated turns", () => {
    const summary: Summary = {
      task: "Fix retries",
      status: "done",
      decisions: [
        item("Capped exponential backoff with jitter in retry.ts", [2, 3], ["/repo/src/webhooks/retry.ts", "src/invented.ts"]),
        item("Moved retries to a Kafka queue", [2]),
      ],
      deadEnds: [item("Fixed 1s delay overwhelmed the endpoint", [])],
      openQuestions: [item("Should backoff cap at 30s?", [9])],
    };

    const verified = verifySummary(summary, transcript, "/repo", ["src/webhooks/retry.ts"]);
    expect(verified.decisions).toEqual([
      { text: "Capped exponential backoff with jitter in retry.ts", paths: ["src/webhooks/retry.ts"] },
    ]);
    expect(verified.deadEnds).toEqual([]);
    expect(verified.openQuestions).toEqual([]);
    expect(verified.dropped).toBe(3);
  });
});
