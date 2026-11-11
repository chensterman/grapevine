import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, realpathSync, statSync } from "node:fs";
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
export function realPath(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    const parent = dirname(path);
    return parent === path ? path : join(realPath(parent), basename(path));
  }
}

/** Converts a path to repo-relative form, following symlinks. Returns null for paths outside the repo. */
export function toRepoRelative(root: string, path: string): string | null {
  if (!isAbsolute(path)) {
    const normalized = normalizePath(path);
    return normalized && !normalized.startsWith("..") ? normalized : null;
  }
  for (const base of new Set([root, realPath(root)])) {
    for (const candidate of new Set([path, realPath(path)])) {
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

/** The git checkout containing `dir`, or null outside git. A worktree is its own root and shares its repo's remote. */
export function findRepo(dir: string): RepoIdentity | null {
  const root = git(dir, ["rev-parse", "--show-toplevel"]);
  return root ? checkoutAt(root) : null;
}

function checkoutAt(root: string): RepoIdentity {
  const remote = git(root, ["remote", "get-url", "origin"]);
  return { root, repo: remote ? normalizeRemote(remote) : `local/${basename(root)}` };
}

/** Outside git the folder stands in for a repo. Its root has symlinks resolved, as git's roots do. */
export function readRepoIdentity(cwd: string): RepoIdentity {
  return findRepo(cwd) ?? { root: realPath(cwd), repo: `local/${basename(cwd)}` };
}

export interface LocatedPath extends RepoIdentity {
  /** Relative to `root`. */
  path: string;
}

/** The nearest directory that exists at or above `path`, so deleted and not-yet-created files still resolve. */
function existingDir(path: string): string {
  for (let dir = path; ; dir = dirname(dir)) {
    try {
      if (statSync(dir).isDirectory()) return dir;
    } catch {
      // Keep walking up.
    }
    if (dirname(dir) === dir) return dir;
  }
}

/**
 * Returns a function that finds which checkout a path belongs to. Each path is resolved on its own,
 * so files in clones and worktrees nested under one workspace folder get their own repo. Relative
 * paths are taken from `home.root`. A file outside every checkout belongs to `home` when it is
 * inside that folder, and to nothing otherwise.
 */
export function createPathLocator(
  home: RepoIdentity,
  checkoutOf: (dir: string) => RepoIdentity | null = findRepo,
): (path: string) => LocatedPath | null {
  const byDir = new Map<string, RepoIdentity | null>();
  return (path) => {
    const absolute = isAbsolute(path) ? path : join(home.root, path);
    const dir = existingDir(absolute);
    if (!byDir.has(dir)) byDir.set(dir, checkoutOf(dir));
    for (const identity of [byDir.get(dir), home]) {
      const relativePath = identity ? toRepoRelative(identity.root, absolute) : null;
      if (identity && relativePath !== null) return { root: identity.root, repo: identity.repo, path: relativePath };
    }
    return null;
  };
}

const MAX_NESTED_CHECKOUTS = 100;

/**
 * Checkouts up to two levels below a folder, nearest first: clones and worktrees kept side by side in
 * a workspace folder that is not itself in git. A folder counts as a checkout when it has a `.git` entry.
 */
export function nestedCheckouts(dir: string): RepoIdentity[] {
  const found: RepoIdentity[] = [];
  let level = [realPath(dir)];
  for (let depth = 0; depth < 2; depth += 1) {
    const next: string[] = [];
    for (const parent of level) {
      let names: string[];
      try {
        names = readdirSync(parent, { withFileTypes: true })
          .filter((entry) => entry.isDirectory() && entry.name !== "node_modules" && entry.name !== ".git")
          .map((entry) => entry.name)
          .sort();
      } catch {
        continue;
      }
      for (const name of names) {
        const child = join(parent, name);
        if (!existsSync(join(child, ".git"))) next.push(child);
        else if (found.length < MAX_NESTED_CHECKOUTS) found.push(checkoutAt(child));
      }
    }
    level = next;
  }
  return found;
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
  const found = findRepo(cwd);
  const identity = found ?? readRepoIdentity(cwd);
  // Outside a checkout this reads the user's global git identity, so one person keeps one author value.
  const author =
    git(identity.root, ["config", "user.email"]) || git(identity.root, ["config", "user.name"]) || userInfo().username;
  if (!found) return { ...identity, author, changedPaths: [] };

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

/** `changedSinceRecord` against a local checkout of the record's repo, the first one listed when there are several. */
export function changedSinceIn(checkouts: RepoIdentity[]): (record: ContextRecord) => string[] {
  return (record) => {
    const checkout = checkouts.find((candidate) => candidate.repo === record.repo);
    return checkout ? changedSinceRecord(checkout.root, record) : [];
  };
}
