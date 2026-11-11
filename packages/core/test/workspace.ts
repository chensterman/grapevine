import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * A folder outside git holding clones `app` and `lib` plus `.worktrees/app-fix`, a worktree of `app`
 * on branch `fix`: the layout of a workspace with several repos. Returns its path, symlinks resolved.
 */
export function multiRepoWorkspace(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "grapevine-workspace-")));
  for (const name of ["app", "lib"]) {
    const root = join(dir, name);
    mkdirSync(root);
    const git = (...args: string[]) => Bun.spawnSync(["git", ...args], { cwd: root });
    git("init", "-q", "-b", "main");
    git("config", "user.email", "dev@acme.com");
    git("config", "user.name", "Dev");
    git("remote", "add", "origin", `git@github.com:acme/${name}.git`);
    writeFileSync(join(root, "README.md"), name);
    git("add", ".");
    git("commit", "-qm", "init");
  }
  Bun.spawnSync(["git", "worktree", "add", "-q", "-b", "fix", join(dir, ".worktrees", "app-fix")], { cwd: join(dir, "app") });
  return dir;
}
