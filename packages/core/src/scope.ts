import { createPathLocator, findRepo, nestedCheckouts, type RepoIdentity, readRepoIdentity } from "./git.ts";
import type { ScoredRecord, SearchQuery, Store } from "./store.ts";

/** Pass as the repo to look in every repo. */
export const ALL_REPOS = "*";

export interface ScopeOptions {
  /** Where the lookup runs. */
  cwd: string;
  /** Absolute, or relative to the root of the checkout at `cwd`. */
  paths?: string[];
  /** One repo id, or `ALL_REPOS`. Defaults to the repos at `cwd` and the repos the paths are in. */
  repo?: string;
}

/** Which repos a lookup covers, worked out from where it runs and the paths it asks about. */
export interface QueryScope {
  /** Undefined means every repo. */
  repos?: string[];
  /** One store search each. Paths are repo-relative, so paths in different repos are searched apart. */
  searches: Pick<SearchQuery, "repos" | "paths">[];
  /** Local checkouts of repos in scope, for flagging files that changed after a record was captured. */
  checkouts: RepoIdentity[];
}

/**
 * A folder inside a checkout covers that repo. A folder outside git covers itself and the checkouts
 * nested in it, the layout of a workspace that holds several clones and worktrees.
 */
export function resolveScope({ cwd, paths = [], repo }: ScopeOptions): QueryScope {
  const here = findRepo(cwd);
  const home = here ?? readRepoIdentity(cwd);
  const locate = createPathLocator(home);
  const located = paths.map(locate).filter((path) => path !== null);
  // Paths that resolve already say which repos are meant, so the folder is only scanned without them.
  const around = here ? [here] : located.length ? [] : nestedCheckouts(cwd);
  // Checkouts the paths are in come first: with several worktrees of a repo, those are the ones in use.
  const byRoot = new Map([...located, ...around].map(({ root, repo: id }) => [root, { root, repo: id }]));
  const checkouts = [...byRoot.values()];
  const allPaths = [...new Set(located.map((path) => path.path))];

  if (repo === ALL_REPOS) return { searches: [{ paths: allPaths }], checkouts };
  if (repo) return { repos: [repo], searches: [{ repos: [repo], paths: allPaths }], checkouts };

  const byRepo = new Map<string, Set<string>>();
  for (const path of located) byRepo.set(path.repo, (byRepo.get(path.repo) ?? new Set()).add(path.path));
  const repos = [...new Set([home.repo, ...around.map((checkout) => checkout.repo), ...byRepo.keys()])];
  const searches = byRepo.size
    ? [...byRepo].map(([pathRepo, repoPaths]) => ({ repos: [pathRepo], paths: [...repoPaths] }))
    : [{ repos, paths: [] }];
  return { repos, searches, checkouts };
}

/** Runs each of the scope's searches and returns the best results across them. */
export async function searchScope(
  store: Store,
  scope: QueryScope,
  query: Omit<SearchQuery, "repos" | "paths"> = {},
): Promise<ScoredRecord[]> {
  const limit = query.limit ?? 5;
  const best = new Map<string, ScoredRecord>();
  for (const search of scope.searches) {
    for (const result of await store.search({ ...query, ...search, limit })) {
      const seen = best.get(result.record.id);
      if (!seen || result.score > seen.score) best.set(result.record.id, result);
    }
  }
  return [...best.values()].sort((a, b) => b.score - a.score).slice(0, limit);
}
