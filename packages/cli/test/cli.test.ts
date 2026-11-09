import { describe, expect, test } from "bun:test";
import type { ContextRecord } from "@chensterman/grapevine-core";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

const CLI = join(import.meta.dir, "..", "src", "main.ts");
const FIXTURE = join(import.meta.dir, "..", "..", "adapter-claude-code", "test", "fixtures", "session.jsonl");

function tempDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), `grapevine-${prefix}-`));
}

/** Isolated environment: own grapevine home and HOME, no API keys, no `claude` on PATH. */
function sandbox() {
  const home = tempDir("home");
  const grapevineHome = join(home, ".grapevine");
  mkdirSync(grapevineHome, { recursive: true });
  writeFileSync(join(grapevineHome, "config.json"), JSON.stringify({ capture: { detectPr: false } }));
  const env = {
    ...process.env,
    HOME: home,
    GRAPEVINE_HOME: grapevineHome,
    ANTHROPIC_API_KEY: "",
    OPENAI_API_KEY: "",
    PATH: `${dirname(process.execPath)}:/usr/bin:/bin`,
  };
  const run = (args: string[], options: { cwd?: string; stdin?: string } = {}) => {
    const result = Bun.spawnSync([process.execPath, CLI, ...args], {
      cwd: options.cwd ?? home,
      env,
      stdin: options.stdin === undefined ? "ignore" : Buffer.from(options.stdin),
    });
    return { code: result.exitCode, stdout: result.stdout.toString(), stderr: result.stderr.toString() };
  };
  return { home, grapevineHome, run };
}

/** A git repo on a feature branch plus a Claude Code transcript whose paths point into it. */
function repoWithTranscript(): { repo: string; transcript: string } {
  const repo = tempDir("repo");
  const git = (...args: string[]) => Bun.spawnSync(["git", ...args], { cwd: repo });
  git("init", "-q", "-b", "main");
  git("config", "user.email", "dev@acme.com");
  git("config", "user.name", "Dev");
  git("remote", "add", "origin", "https://github.com/acme/app.git");
  writeFileSync(join(repo, "README.md"), "hi");
  git("add", ".");
  git("commit", "-qm", "init");
  git("checkout", "-qb", "leon/eng-42-retry-backoff");
  mkdirSync(join(repo, "src", "webhooks"), { recursive: true });
  writeFileSync(join(repo, "src", "webhooks", "retry.ts"), "export {}");

  const transcript = join(repo, "..", `${repo.split("/").pop()}-session.jsonl`);
  writeFileSync(transcript, readFileSync(FIXTURE, "utf8").replaceAll("/work/app", repo));
  return { repo, transcript };
}

describe("grapevine CLI", () => {
  test("prints usage", () => {
    const { run } = sandbox();
    expect(run(["--help"]).stdout).toContain("grapevine init");
    expect(run(["nope"]).code).toBe(1);
  });

  test("captures a transcript and finds it by path and text", () => {
    const { run } = sandbox();
    const { repo, transcript } = repoWithTranscript();

    const captured = run(["capture", "--transcript", transcript, "--summarizer", "heuristic", "--json"]);
    expect(captured.code).toBe(0);
    const record = JSON.parse(captured.stdout) as ContextRecord;
    expect(record.repo).toBe("github.com/acme/app");
    expect(record.branch).toBe("leon/eng-42-retry-backoff");
    expect(record.task).toBe("Fix the webhook retry loop in src/webhooks/retry.ts so it backs off exponentially.");
    expect(record.paths.sort()).toEqual(["src/webhooks/backoff.ts", "src/webhooks/retry.ts"]);
    expect(JSON.stringify(record)).not.toContain("sk-ant-");

    const recaptured = JSON.parse(
      run(["capture", "--transcript", transcript, "--summarizer", "heuristic", "--json"]).stdout,
    ) as ContextRecord;
    expect(recaptured.id).toBe(record.id);

    const byPath = run(["search", "-p", "webhooks/retry.ts", "--json"], { cwd: join(repo, "src") });
    expect(byPath.code).toBe(0);
    const results = JSON.parse(byPath.stdout) as { record: ContextRecord }[];
    expect(results.map((result) => result.record.id)).toEqual([record.id]);

    expect(run(["search", "webhook", "retry"], { cwd: repo }).stdout).toContain("### Fix the webhook retry loop");
    expect(run(["search", "-p", "src/webhooks/retry.ts"], { cwd: tempDir("elsewhere") }).stdout).toContain(
      "No matching records.",
    );
    expect(run(["recent", "--all-repos"]).stdout).toContain("Fix the webhook retry loop");
  });

  test("hook captures in the background and throttles mid-session captures", async () => {
    const { grapevineHome, run } = sandbox();
    const { repo, transcript } = repoWithTranscript();
    const payload = (event: string) =>
      JSON.stringify({ session_id: "sess-123", transcript_path: transcript, cwd: repo, hook_event_name: event });

    expect(run(["hook", "claude-code"], { stdin: "not json" }).code).toBe(0);
    expect(run(["hook", "claude-code"], { stdin: payload("Stop") }).code).toBe(0);

    const logPath = join(grapevineHome, "logs", "capture.log");
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline && !(existsSync(logPath) && readFileSync(logPath, "utf8").includes("captured"))) {
      await Bun.sleep(100);
    }
    expect(readFileSync(logPath, "utf8")).toContain("captured");

    const lines = () => readFileSync(logPath, "utf8").split("\n").filter(Boolean).length;
    const before = lines();
    run(["hook", "claude-code"], { stdin: payload("Stop") });
    await Bun.sleep(1500);
    expect(lines()).toBe(before);
  }, 30_000);

  test("init installs hooks and MCP config idempotently, uninstall removes them", () => {
    const { home, run } = sandbox();
    mkdirSync(join(home, ".claude"));
    mkdirSync(join(home, ".cursor"));
    const claudeSettings = join(home, ".claude", "settings.json");
    writeFileSync(claudeSettings, JSON.stringify({ model: "opus" }));

    const first = run(["init"]);
    expect(first.code).toBe(0);
    expect(first.stdout).toContain("context_for");
    const settings = JSON.parse(readFileSync(claudeSettings, "utf8"));
    expect(settings.model).toBe("opus");
    expect(settings.hooks.Stop[0].hooks[0].command).toContain("hook claude-code");
    expect(settings.hooks.SessionEnd).toHaveLength(1);
    expect(existsSync(`${claudeSettings}.grapevine-backup`)).toBe(true);
    const cursor = JSON.parse(readFileSync(join(home, ".cursor", "mcp.json"), "utf8"));
    expect(cursor.mcpServers.grapevine.args.at(-1)).toBe("mcp");

    expect(run(["init"]).stdout).toContain("already installed");

    expect(run(["uninstall"]).code).toBe(0);
    expect(JSON.parse(readFileSync(claudeSettings, "utf8"))).toEqual({ model: "opus" });
    expect(JSON.parse(readFileSync(join(home, ".cursor", "mcp.json"), "utf8")).mcpServers).toEqual({});
  });

  test("init --dry-run writes nothing", () => {
    const { home, grapevineHome, run } = sandbox();
    mkdirSync(join(home, ".claude"));
    const result = run(["init", "--dry-run"]);
    expect(result.stdout).toContain("would update");
    expect(existsSync(join(home, ".claude", "settings.json"))).toBe(false);
    expect(existsSync(join(grapevineHome, "grapevine.db"))).toBe(false);
  });
});
