import type { ScoredRecord } from "./store.ts";
import type { ContextRecord } from "./types.ts";

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

function section(title: string, items: string[]): string[] {
  return items.length ? [`${title}:`, ...items.map((item) => `- ${item}`)] : [];
}

export function formatRecord(record: ContextRecord, now = new Date()): string {
  const links = [
    record.branch && `branch ${record.branch}`,
    record.pr && `PR ${record.pr}`,
    record.issue && `issue ${record.issue}`,
  ].filter(Boolean);
  const shown = record.paths.slice(0, MAX_LISTED_PATHS).join(", ");
  const more = record.paths.length > MAX_LISTED_PATHS ? ` (+${record.paths.length - MAX_LISTED_PATHS} more)` : "";
  return [
    `### ${record.task}`,
    `${record.status} · ${record.author} via ${record.agent} · ${relativeTime(record.updatedAt, now)} · ${record.repo}`,
    ...(links.length ? [links.join(" · ")] : []),
    ...(record.paths.length ? [`Paths: ${shown}${more}`] : []),
    ...section("Decisions", record.decisions),
    ...section("Dead ends", record.deadEnds),
    ...section("Open questions", record.openQuestions),
    `id: ${record.id}`,
  ].join("\n");
}

export function formatResults(results: ScoredRecord[], now = new Date()): string {
  return results.map((result) => formatRecord(result.record, now)).join("\n\n");
}
