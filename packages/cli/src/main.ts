#!/usr/bin/env bun
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { AGENT as CLAUDE_CODE, parseClaudeTranscript, parseHookInput } from "@chensterman/grapevine-adapter-claude-code";
import {
  capture,
  createSummarizer,
  formatRecord,
  formatResults,
  type GrapevineConfig,
  grapevineHome,
  heuristicSummarizer,
  loadConfig,
  readRepoIdentity,
  type Store,
  type Summarizer,
  type SummarizerProvider,
  storePath,
  toRepoRelative,
  VERSION,
} from "@chensterman/grapevine-core";
import { runStdioServer } from "@chensterman/grapevine-mcp";
import { openSqliteStore } from "@chensterman/grapevine-store-sqlite";
import { detectAgents, install, RULES_SNIPPET, uninstall } from "./install.ts";
import { selfCommand, shellCommand } from "./self.ts";

const USAGE = `grapevine ${VERSION} — passive, path-indexed team memory for coding agents

Usage:
  grapevine init [--dry-run] [--claude-code] [--cursor]
      Install capture hooks and register the MCP server. Detects installed agents by default.
  grapevine uninstall [--dry-run]
      Remove hooks and MCP registration. Keeps your records.
  grapevine search [text...] [-p <path>]... [--repo <id> | --all-repos] [-n <limit>] [--json]
      Find records by path and/or text, scoped to the current repo by default.
  grapevine recent [--repo <id> | --all-repos] [-n <limit>] [--json]
      List the most recent sessions.
  grapevine capture --transcript <file> [--agent claude-code] [--cwd <dir>] [--summarizer <provider>] [--json]
      Summarize and store one session now.
  grapevine hook claude-code
      Claude Code hook entry point. Reads hook JSON on stdin and captures in the background.
  grapevine mcp
      Run the MCP server on stdio.

Environment:
  GRAPEVINE_HOME      Config, database, and logs (default ~/.grapevine)
  ANTHROPIC_API_KEY   Enables the Anthropic summarizer when provider is "auto"
  OPENAI_API_KEY      Enables the OpenAI-compatible summarizer when provider is "auto"
`;

const PROVIDERS: SummarizerProvider[] = ["auto", "anthropic", "openai-compatible", "heuristic"];

interface Context {
  home: string;
  config: GrapevineConfig;
}

function openStore(ctx: Context): Store {
  return openSqliteStore(storePath(ctx.config, ctx.home));
}

function log(message: string): void {
  console.error(`[${new Date().toISOString()}] ${message}`);
}

function resolveSummarizer(ctx: Context, override?: string): Summarizer {
  if (override && !PROVIDERS.includes(override as SummarizerProvider)) {
    throw new Error(`Unknown summarizer "${override}". Use one of: ${PROVIDERS.join(", ")}`);
  }
  const config = override ? { ...ctx.config.summarizer, provider: override as SummarizerProvider } : ctx.config.summarizer;
  try {
    return createSummarizer(config);
  } catch (error) {
    log(`${(error as Error).message}; falling back to heuristic summaries`);
    return heuristicSummarizer();
  }
}

function scopeRepo(cwd: string, values: { repo?: string; "all-repos"?: boolean }) {
  const identity = readRepoIdentity(cwd);
  return { identity, repo: values["all-repos"] ? undefined : (values.repo ?? identity.repo) };
}

async function commandCapture(ctx: Context, args: string[]): Promise<void> {
  const { values } = parseArgs({
    args,
    options: {
      transcript: { type: "string" },
      agent: { type: "string", default: CLAUDE_CODE },
      cwd: { type: "string" },
      summarizer: { type: "string" },
      json: { type: "boolean", default: false },
    },
  });
  if (!values.transcript) throw new Error("capture needs --transcript <file>");
  if (values.agent !== CLAUDE_CODE) throw new Error(`Unsupported agent "${values.agent}". Supported: ${CLAUDE_CODE}`);

  const transcriptPath = resolve(values.transcript);
  const transcript = parseClaudeTranscript(readFileSync(transcriptPath, "utf8"), basename(transcriptPath, ".jsonl"));
  const store = openStore(ctx);
  try {
    const record = await capture({
      transcript,
      agent: values.agent,
      store,
      summarizer: resolveSummarizer(ctx, values.summarizer),
      cwd: values.cwd ?? transcript.cwd,
      redactPatterns: ctx.config.redact.patterns,
      transcriptRef: transcriptPath,
      detectPr: ctx.config.capture.detectPr,
      issuePattern: ctx.config.capture.issuePattern,
      onWarning: log,
    });
    if (!record) {
      log(`skipped ${transcriptPath}: no user messages`);
      return;
    }
    if (values.json) console.log(JSON.stringify(record, null, 2));
    else log(`captured ${record.id} in ${record.repo}: ${record.task}`);
  } finally {
    store.close();
  }
}

async function commandHook(ctx: Context, args: string[]): Promise<void> {
  if (args[0] !== CLAUDE_CODE) throw new Error(`Unsupported hook "${args[0] ?? ""}". Supported: ${CLAUDE_CODE}`);
  const input = parseHookInput(await Bun.stdin.text());
  if (!input) return;

  const stateDir = join(ctx.home, "state");
  const logDir = join(ctx.home, "logs");
  mkdirSync(stateDir, { recursive: true });
  mkdirSync(logDir, { recursive: true });
  const key = createHash("sha256").update(`${CLAUDE_CODE}:${input.session_id}`).digest("hex").slice(0, 24);
  const stateFile = join(stateDir, `${key}.json`);
  const lastCaptureAt = existsSync(stateFile)
    ? ((JSON.parse(readFileSync(stateFile, "utf8")) as { lastCaptureAt?: number }).lastCaptureAt ?? 0)
    : 0;
  const isSessionEnd = input.hook_event_name === "SessionEnd";
  if (!isSessionEnd && Date.now() - lastCaptureAt < ctx.config.capture.minIntervalMinutes * 60_000) return;
  writeFileSync(stateFile, JSON.stringify({ lastCaptureAt: Date.now() }));

  const [command, ...prefix] = selfCommand();
  const out = openSync(join(logDir, "capture.log"), "a");
  const child = spawn(
    command!,
    [...prefix, "capture", "--agent", CLAUDE_CODE, "--transcript", input.transcript_path, "--cwd", input.cwd ?? process.cwd()],
    { detached: true, stdio: ["ignore", out, out], env: process.env },
  );
  child.unref();
}

async function commandSearch(ctx: Context, args: string[]): Promise<void> {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: {
      path: { type: "string", short: "p", multiple: true },
      repo: { type: "string" },
      "all-repos": { type: "boolean", default: false },
      limit: { type: "string", short: "n", default: "5" },
      json: { type: "boolean", default: false },
    },
  });
  const cwd = process.cwd();
  const { identity, repo } = scopeRepo(cwd, values);
  const paths = (values.path ?? [])
    .map((path) => toRepoRelative(identity.root, resolve(cwd, path)))
    .filter((path): path is string => path !== null);
  const store = openStore(ctx);
  try {
    const results = await store.search({ repo, paths, text: positionals.join(" "), limit: Number(values.limit) });
    if (values.json) console.log(JSON.stringify(results, null, 2));
    else console.log(results.length ? formatResults(results) : "No matching records.");
  } finally {
    store.close();
  }
}

async function commandRecent(ctx: Context, args: string[]): Promise<void> {
  const { values } = parseArgs({
    args,
    options: {
      repo: { type: "string" },
      "all-repos": { type: "boolean", default: false },
      limit: { type: "string", short: "n", default: "10" },
      json: { type: "boolean", default: false },
    },
  });
  const { repo } = scopeRepo(process.cwd(), values);
  const store = openStore(ctx);
  try {
    const records = await store.recent({ repo, limit: Number(values.limit) });
    if (values.json) console.log(JSON.stringify(records, null, 2));
    else console.log(records.length ? records.map((record) => formatRecord(record)).join("\n\n") : "No sessions recorded yet.");
  } finally {
    store.close();
  }
}

function agentFlags(args: string[]) {
  const { values } = parseArgs({
    args,
    options: {
      "dry-run": { type: "boolean", default: false },
      "claude-code": { type: "boolean" },
      cursor: { type: "boolean" },
    },
  });
  const explicit = values["claude-code"] !== undefined || values.cursor !== undefined;
  const detected = detectAgents();
  return {
    dryRun: values["dry-run"],
    claudeCode: explicit ? Boolean(values["claude-code"]) : detected.claudeCode,
    cursor: explicit ? Boolean(values.cursor) : detected.cursor,
  };
}

function runClaude(args: string[]): string {
  if (!Bun.which("claude")) return `claude CLI not found; register manually with: claude ${shellCommand(args)}`;
  const result = spawnSync("claude", args, { encoding: "utf8" });
  return (result.stdout || result.stderr || "").trim() || `ran: claude ${shellCommand(args)}`;
}

function commandInit(ctx: Context, args: string[]): void {
  const flags = agentFlags(args);
  if (!flags.claudeCode && !flags.cursor) console.log("No supported agents detected. Pass --claude-code or --cursor.");
  install({
    home: ctx.home,
    self: selfCommand(),
    ...flags,
    registerClaudeMcp: (command) => {
      spawnSync("claude", ["mcp", "remove", "--scope", "user", "grapevine"], { encoding: "utf8" });
      return runClaude(["mcp", "add", "--scope", "user", "grapevine", "--", ...command]);
    },
    log: (line) => console.log(line),
  });
  console.log(`\nAdd this to your AGENTS.md / CLAUDE.md / Cursor rules so agents use it:\n\n${RULES_SNIPPET}\n`);
}

function commandUninstall(ctx: Context, args: string[]): void {
  uninstall({
    home: ctx.home,
    ...agentFlags(args),
    unregisterClaudeMcp: () => runClaude(["mcp", "remove", "--scope", "user", "grapevine"]),
    log: (line) => console.log(line),
  });
}

export async function main(argv: string[]): Promise<number> {
  const [command, ...args] = argv;
  if (!command || command === "help" || command === "--help" || command === "-h") {
    console.log(USAGE);
    return 0;
  }
  if (command === "--version" || command === "-v") {
    console.log(VERSION);
    return 0;
  }

  const home = grapevineHome();
  const ctx: Context = { home, config: loadConfig(home) };
  switch (command) {
    case "init":
      commandInit(ctx, args);
      return 0;
    case "uninstall":
      commandUninstall(ctx, args);
      return 0;
    case "capture":
      await commandCapture(ctx, args);
      return 0;
    case "hook":
      // Hooks must never break the agent session, so failures are logged and swallowed.
      try {
        await commandHook(ctx, args);
      } catch (error) {
        log(`hook failed: ${String(error)}`);
      }
      return 0;
    case "search":
      await commandSearch(ctx, args);
      return 0;
    case "recent":
      await commandRecent(ctx, args);
      return 0;
    case "mcp":
      await runStdioServer({ store: openStore(ctx) });
      return 0;
    default:
      console.error(`Unknown command "${command}".\n\n${USAGE}`);
      return 1;
  }
}

if (import.meta.main) {
  main(process.argv.slice(2))
    .then((code) => {
      if (code !== 0) process.exit(code);
    })
    .catch((error: unknown) => {
      console.error(`grapevine: ${error instanceof Error ? error.message : String(error)}`);
      process.exit(1);
    });
}
