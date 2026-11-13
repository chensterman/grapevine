import type { ScoredRecord } from "./store.ts";
import type { ContextRecord, RecordItem } from "./types.ts";

const MAX_LISTED_PATHS = 8;

export function relativeTime(iso: string, now = new Date()): string {
  const ms = now.getTime() - Date.parse(iso);
  if (Number.isNaN(ms)) return iso;
  const minutes = Math.round(ms / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

export interface FormatOptions {
  now?: Date;
  /** Which of a record's paths changed after it was captured. */
  changedSince?: (record: ContextRecord) => string[];
}

function section(title: string, items: RecordItem[], changed: Set<string>): string[] {
  const line = (item: RecordItem) => {
    const stale = item.paths.filter((path) => changed.has(path));
    return stale.length ? `- ${item.text} (changed since: ${stale.join(", ")})` : `- ${item.text}`;
  };
  return items.length ? [`${title}:`, ...items.map(line)] : [];
}

/** Pending items describe a moment, like a review being awaited, so they are hidden once the record is older than this. */
export const PENDING_MAX_AGE_DAYS = 7;

function pendingIsFresh(record: ContextRecord, now: Date): boolean {
  const ageMs = now.getTime() - Date.parse(record.updatedAt);
  return !Number.isNaN(ageMs) && ageMs <= PENDING_MAX_AGE_DAYS * 86_400_000;
}

export function formatRecord(record: ContextRecord, options: FormatOptions = {}): string {
  const now = options.now ?? new Date();
  const changedPaths = options.changedSince?.(record) ?? [];
  const changed = new Set(changedPaths);
  const links = [
    record.branch && `branch ${record.branch}`,
    record.pr && `PR ${record.pr}`,
    record.issue && `issue ${record.issue}`,
  ].filter(Boolean);
  const listed = (paths: string[]) =>
    paths.slice(0, MAX_LISTED_PATHS).join(", ") +
    (paths.length > MAX_LISTED_PATHS ? ` (+${paths.length - MAX_LISTED_PATHS} more)` : "");
  const readPaths = record.readPaths ?? [];
  return [
    `### ${record.task}`,
    `${record.status} · ${record.author} via ${record.agent} · ${relativeTime(record.updatedAt, now)} · ${record.repo}`,
    ...(links.length ? [links.join(" · ")] : []),
    ...(record.paths.length ? [`Paths: ${listed(record.paths)}`] : []),
    ...(readPaths.length ? [`Read without changing: ${listed(readPaths)}`] : []),
    ...(changedPaths.length
      ? [`Changed since this session: ${changedPaths.join(", ")}. Check the current code before relying on notes about them.`]
      : []),
    ...section("Decisions", record.decisions, changed),
    ...section("Dead ends", record.deadEnds, changed),
    ...section("Open questions", record.openQuestions, changed),
    ...(pendingIsFresh(record, now) ? section("Pending when last captured", record.pending, changed) : []),
    `id: ${record.id}`,
  ].join("\n");
}

export function formatResults(results: ScoredRecord[], options: FormatOptions = {}): string {
  return results.map((result) => formatRecord(result.record, options)).join("\n\n");
}
