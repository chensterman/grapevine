import { statSync } from "node:fs";
import { join } from "node:path";
import { verifySummary } from "./evidence.ts";
import { type GitInfo, issueFromBranch, readGitInfo, toRepoRelative } from "./git.ts";
import { redact } from "./redact.ts";
import type { Store } from "./store.ts";
import { heuristicSummarizer, type Summarizer, type Summary } from "./summarize.ts";
import { renderTranscript, type Transcript } from "./transcript.ts";
import type { ContextRecord, RecordItem } from "./types.ts";

const MAX_PATHS = 200;

export interface CaptureOptions {
  transcript: Transcript;
  agent: string;
  store: Store;
  summarizer: Summarizer;
  cwd?: string;
  redactPatterns?: string[];
  transcriptRef?: string;
  detectPr?: boolean;
  issuePattern?: string;
  /** Overrides git inspection, mainly for tests. */
  git?: GitInfo;
  now?: Date;
  onWarning?: (message: string) => void;
}

function repoRelativePaths(root: string, paths: string[]): string[] {
  return paths.map((path) => toRepoRelative(root, path)).filter((path): path is string => path !== null);
}

/**
 * Git-changed files modified since the session started, for sessions that ran shell commands. The
 * working tree also holds other sessions' and earlier uncommitted work, which this can't fully exclude.
 */
function changedDuringSession(root: string, paths: string[], startedAt: string | undefined): string[] {
  const since = startedAt ? Date.parse(startedAt) : Number.NaN;
  if (Number.isNaN(since)) return [];
  return paths.filter((path) => {
    try {
      return statSync(join(root, path)).mtimeMs >= since;
    } catch {
      return false;
    }
  });
}

/** Redacts, summarizes, and stores one session. Returns null when the session has no user input. */
export async function capture(options: CaptureOptions): Promise<ContextRecord | null> {
  const { transcript: raw, store, agent } = options;
  if (!raw.turns.some((turn) => turn.role === "user" && turn.text.trim())) return null;

  const cwd = options.cwd ?? raw.cwd ?? process.cwd();
  const git = options.git ?? readGitInfo(cwd, { detectPr: options.detectPr ?? true });
  const patterns = options.redactPatterns ?? [];
  const clean = (text: string) => redact(text, patterns).text;

  const transcript: Transcript = { ...raw, turns: raw.turns.map((turn) => ({ ...turn, text: clean(turn.text) })) };
  const sessionKey = `${agent}:${raw.sessionId}`;
  const existing = await store.getBySession(sessionKey);
  const paths = [
    ...new Set([
      ...repoRelativePaths(git.root, raw.touchedPaths),
      ...(raw.ranCommands ? changedDuringSession(git.root, git.changedPaths, existing?.startedAt ?? raw.startedAt) : []),
      ...(existing?.paths ?? []),
    ]),
  ].slice(0, MAX_PATHS);
  const branch = git.branch ?? raw.branch;
  const input = { transcript, rendered: renderTranscript(transcript), paths, branch };

  let summary: Summary;
  try {
    summary = await options.summarizer.summarize(input);
  } catch (error) {
    options.onWarning?.(`${options.summarizer.name} failed, using heuristic summary: ${String(error)}`);
    summary = await heuristicSummarizer().summarize(input);
  }

  const verified = verifySummary(summary, transcript, git.root, paths);
  if (verified.dropped > 0) {
    options.onWarning?.(`Dropped ${verified.dropped} summary item(s) that no transcript turn supports`);
  }
  const cleanItems = (items: RecordItem[]) => items.map((item) => ({ ...item, text: clean(item.text) }));

  const now = (options.now ?? new Date()).toISOString();
  const record: ContextRecord = {
    id: existing?.id ?? crypto.randomUUID(),
    sessionKey,
    repo: git.repo,
    branch,
    pr: git.pr ?? existing?.pr,
    issue: issueFromBranch(branch, options.issuePattern) ?? existing?.issue,
    author: git.author,
    agent,
    startedAt: existing?.startedAt ?? raw.startedAt ?? now,
    updatedAt: now,
    task: clean(summary.task) || existing?.task || "Untitled session",
    paths,
    decisions: cleanItems(verified.decisions),
    deadEnds: cleanItems(verified.deadEnds),
    openQuestions: cleanItems(verified.openQuestions),
    status: summary.status,
    commit: git.head ?? existing?.commit,
    transcriptRef: options.transcriptRef,
  };
  await store.upsert(record);
  return record;
}
