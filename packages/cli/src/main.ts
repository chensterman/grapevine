#!/usr/bin/env bun
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import * as claudeCode from "@chensterman/grapevine-adapter-claude-code";
import * as codex from "@chensterman/grapevine-adapter-codex";
import * as cursor from "@chensterman/grapevine-adapter-cursor";
import {
  capture,
  createSummarizer,
  describeSummarizer,
  formatRecord,
  formatResults,
  type GrapevineConfig,
  grapevineHome,
  heuristicSummarizer,
  KEY_ENV,
  type KeyProvider,
  type KeySources,
  loadConfig,
  loadCredentials,
  readRepoIdentity,
  resolveSummarizer,
  saveCredential,
  type Store,
  type Summarizer,
  type SummarizerProvider,
  storePath,
  toRepoRelative,
  type Transcript,
  VERSION,
} from "@chensterman/grapevine-core";
import { runStdioServer } from "@chensterman/grapevine-mcp";
import { openSqliteStore } from "@chensterman/grapevine-store-sqlite";
import { detectAgents, install, RULES_SNIPPET, uninstall } from "./install.ts";
import { selfCommand, shellCommand } from "./self.ts";

const USAGE = `grapevine ${VERSION} — passive, path-indexed team memory for coding agents

Usage:
  grapevine init [--dry-run] [--claude-code] [--cursor] [--codex]
      Install capture hooks and register the MCP server. Detects installed agents by default.
  grapevine uninstall [--dry-run]
      Remove hooks and MCP registration. Keeps your records.
  grapevine search [text...] [-p <path>]... [--repo <id> | --all-repos] [-n <limit>] [--json]
      Find records by path and/or text, scoped to the current repo by default.
  grapevine recent [--repo <id> | --all-repos] [-n <limit>] [--json]
      List the most recent sessions.
  grapevine capture --transcript <file> [--agent claude-code|cursor|codex] [--cwd <dir>] [--summarizer <provider>] [--json]
      Summarize and store one session now, whether or not it was shared in-session.
  grapevine status
      Show the capture mode and which summarizer captures will use.
  grapevine key set|remove anthropic|openai
      Save a model API key for grapevine only (read from a hidden prompt or stdin), or remove it.
  grapevine hook claude-code|cursor|codex
      Agent hook entry point. Reads hook JSON on stdin and captures shared sessions in the background.
  grapevine mcp
      Run the MCP server on stdio.

Environment:
  GRAPEVINE_HOME                Config, database, logs, and saved keys (default ~/.grapevine)
  GRAPEVINE_ANTHROPIC_API_KEY   Enables the Anthropic summarizer when provider is "auto"
  GRAPEVINE_OPENAI_API_KEY      Enables the OpenAI-compatible summarizer when provider is "auto"
`;

const PROVIDERS: SummarizerProvider[] = ["auto", "anthropic", "openai-compatible", "heuristic"];

interface HookInput {
  session_id: string;
  transcript_path: string;
  cwd?: string;
  hook_event_name?: string;
}

interface Agent {
  parseTranscript: (jsonl: string, sessionId: string) => Transcript;
  parseHookInput: (raw: string) => HookInput | null;
  sessionEndEvent: string;
}

const AGENTS: Record<string, Agent> = {
  [claudeCode.AGENT]: {
    parseTranscript: claudeCode.parseClaudeTranscript,
    parseHookInput: claudeCode.parseHookInput,
    sessionEndEvent: "SessionEnd",
  },
  [cursor.AGENT]: {
    parseTranscript: cursor.parseCursorTranscript,
    parseHookInput: cursor.parseHookInput,
    sessionEndEvent: "sessionEnd",
  },
  [codex.AGENT]: {
    parseTranscript: codex.parseCodexTranscript,
    parseHookInput: codex.parseHookInput,
    sessionEndEvent: "SessionEnd",
  },
};

function agentFor(id: string | undefined): Agent {
  const agent = id ? AGENTS[id] : undefined;
  if (!agent) throw new Error(`Unsupported agent "${id ?? ""}". Supported: ${Object.keys(AGENTS).join(", ")}`);
  return agent;
}

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

function logHookFailure(home: string, error: unknown): void {
  const line = `[${new Date().toISOString()}] hook failed: ${String(error)}\n`;
  try {
    const logDir = join(home, "logs");
    mkdirSync(logDir, { recursive: true });
    appendFileSync(join(logDir, "hook.log"), line);
  } catch {
    process.stderr.write(line);
  }
}

function keySources(ctx: Context): KeySources {
  return { env: process.env, credentials: loadCredentials(ctx.home) };
}

function summarizerStatus(ctx: Context): string {
  return describeSummarizer(resolveSummarizer(ctx.config.summarizer, keySources(ctx)), ctx.home);
}

function summarizerFor(ctx: Context, override?: string): Summarizer {
  if (override && !PROVIDERS.includes(override as SummarizerProvider)) {
    throw new Error(`Unknown summarizer "${override}". Use one of: ${PROVIDERS.join(", ")}`);
  }
  const config = override ? { ...ctx.config.summarizer, provider: override as SummarizerProvider } : ctx.config.summarizer;
  try {
    return createSummarizer(config, keySources(ctx));
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
      agent: { type: "string", default: claudeCode.AGENT },
      cwd: { type: "string" },
      summarizer: { type: "string" },
      json: { type: "boolean", default: false },
    },
  });
  if (!values.transcript) throw new Error("capture needs --transcript <file>");
  const agent = agentFor(values.agent);

  const transcriptPath = resolve(values.transcript);
  const transcript = agent.parseTranscript(readFileSync(transcriptPath, "utf8"), basename(transcriptPath, ".jsonl"));
  const summarizer = summarizerFor(ctx, values.summarizer);
  const store = openStore(ctx);
  try {
    const record = await capture({
      transcript,
      agent: values.agent,
      store,
      summarizer,
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
    else log(`captured ${record.id} in ${record.repo} with ${summarizer.name}: ${record.task}`);
  } finally {
    store.close();
  }
}

async function commandHook(ctx: Context, args: string[]): Promise<void> {
  const agentId = args[0];
  const agent = agentFor(agentId);
  const input = agent.parseHookInput(await Bun.stdin.text());
  if (!input) return;

  const stateDir = join(ctx.home, "state");
  const logDir = join(ctx.home, "logs");
  mkdirSync(stateDir, { recursive: true });
  mkdirSync(logDir, { recursive: true });
  const key = createHash("sha256").update(`${agentId}:${input.session_id}`).digest("hex").slice(0, 24);
  const stateFile = join(stateDir, `${key}.json`);
  const state = existsSync(stateFile)
    ? (JSON.parse(readFileSync(stateFile, "utf8")) as { lastCaptureAt?: number; shared?: boolean })
    : {};

  // The agent opts a session in or out by calling share_session / stop_sharing; the latest call wins.
  const { shareRequest, sessionId } = agent.parseTranscript(readFileSync(input.transcript_path, "utf8"), input.session_id);
  if (shareRequest === "stop") {
    if (state.shared !== false) {
      const store = openStore(ctx);
      try {
        await store.deleteBySession(`${agentId}:${sessionId}`);
      } finally {
        store.close();
      }
      writeFileSync(stateFile, JSON.stringify({ shared: false }));
    }
    return;
  }
  if (ctx.config.capture.mode !== "always" && shareRequest !== "share") return;

  const isSessionEnd = input.hook_event_name === agent.sessionEndEvent;
  const lastCaptureAt = state.lastCaptureAt ?? 0;
  if (!isSessionEnd && Date.now() - lastCaptureAt < ctx.config.capture.minIntervalMinutes * 60_000) return;
  writeFileSync(stateFile, JSON.stringify({ lastCaptureAt: Date.now(), shared: true }));

  const [command, ...prefix] = selfCommand();
  const out = openSync(join(logDir, "capture.log"), "a");
  const child = spawn(
    command!,
    [...prefix, "capture", "--agent", agentId!, "--transcript", input.transcript_path, "--cwd", input.cwd ?? process.cwd()],
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

function commandStatus(ctx: Context): void {
  const { mode } = ctx.config.capture;
  console.log(
    mode === "always"
      ? "Capture: always (every session is summarized)."
      : "Capture: opt-in (only sessions where the user asks the agent to share them).",
  );
  console.log(summarizerStatus(ctx));
}

/** Reads a secret from a hidden terminal prompt, or from stdin when piped. */
async function readSecret(prompt: string): Promise<string> {
  if (!process.stdin.isTTY) return (await Bun.stdin.text()).trim();
  process.stderr.write(prompt);
  spawnSync("stty", ["-echo"], { stdio: "inherit" });
  try {
    for await (const line of console) return line.trim();
    return "";
  } finally {
    spawnSync("stty", ["echo"], { stdio: "inherit" });
    process.stderr.write("\n");
  }
}

async function commandKey(ctx: Context, args: string[]): Promise<void> {
  const [action, provider] = args;
  if ((action !== "set" && action !== "remove") || (provider !== "anthropic" && provider !== "openai")) {
    throw new Error("Usage: grapevine key set|remove anthropic|openai");
  }
  if (action === "remove") {
    saveCredential(ctx.home, provider, undefined);
    console.log(`Removed the saved ${provider} key.`);
    return;
  }
  const key = await readSecret(`Paste your ${provider} API key for grapevine (input is hidden): `);
  if (!key) throw new Error("No key entered.");
  saveCredential(ctx.home, provider as KeyProvider, key);
  console.log(`Saved the ${provider} key for grapevine ($${KEY_ENV[provider]} takes precedence if set).`);
  console.log(summarizerStatus(ctx));
}

function agentFlags(args: string[]) {
  const { values } = parseArgs({
    args,
    options: {
      "dry-run": { type: "boolean", default: false },
      "claude-code": { type: "boolean" },
      cursor: { type: "boolean" },
      codex: { type: "boolean" },
    },
  });
  const explicit = values["claude-code"] !== undefined || values.cursor !== undefined || values.codex !== undefined;
  const detected = detectAgents();
  return {
    dryRun: values["dry-run"],
    claudeCode: explicit ? Boolean(values["claude-code"]) : detected.claudeCode,
    cursor: explicit ? Boolean(values.cursor) : detected.cursor,
    codex: explicit ? Boolean(values.codex) : detected.codex,
  };
}

function runAgentCli(cli: string, args: string[]): string {
  if (!Bun.which(cli)) return `${cli} CLI not found; register manually with: ${cli} ${shellCommand(args)}`;
  const result = spawnSync(cli, args, { encoding: "utf8" });
  return (result.stdout || result.stderr || "").trim() || `ran: ${cli} ${shellCommand(args)}`;
}

function commandInit(ctx: Context, args: string[]): void {
  const flags = agentFlags(args);
  if (!flags.claudeCode && !flags.cursor && !flags.codex) {
    console.log("No supported agents detected. Pass --claude-code, --cursor, or --codex.");
  }
  install({
    home: ctx.home,
    self: selfCommand(),
    ...flags,
    registerClaudeMcp: (command) => {
      spawnSync("claude", ["mcp", "remove", "--scope", "user", "grapevine"], { encoding: "utf8" });
      return runAgentCli("claude", ["mcp", "add", "--scope", "user", "grapevine", "--", ...command]);
    },
    registerCodexMcp: (command) => {
      spawnSync("codex", ["mcp", "remove", "grapevine"], { encoding: "utf8" });
      return runAgentCli("codex", ["mcp", "add", "grapevine", "--", ...command]);
    },
    log: (line) => console.log(line),
  });
  console.log(`\nAdd this to your AGENTS.md / CLAUDE.md / Cursor rules so agents use it:\n\n${RULES_SNIPPET}\n`);
}

function commandUninstall(ctx: Context, args: string[]): void {
  uninstall({
    home: ctx.home,
    ...agentFlags(args),
    unregisterClaudeMcp: () => runAgentCli("claude", ["mcp", "remove", "--scope", "user", "grapevine"]),
    unregisterCodexMcp: () => runAgentCli("codex", ["mcp", "remove", "grapevine"]),
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
  if (command === "hook") {
    // Hooks must never break the agent session, so failures are logged and swallowed.
    try {
      await commandHook({ home, config: loadConfig(home) }, args);
    } catch (error) {
      logHookFailure(home, error);
    }
    return 0;
  }
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
    case "search":
      await commandSearch(ctx, args);
      return 0;
    case "recent":
      await commandRecent(ctx, args);
      return 0;
    case "status":
      commandStatus(ctx);
      return 0;
    case "key":
      await commandKey(ctx, args);
      return 0;
    case "mcp":
      await runStdioServer({
        store: openStore(ctx),
        summarizerStatus: () => summarizerStatus({ home, config: loadConfig(home) }),
      });
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
