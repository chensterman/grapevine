import { posix } from "node:path";
import type { ScoredRecord } from "./store.ts";
import type { ContextRecord } from "./types.ts";

const DAY_MS = 86_400_000;

export function normalizePath(path: string): string {
  return path.replace(/\\/g, "/").replace(/^(\.\/)+/, "").replace(/\/+$/, "");
}

function dirSegments(path: string): string[] {
  const dir = posix.dirname(path);
  return dir === "." ? [] : dir.split("/");
}

/** How strongly a record that touched `candidate` relates to someone about to work on `query`. */
export function pathMatchScore(query: string, candidate: string): number {
  const q = normalizePath(query);
  const c = normalizePath(candidate);
  if (!q || !c) return 0;
  if (q === c) return 1;
  if (c.startsWith(`${q}/`) || q.startsWith(`${c}/`)) return 0.75;
  const qDir = dirSegments(q);
  const cDir = dirSegments(c);
  if (qDir.length > 0 && qDir.join("/") === cDir.join("/")) return 0.5;
  let shared = 0;
  while (shared < qDir.length && shared < cDir.length && qDir[shared] === cDir[shared]) shared += 1;
  if (shared >= 2) return 0.25;
  // A file of the same name in another folder often plays the same role there, like each package's config.
  return posix.basename(q) === posix.basename(c) ? 0.25 : 0;
}

export interface PathOverlap {
  score: number;
  matchedPaths: string[];
}

/** Average best match across the query paths, in [0, 1]. */
export function pathOverlap(queryPaths: string[], recordPaths: string[]): PathOverlap {
  if (queryPaths.length === 0 || recordPaths.length === 0) return { score: 0, matchedPaths: [] };
  let total = 0;
  const matched = new Set<string>();
  for (const query of queryPaths) {
    let best = 0;
    let bestPath: string | undefined;
    for (const candidate of recordPaths) {
      const score = pathMatchScore(query, candidate);
      if (score > best) {
        best = score;
        bestPath = candidate;
      }
    }
    total += best;
    if (bestPath && best >= 0.5) matched.add(bestPath);
  }
  return { score: total / queryPaths.length, matchedPaths: [...matched] };
}

export function recencyWeight(updatedAt: string, now = new Date(), halfLifeDays = 14): number {
  const updated = Date.parse(updatedAt);
  if (Number.isNaN(updated)) return 0.5;
  const ageDays = Math.max(0, now.getTime() - updated) / DAY_MS;
  return 0.5 ** (ageDays / halfLifeDays);
}

export interface Candidate {
  record: ContextRecord;
  /** Full-text relevance in [0, 1]; 0 when the query had no text or the record did not match it. */
  textScore: number;
}

/** A file a session only read says less about it than one it changed. */
const READ_WEIGHT = 0.5;

export function rankCandidates(candidates: Candidate[], queryPaths: string[], now = new Date()): ScoredRecord[] {
  return candidates
    .map(({ record, textScore }) => {
      const overlap = pathOverlap(queryPaths, record.paths);
      const read = READ_WEIGHT * pathOverlap(queryPaths, record.readPaths ?? []).score;
      const relevance = 2 * Math.max(overlap.score, read) + textScore;
      const score = relevance * (0.5 + 0.5 * recencyWeight(record.updatedAt, now));
      return { record, score, matchedPaths: overlap.matchedPaths };
    })
    .filter((result) => result.score > 0)
    .sort((a, b) => b.score - a.score);
}
