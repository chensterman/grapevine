import { describe, expect, test } from "bun:test";
import { pathMatchScore, pathOverlap, rankCandidates, recencyWeight } from "../src/rank.ts";
import type { ContextRecord } from "../src/types.ts";

const now = new Date("2026-11-08T00:00:00Z");

function record(id: string, paths: string[], daysAgo: number): ContextRecord {
  return {
    id,
    sessionKey: `test:${id}`,
    repo: "github.com/acme/app",
    author: "dev@acme.com",
    agent: "test",
    updatedAt: new Date(now.getTime() - daysAgo * 86_400_000).toISOString(),
    task: id,
    paths,
    decisions: [],
    deadEnds: [],
    openQuestions: [],
    status: "done",
  };
}

describe("pathMatchScore", () => {
  test.each([
    ["src/a.ts", "src/a.ts", 1],
    ["./src/a.ts", "src/a.ts", 1],
    ["src/webhooks", "src/webhooks/retry.ts", 0.75],
    ["src/webhooks/retry.ts", "src/webhooks", 0.75],
    ["src/webhooks/retry.ts", "src/webhooks/backoff.ts", 0.5],
    ["packages/core/src/a.ts", "packages/core/test/a.test.ts", 0.25],
    ["packages/core/src/a.ts", "packages/cli/src/main.ts", 0],
    ["README.md", "package.json", 0],
  ])("%s vs %s = %d", (query, candidate, expected) => {
    expect(pathMatchScore(query, candidate)).toBe(expected);
  });
});

describe("pathOverlap", () => {
  test("averages the best match per query path and reports strong matches", () => {
    const overlap = pathOverlap(["src/a.ts", "docs/x.md"], ["src/a.ts", "src/b.ts"]);
    expect(overlap.score).toBe(0.5);
    expect(overlap.matchedPaths).toEqual(["src/a.ts"]);
  });
});

describe("recencyWeight", () => {
  test("halves every half-life", () => {
    expect(recencyWeight(now.toISOString(), now)).toBe(1);
    expect(recencyWeight(new Date(now.getTime() - 14 * 86_400_000).toISOString(), now)).toBeCloseTo(0.5);
  });
});

describe("rankCandidates", () => {
  test("prefers exact path matches, then recency, and drops irrelevant records", () => {
    const ranked = rankCandidates(
      [
        { record: record("sibling-fresh", ["src/webhooks/backoff.ts"], 0), textScore: 0 },
        { record: record("exact-old", ["src/webhooks/retry.ts"], 30), textScore: 0 },
        { record: record("exact-fresh", ["src/webhooks/retry.ts"], 1), textScore: 0 },
        { record: record("unrelated", ["docs/readme.md"], 0), textScore: 0 },
      ],
      ["src/webhooks/retry.ts"],
      now,
    );
    expect(ranked.map((result) => result.record.id)).toEqual(["exact-fresh", "exact-old", "sibling-fresh"]);
  });

  test("text matches rank without path overlap", () => {
    const ranked = rankCandidates([{ record: record("text", ["docs/a.md"], 0), textScore: 0.8 }], ["src/x.ts"], now);
    expect(ranked).toHaveLength(1);
  });
});
