import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { ALL_REPOS, resolveScope, searchScope } from "../src/scope.ts";
import type { ScoredRecord, SearchQuery, Store } from "../src/store.ts";
import type { ContextRecord } from "../src/types.ts";
import { multiRepoWorkspace } from "./workspace.ts";

const APP = "github.com/acme/app";
const LIB = "github.com/acme/lib";

describe("resolveScope", () => {
  const dir = multiRepoWorkspace();
  const local = `local/${basename(dir)}`;

  test("a folder outside git covers itself and the checkouts nested in it", () => {
    const scope = resolveScope({ cwd: dir });
    expect(scope.repos).toEqual([local, APP, LIB]);
    expect(scope.searches).toEqual([{ repos: [local, APP, LIB], paths: [] }]);
    expect(scope.checkouts.map((checkout) => checkout.root)).toEqual([
      join(dir, "app"),
      join(dir, "lib"),
      join(dir, ".worktrees", "app-fix"),
    ]);
  });

  test("searches each path in the repo it belongs to, with repo-relative paths", () => {
    const scope = resolveScope({
      cwd: dir,
      paths: [join(dir, "lib", "index.ts"), ".worktrees/app-fix/src/b.ts", "app/src/b.ts", "notes.md", "/somewhere/else.ts"],
    });
    expect(scope.searches).toEqual([
      { repos: [LIB], paths: ["index.ts"] },
      { repos: [APP], paths: ["src/b.ts"] },
      { repos: [local], paths: ["notes.md"] },
    ]);
    // The worktree the caller asked about comes first, so "changed since" is checked against it.
    expect(scope.checkouts.find((checkout) => checkout.repo === APP)?.root).toBe(join(dir, ".worktrees", "app-fix"));
  });

  test("a folder inside a checkout covers that repo, and relative paths start at its root", () => {
    mkdirSync(join(dir, "app", "src"), { recursive: true });
    const scope = resolveScope({ cwd: join(dir, "app", "src"), paths: ["src/a.ts", join(dir, "lib", "index.ts")] });
    expect(scope.repos).toEqual([APP, LIB]);
    expect(scope.searches).toEqual([
      { repos: [APP], paths: ["src/a.ts"] },
      { repos: [LIB], paths: ["index.ts"] },
    ]);
    expect(resolveScope({ cwd: join(dir, "app", "src") }).repos).toEqual([APP]);
  });

  test("an explicit repo or every repo overrides where the paths are", () => {
    const paths = [join(dir, "lib", "index.ts")];
    expect(resolveScope({ cwd: dir, paths, repo: "github.com/acme/fork" }).searches).toEqual([
      { repos: ["github.com/acme/fork"], paths: ["index.ts"] },
    ]);
    const everywhere = resolveScope({ cwd: dir, paths, repo: ALL_REPOS });
    expect(everywhere.repos).toBeUndefined();
    expect(everywhere.searches).toEqual([{ paths: ["index.ts"] }]);
  });

  test("an empty folder outside git covers only itself", () => {
    const empty = mkdtempSync(join(tmpdir(), "grapevine-empty-"));
    expect(resolveScope({ cwd: empty, paths: ["src/a.ts"] }).searches).toEqual([
      { repos: [`local/${basename(empty)}`], paths: ["src/a.ts"] },
    ]);
  });
});

describe("searchScope", () => {
  test("merges the scope's searches by score, keeping each record once", async () => {
    const result = (id: string, score: number) => ({ record: { id } as ContextRecord, score, matchedPaths: [] });
    const byRepo: Record<string, ScoredRecord[]> = {
      [APP]: [result("a", 1.5), result("shared", 0.4)],
      [LIB]: [result("b", 1.8), result("shared", 0.9), result("c", 0.2)],
    };
    const queries: SearchQuery[] = [];
    const store = {
      search: async (query: SearchQuery) => {
        queries.push(query);
        return byRepo[query.repos?.[0] ?? ""] ?? [];
      },
    } as unknown as Store;
    const scope = {
      repos: [APP, LIB],
      searches: [
        { repos: [APP], paths: ["src/a.ts"] },
        { repos: [LIB], paths: ["index.ts"] },
      ],
      checkouts: [],
    };

    const results = await searchScope(store, scope, { text: "retry", limit: 3 });
    expect(results.map(({ record, score }) => [record.id, score])).toEqual([
      ["b", 1.8],
      ["a", 1.5],
      ["shared", 0.9],
    ]);
    expect(queries).toEqual([
      { text: "retry", limit: 3, repos: [APP], paths: ["src/a.ts"] },
      { text: "retry", limit: 3, repos: [LIB], paths: ["index.ts"] },
    ]);
  });
});
