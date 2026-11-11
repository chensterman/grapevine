import { existsSync, statSync } from "node:fs";
import { isAbsolute, join, relative, sep } from "node:path";
import { verifySummary } from "./evidence.ts";
import {
  createPathLocator,
  type GitInfo,
  issueFromBranch,
  type LocatedPath,
  readGitInfo,
  realPath,
  toRepoRelative,
} from "./git.ts";
import { normalizePath } from "./rank.ts";
import { redact } from "./redact.ts";
import type { Store } from "./store.ts";
import { HEURISTIC, heuristicSummarizer, type Summarizer, type Summary } from "./summarize.ts";
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
  /** Overrides git inspection and treats every file as part of this one repo, mainly for tests. */
  git?: GitInfo;
  now?: Date;
  onWarning?: (message: string) => void;
}

/** The files a session changed in one repo. Worktrees of the same repo share a group. */
interface RepoGroup {
  repo: string;
  /** Repo-relative path to the checkout the file was changed in. */
  paths: Map<string, string>;
}

/** The checkout holding most of the group's files, which supplies its branch and commit. */
function mainRoot(group: RepoGroup): string | undefined {
  const counts = new Map<string, number>();
  for (const root of group.paths.values()) counts.set(root, (counts.get(root) ?? 0) + 1);
  return [...counts].sort((a, b) => b[1] - a[1])[0]?.[0];
}

function commonDir(dirs: string[]): string {
  const [first = [], ...rest] = dirs.map((dir) => dir.split(sep));
  let shared = first.length;
  for (const parts of rest) {
    let index = 0;
    while (index < shared && parts[index] === first[index]) index += 1;
    shared = index;
  }
  return first.slice(0, shared).join(sep) || sep;
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

/**
 * Redacts, summarizes, and stores one session: one record for each repo it changed files in, since
 * one workspace can hold several clones and worktrees. The record for the repo with the most changed
 * files comes first. Returns no records when the session has no user input.
 */
export async function capture(options: CaptureOptions): Promise<ContextRecord[]> {
  const { transcript: raw, store, agent } = options;
  if (!raw.turns.some((turn) => turn.role === "user" && turn.text.trim())) return [];

  const cwd = options.cwd ?? raw.cwd ?? process.cwd();
  const gitOptions = { detectPr: options.detectPr ?? true };
  const home = options.git ?? readGitInfo(cwd, gitOptions);
  const infoByRoot = new Map([[home.root, home]]);
  const infoFor = (root: string): GitInfo => {
    const info = infoByRoot.get(root) ?? readGitInfo(root, gitOptions);
    infoByRoot.set(root, info);
    return info;
  };
  const patterns = options.redactPatterns ?? [];
  const clean = (text: string) => redact(text, patterns).text;

  const transcript: Transcript = { ...raw, turns: raw.turns.map((turn) => ({ ...turn, text: clean(turn.text) })) };
  const sessionKey = `${agent}:${raw.sessionId}`;
  const existing = await store.listBySession(sessionKey);
  const startedAt = existing.find((record) => record.startedAt)?.startedAt ?? raw.startedAt;

  // A checkout deleted since an earlier capture, like a worktree removed once its branch merged, can no
  // longer say which repo it is. A file is known to be from one when it ends with a path that capture
  // recorded and the folder above that path is gone. Longer recorded paths are tried first.
  const recorded = existing
    .flatMap((record) => record.paths.map((path) => ({ repo: record.repo, path })))
    .sort((a, b) => b.path.length - a.path.length);
  const deleted = new Map<string, string>();
  for (const path of raw.touchedPaths) {
    const match = isAbsolute(path) && recorded.find((entry) => normalizePath(path).endsWith(`/${entry.path}`));
    if (!match) continue;
    const root = path.slice(0, -(match.path.length + 1));
    // Symlinks are resolved so the root lines up with the roots git reports for other checkouts.
    if (!existsSync(root)) deleted.set(realPath(root), match.repo);
  }
  const locateOnDisk = createPathLocator(home, options.git ? () => null : undefined);
  const locateFile = (path: string): LocatedPath | null => {
    for (const [root, repo] of isAbsolute(path) ? deleted : []) {
      const inRoot = toRepoRelative(root, path);
      if (inRoot !== null) return { root, repo, path: inRoot };
    }
    return locateOnDisk(path);
  };

  const groups = new Map<string, RepoGroup>();
  const add = ({ root, repo, path }: LocatedPath) => {
    const group = groups.get(repo) ?? { repo, paths: new Map() };
    groups.set(repo, group);
    if (!group.paths.has(path) && group.paths.size < MAX_PATHS) group.paths.set(path, root);
  };
  for (const path of raw.touchedPaths) {
    const located = locateFile(path);
    if (located) add(located);
  }

  if (raw.ranCommands) {
    const roots = new Set([home.root, ...[...groups.values()].flatMap((group) => [...group.paths.values()])]);
    for (const root of roots) {
      if (deleted.has(root)) continue;
      const info = infoFor(root);
      for (const path of changedDuringSession(root, info.changedPaths, startedAt)) add({ root, repo: info.repo, path });
    }
  }
  // Earlier captures may have seen files that git no longer reports as changed. They are located again
  // because a record written before its files' checkouts were told apart holds paths from several repos.
  for (const prior of existing) {
    const group = groups.get(prior.repo);
    const root = group ? mainRoot(group) : prior.repo === home.repo ? home.root : undefined;
    if (!root) continue;
    for (const path of prior.paths) {
      const located = locateFile(join(root, path));
      if (located) add(located);
    }
  }
  if (groups.size === 0) groups.set(home.repo, { repo: home.repo, paths: new Map() });

  const ordered = [...groups.values()].sort(
    (a, b) => b.paths.size - a.paths.size || Number(b.repo === home.repo) - Number(a.repo === home.repo),
  );
  const primary = ordered[0]!;
  const priorOf = (group: RepoGroup) => existing.find((record) => record.repo === group.repo);
  /** Branch, author, and commit come from the group's main checkout, or from its last record when that is deleted. */
  const gitOf = (group: RepoGroup): Pick<GitInfo, "branch" | "author" | "pr" | "head"> => {
    const root = mainRoot(group) ?? home.root;
    const prior = priorOf(group);
    if (deleted.has(root)) return { branch: prior?.branch, author: prior?.author ?? home.author };
    const info = infoFor(root);
    return { ...info, branch: info.branch ?? (info === home ? raw.branch : undefined) };
  };

  // The summarizer sees one list of files. With one checkout they are repo-relative; with several they
  // are relative to the folder the checkouts share, so the same path in two checkouts stays distinct.
  const roots = [...new Set(ordered.flatMap((group) => [...group.paths.values()]))];
  const base = roots.length === 1 ? roots[0]! : roots.length === 0 ? home.root : commonDir(roots);
  const owners = new Map<string, { repo: string; path: string }>();
  for (const group of ordered) {
    for (const [path, root] of group.paths) {
      const shown = roots.length === 1 ? path : normalizePath(relative(base, join(root, path)));
      owners.set(shown, { repo: group.repo, path });
    }
  }
  const shownPaths = [...owners.keys()];
  const input = { transcript, rendered: renderTranscript(transcript), paths: shownPaths, branch: gitOf(primary).branch };

  let summary: Summary;
  let failed = false;
  try {
    summary = await options.summarizer.summarize(input);
  } catch (error) {
    options.onWarning?.(`${options.summarizer.name} failed, using heuristic summary: ${String(error)}`);
    summary = await heuristicSummarizer().summarize(input);
    failed = true;
  }

  const verified = verifySummary(summary, transcript, base, shownPaths);
  if (verified.dropped > 0) {
    options.onWarning?.(`Dropped ${verified.dropped} summary item(s) that no transcript turn supports`);
  }
  /** An item goes to each repo whose files it cites. Items that cite no file go to the first record. */
  const itemsFor = (items: RecordItem[], repo: string): RecordItem[] =>
    items.flatMap((item) => {
      const paths = item.paths.flatMap((path) => {
        const owner = owners.get(path);
        return owner?.repo === repo ? [owner.path] : [];
      });
      if (paths.length === 0 && (item.paths.length > 0 || repo !== primary.repo)) return [];
      return [{ text: clean(item.text), paths: [...new Set(paths)] }];
    });

  // A capture that had no model to ask must not replace what a model wrote earlier: neither a failed call
  // nor the heuristic (which runs when the key is missing) knows more than the task and the files.
  const noModel = failed || options.summarizer.name === HEURISTIC;
  const keeps = (prior: ContextRecord): boolean =>
    failed ||
    (noModel && prior.decisions.length + prior.deadEnds.length + prior.openQuestions.length + prior.pending.length > 0);

  const now = (options.now ?? new Date()).toISOString();
  const records = ordered.map((group): ContextRecord => {
    const prior = priorOf(group);
    const kept = prior && keeps(prior) ? prior : undefined;
    const info = gitOf(group);
    const { branch } = info;
    return {
      id: prior?.id ?? crypto.randomUUID(),
      sessionKey,
      repo: group.repo,
      branch,
      pr: info.pr ?? prior?.pr,
      issue: issueFromBranch(branch, options.issuePattern) ?? prior?.issue,
      author: info.author,
      agent,
      startedAt: startedAt ?? now,
      updatedAt: now,
      task: kept?.task ?? (clean(summary.task) || prior?.task || "Untitled session"),
      paths: [...group.paths.keys()],
      decisions: kept?.decisions ?? itemsFor(verified.decisions, group.repo),
      deadEnds: kept?.deadEnds ?? itemsFor(verified.deadEnds, group.repo),
      openQuestions: kept?.openQuestions ?? itemsFor(verified.openQuestions, group.repo),
      pending: kept?.pending ?? itemsFor(verified.pending, group.repo),
      status: kept?.status ?? summary.status,
      commit: info.head ?? prior?.commit,
      transcriptRef: options.transcriptRef,
    };
  });
  for (const record of records) await store.upsert(record);
  // A record for a repo the session no longer has files in is left over from before its files were
  // known, or from before the repo's identity changed. One a model wrote stays until a model replaces it.
  for (const prior of existing) if (!groups.has(prior.repo) && !keeps(prior)) await store.delete(prior.id);
  return records;
}
