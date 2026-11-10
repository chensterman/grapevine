import { execFileSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { userInfo } from "node:os";
import { basename, dirname, isAbsolute, join, relative } from "node:path";
import { normalizePath } from "./rank.ts";
import type { ContextRecord } from "./types.ts";

const MAX_CHANGED_PATHS = 200;

export interface RepoIdentity {
  root: string;
  repo: string;
}

export interface GitInfo extends RepoIdentity {
  branch?: string;
  author: string;
  changedPaths: string[];
  pr?: string;
  head?: string;
}

function run(cmd: string, args: string[], cwd: string, timeout = 5000): string | null {
  try {
    return execFileSync(cmd, args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout }).trim();
  } catch {
    return null;
  }
}

const git = (cwd: string, args: string[]) => run("git", args, cwd);

/** `git@github.com:Org/Repo.git` and `https://github.com/org/repo` both become `github.com/org/repo`. */
export function normalizeRemote(url: string): string {
  const trimmed = url.trim().replace(/\/+$/, "").replace(/\.git$/, "");
  const scp = trimmed.match(/^[^@/]+@([^:/]+):(.+)$/);
  if (scp) return `${scp[1]}/${scp[2]}`.toLowerCase();
  try {
    const parsed = new URL(trimmed);
    return `${parsed.hostname}${parsed.pathname}`.toLowerCase();
  } catch {
    return trimmed.toLowerCase();
  }
}

/** Resolves symlinks in the longest existing prefix, so deleted or not-yet-created files still resolve. */
function real(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    const parent = dirname(path);
    return parent === path ? path : join(real(parent), basename(path));
  }
}

/** Converts a path to repo-relative form, following symlinks. Returns null for paths outside the repo. */
export function toRepoRelative(root: string, path: string): string | null {
  if (!isAbsolute(path)) {
    const normalized = normalizePath(path);
    return normalized && !normalized.startsWith("..") ? normalized : null;
  }
  for (const base of new Set([root, real(root)])) {
    for (const candidate of new Set([path, real(path)])) {
      const rel = relative(base, candidate);
      if (rel && !rel.startsWith("..") && !isAbsolute(rel)) return normalizePath(rel);
    }
  }
  return null;
}

export function issueFromBranch(branch: string | undefined, pattern: string | undefined): string | undefined {
  if (!branch || !pattern) return undefined;
  const match = branch.match(new RegExp(pattern, "i"));
  return (match?.[1] ?? match?.[0])?.toUpperCase();
}

export function readRepoIdentity(cwd: string): RepoIdentity {
  const root = git(cwd, ["rev-parse", "--show-toplevel"]);
  if (!root) return { root: cwd, repo: `local/${basename(cwd)}` };
  const remote = git(root, ["remote", "get-url", "origin"]);
  return { root, repo: remote ? normalizeRemote(remote) : `local/${basename(root)}` };
}

function defaultBranchRef(root: string): string | null {
  const head = git(root, ["symbolic-ref", "--quiet", "refs/remotes/origin/HEAD"]);
  if (head) return head;
  for (const ref of ["origin/main", "origin/master", "main", "master"]) {
    if (git(root, ["rev-parse", "--verify", "--quiet", ref])) return ref;
  }
  return null;
}

function lines(output: string | null): string[] {
  return output ? output.split("\n").filter(Boolean) : [];
}

/** Paths changed on this branch since it left the default branch, plus uncommitted and untracked files. */
export function changedPaths(root: string): string[] {
  const base = defaultBranchRef(root);
  const mergeBase = base ? git(root, ["merge-base", "HEAD", base]) : null;
  const paths = new Set([
    ...(mergeBase ? lines(git(root, ["diff", "--name-only", mergeBase, "HEAD"])) : []),
    ...lines(git(root, ["diff", "--name-only", "HEAD"])),
    ...lines(git(root, ["ls-files", "--others", "--exclude-standard"])),
  ]);
  return [...paths].slice(0, MAX_CHANGED_PATHS);
}

export function readGitInfo(cwd: string, options: { detectPr?: boolean } = {}): GitInfo {
  const identity = readRepoIdentity(cwd);
  const isRepo = identity.root !== cwd || git(cwd, ["rev-parse", "--git-dir"]) !== null;
  const author =
    (isRepo && (git(identity.root, ["config", "user.email"]) || git(identity.root, ["config", "user.name"]))) ||
    userInfo().username;
  if (!isRepo) return { ...identity, author, changedPaths: [] };

  const branch = git(identity.root, ["rev-parse", "--abbrev-ref", "HEAD"]);
  const pr = options.detectPr ? run("gh", ["pr", "view", "--json", "url", "-q", ".url"], identity.root, 8000) : null;
  return {
    ...identity,
    branch: branch && branch !== "HEAD" ? branch : undefined,
    author,
    changedPaths: changedPaths(identity.root),
    pr: pr || undefined,
    head: git(identity.root, ["rev-parse", "HEAD"]) || undefined,
  };
}

/**
 * Which of a record's paths commits on HEAD changed after the record was captured. Counts from the
 * record's commit when this clone has it, so commits already behind it don't count.
 */
export function changedSinceRecord(root: string, record: Pick<ContextRecord, "paths" | "updatedAt" | "commit">): string[] {
  if (record.paths.length === 0) return [];
  const known = record.commit && git(root, ["cat-file", "-e", `${record.commit}^{commit}`]) !== null;
  const range = known ? `${record.commit}..HEAD` : "HEAD";
  const output = git(root, ["log", range, `--since=${record.updatedAt}`, "--name-only", "--format=", "--", ...record.paths]);
  const paths = new Set(record.paths);
  return [...new Set(lines(output))].filter((path) => paths.has(path));
}

/** `changedSinceRecord` against the local clone, for records from the same repo. */
export function changedSinceIn(identity: RepoIdentity): (record: ContextRecord) => string[] {
  return (record) => (record.repo === identity.repo ? changedSinceRecord(identity.root, record) : []);
}
