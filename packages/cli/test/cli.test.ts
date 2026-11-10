import { describe, expect, setDefaultTimeout, test } from "bun:test";
import type { ContextRecord } from "@chensterman/grapevine-core";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

const CLI = join(import.meta.dir, "..", "src", "main.ts");
const FIXTURE = join(import.meta.dir, "..", "..", "adapter-claude-code", "test", "fixtures", "session.jsonl");
const CODEX_FIXTURE = join(import.meta.dir, "..", "..", "adapter-codex", "test", "fixtures", "session.jsonl");
const CURSOR_FIXTURE = join(import.meta.dir, "..", "..", "adapter-cursor", "test", "fixtures", "session.jsonl");

// Every test spawns the CLI, and cold starts on CI runners can exceed the 5s default.
setDefaultTimeout(30_000);

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
    GRAPEVINE_ANTHROPIC_API_KEY: "",
    GRAPEVINE_OPENAI_API_KEY: "",
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

async function waitForLog(path: string, needle: string): Promise<void> {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline && !(existsSync(path) && readFileSync(path, "utf8").includes(needle))) {
    await Bun.sleep(100);
  }
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
  });

  test("cursor hook captures using the workspace root", async () => {
    const { grapevineHome, run } = sandbox();
    const { repo } = repoWithTranscript();
    const transcript = join(repo, "..", `${repo.split("/").pop()}-conv-9.jsonl`);
    writeFileSync(transcript, readFileSync(CURSOR_FIXTURE, "utf8").replaceAll("/work/app", repo));
    const stdin = JSON.stringify({
      conversation_id: "conv-9",
      session_id: "conv-9",
      transcript_path: transcript,
      hook_event_name: "sessionEnd",
      workspace_roots: [repo],
    });

    expect(run(["hook", "cursor"], { stdin }).code).toBe(0);
    const logPath = join(grapevineHome, "logs", "capture.log");
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline && !(existsSync(logPath) && readFileSync(logPath, "utf8").includes("captured"))) {
      await Bun.sleep(100);
    }
    expect(readFileSync(logPath, "utf8")).toContain("captured");

    const [record] = JSON.parse(run(["recent", "--json"], { cwd: repo }).stdout) as ContextRecord[];
    expect(record?.agent).toBe("cursor");
    expect(record?.repo).toBe("github.com/acme/app");
    expect(record?.paths.sort()).toEqual(["src/webhooks/backoff.ts", "src/webhooks/retry.ts"]);
    expect(record?.task).toBe("Fix the webhook retry loop in src/webhooks/retry.ts so it backs off exponentially.");
  });

  test("hook ignores sessions that were never shared, unless capture mode is always", async () => {
    const { grapevineHome, run } = sandbox();
    const { repo, transcript } = repoWithTranscript();
    const unshared = readFileSync(transcript, "utf8")
      .split("\n")
      .map((line) => line.replace(/\{"type":"tool_use","id":"t0","name":"mcp__grapevine__share_session","input":\{\}\},/, ""))
      .join("\n");
    writeFileSync(transcript, unshared);
    const stdin = JSON.stringify({ session_id: "sess-123", transcript_path: transcript, cwd: repo, hook_event_name: "SessionEnd" });
    const logPath = join(grapevineHome, "logs", "capture.log");

    expect(run(["hook", "claude-code"], { stdin }).code).toBe(0);
    await Bun.sleep(1500);
    expect(existsSync(logPath) && readFileSync(logPath, "utf8").includes("captured")).toBe(false);

    writeFileSync(join(grapevineHome, "config.json"), JSON.stringify({ capture: { detectPr: false, mode: "always" } }));
    run(["hook", "claude-code"], { stdin });
    await waitForLog(logPath, "captured");
    expect(readFileSync(logPath, "utf8")).toContain("with heuristic");
  });

  test("stop_sharing deletes the session's record", async () => {
    const { grapevineHome, run } = sandbox();
    const { repo, transcript } = repoWithTranscript();
    const payload = (event: string) =>
      JSON.stringify({ session_id: "sess-123", transcript_path: transcript, cwd: repo, hook_event_name: event });

    run(["hook", "claude-code"], { stdin: payload("SessionEnd") });
    await waitForLog(join(grapevineHome, "logs", "capture.log"), "captured");
    expect(JSON.parse(run(["recent", "--json"], { cwd: repo }).stdout)).toHaveLength(1);

    const stop = {
      type: "assistant",
      sessionId: "sess-123",
      message: { role: "assistant", content: [{ type: "tool_use", id: "t9", name: "mcp__grapevine__stop_sharing", input: {} }] },
    };
    writeFileSync(transcript, `${readFileSync(transcript, "utf8")}\n${JSON.stringify(stop)}\n`);
    expect(run(["hook", "claude-code"], { stdin: payload("Stop") }).code).toBe(0);
    expect(JSON.parse(run(["recent", "--json"], { cwd: repo }).stdout)).toEqual([]);
  });

  test("key set reads a key from stdin; status reports its source but never the key", () => {
    const { grapevineHome, run } = sandbox();
    expect(run(["status"]).stdout).toContain("Capture: opt-in");
    expect(run(["status"]).stdout).toContain("Summarizer: heuristic");

    const saved = run(["key", "set", "openai"], { stdin: "not-a-real-key\n" });
    expect(saved.code).toBe(0);
    expect(saved.stdout + saved.stderr).not.toContain("not-a-real-key");
    expect(statSync(join(grapevineHome, "credentials.json")).mode & 0o777).toBe(0o600);

    const status = run(["status"]).stdout;
    expect(status).toContain("openai-compatible (gpt-5-mini), key from saved openai key");
    expect(status).not.toContain("not-a-real-key");

    expect(run(["key", "remove", "openai"]).code).toBe(0);
    expect(run(["status"]).stdout).toContain("Summarizer: heuristic");
  });

  test("hook exits 0 and logs to GRAPEVINE_HOME when config is corrupt", () => {
    const { grapevineHome, run } = sandbox();
    writeFileSync(join(grapevineHome, "config.json"), "{ broken");
    const stdin = JSON.stringify({ session_id: "s", transcript_path: "/nope.jsonl" });

    expect(run(["hook", "claude-code"], { stdin }).code).toBe(0);
    expect(readFileSync(join(grapevineHome, "logs", "hook.log"), "utf8")).toContain("hook failed");
  });

  test("init installs hooks and MCP config idempotently, uninstall removes them", () => {
    const { home, run } = sandbox();
    mkdirSync(join(home, ".claude"));
    mkdirSync(join(home, ".cursor"));
    mkdirSync(join(home, ".codex"));
    const claudeSettings = join(home, ".claude", "settings.json");
    writeFileSync(claudeSettings, JSON.stringify({ model: "opus" }));
    const codexHooksPath = join(home, ".codex", "hooks.json");
    const otherCodexHook = { hooks: { Stop: [{ hooks: [{ type: "command", command: "other-tool turn-end", timeout: 10 }] }] } };
    writeFileSync(codexHooksPath, JSON.stringify(otherCodexHook));

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
    const cursorHooksPath = join(home, ".cursor", "hooks.json");
    const cursorHooks = JSON.parse(readFileSync(cursorHooksPath, "utf8"));
    expect(cursorHooks.version).toBe(1);
    expect(cursorHooks.hooks.stop[0].command).toContain("hook cursor");
    expect(cursorHooks.hooks.sessionEnd).toHaveLength(1);
    const codexHooks = JSON.parse(readFileSync(codexHooksPath, "utf8"));
    expect(codexHooks.hooks.Stop).toHaveLength(2);
    expect(codexHooks.hooks.SessionEnd[0].hooks[0].command).toContain("hook codex");
    expect(first.stdout).toContain("codex CLI not found; register manually with: codex mcp add grapevine --");
    expect(first.stdout).toContain("trust grapevine's hooks in Codex");

    const second = run(["init"]).stdout;
    expect(second).toContain("Cursor hooks already installed");
    expect(second).toContain("Codex hooks already installed");

    expect(run(["uninstall"]).code).toBe(0);
    expect(JSON.parse(readFileSync(claudeSettings, "utf8"))).toEqual({ model: "opus" });
    expect(JSON.parse(readFileSync(join(home, ".cursor", "mcp.json"), "utf8")).mcpServers).toEqual({});
    expect(JSON.parse(readFileSync(cursorHooksPath, "utf8"))).toEqual({ version: 1, hooks: {} });
    expect(JSON.parse(readFileSync(codexHooksPath, "utf8"))).toEqual(otherCodexHook);
  });

  test("codex hook captures a shared Codex session", async () => {
    const { grapevineHome, run } = sandbox();
    const { repo } = repoWithTranscript();
    const transcript = join(repo, "..", `${repo.split("/").pop()}-rollout.jsonl`);
    writeFileSync(transcript, readFileSync(CODEX_FIXTURE, "utf8").replaceAll("/work/app", repo));
    const stdin = JSON.stringify({ session_id: "thread-1", transcript_path: transcript, cwd: repo, hook_event_name: "SessionEnd" });

    expect(run(["hook", "codex"], { stdin }).code).toBe(0);
    await waitForLog(join(grapevineHome, "logs", "capture.log"), "captured");
    const [record] = JSON.parse(run(["recent", "--json"], { cwd: repo }).stdout) as ContextRecord[];
    expect(record?.agent).toBe("codex");
    expect(record?.sessionKey).toBe("codex:thread-1");
    expect(record?.paths).toContain("src/webhooks/backoff.ts");
    expect(record?.task).toStartWith("Fix the webhook retry loop");
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
