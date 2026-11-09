import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { issueFromBranch, normalizeRemote, readGitInfo, toRepoRelative } from "../src/git.ts";

describe("normalizeRemote", () => {
  test.each([
    ["git@github.com:Acme/App.git", "github.com/acme/app"],
    ["https://github.com/acme/app.git", "github.com/acme/app"],
    ["https://user:pass@github.com/acme/app/", "github.com/acme/app"],
    ["ssh://git@gitlab.example.com:2222/team/app.git", "gitlab.example.com/team/app"],
  ])("%s", (url, expected) => {
    expect(normalizeRemote(url)).toBe(expected);
  });
});

describe("issueFromBranch", () => {
  test("uses the configured pattern only", () => {
    expect(issueFromBranch("leon/eng-42-retry", "([a-z]+-\\d+)")).toBe("ENG-42");
    expect(issueFromBranch("leon/eng-42-retry", undefined)).toBeUndefined();
    expect(issueFromBranch("main", "([a-z]+-\\d+)")).toBeUndefined();
  });
});

function gitRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "grapevine-git-"));
  const run = (...args: string[]) => Bun.spawnSync(["git", ...args], { cwd: dir });
  run("init", "-q", "-b", "main");
  run("config", "user.email", "dev@acme.com");
  run("config", "user.name", "Dev");
  run("remote", "add", "origin", "git@github.com:acme/app.git");
  writeFileSync(join(dir, "README.md"), "hi");
  run("add", ".");
  run("commit", "-qm", "init");
  run("checkout", "-qb", "feature");
  mkdirSync(join(dir, "src"));
  writeFileSync(join(dir, "src", "committed.ts"), "1");
  run("add", ".");
  run("commit", "-qm", "feature");
  writeFileSync(join(dir, "README.md"), "changed");
  writeFileSync(join(dir, "src", "new.ts"), "2");
  return dir;
}

describe("readGitInfo", () => {
  test("collects repo identity and branch changes since main", () => {
    const dir = gitRepo();
    const info = readGitInfo(join(dir, "src"));
    expect(info.repo).toBe("github.com/acme/app");
    expect(info.branch).toBe("feature");
    expect(info.author).toBe("dev@acme.com");
    expect(info.changedPaths.sort()).toEqual(["README.md", "src/committed.ts", "src/new.ts"]);
  });

  test("falls back to a local identity outside git", () => {
    const dir = mkdtempSync(join(tmpdir(), "grapevine-nogit-"));
    const info = readGitInfo(dir);
    expect(info.repo).toStartWith("local/grapevine-nogit-");
    expect(info.changedPaths).toEqual([]);
  });
});

describe("toRepoRelative", () => {
  test("handles symlinked temp dirs, relative paths, and outside paths", () => {
    const dir = gitRepo();
    const root = readGitInfo(dir).root;
    expect(toRepoRelative(root, join(dir, "src", "new.ts"))).toBe("src/new.ts");
    expect(toRepoRelative(root, join(dir, "not", "created", "yet.ts"))).toBe("not/created/yet.ts");
    expect(toRepoRelative(root, "./src/new.ts")).toBe("src/new.ts");
    expect(toRepoRelative(root, "../elsewhere.ts")).toBeNull();
    expect(toRepoRelative(root, "/etc/hosts")).toBeNull();
  });
});
