import { type ClaudeSettings, installHooks, uninstallHooks } from "@chensterman/grapevine-adapter-claude-code";
import * as codexHooks from "@chensterman/grapevine-adapter-codex";
import * as cursorHooks from "@chensterman/grapevine-adapter-cursor";
import { configPath, DEFAULT_CONFIG } from "@chensterman/grapevine-core";
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { shellCommand } from "./self.ts";

export const RULES_SNIPPET = `## Team context (grapevine)

Before starting a task or editing files, call the grapevine \`context_for\` tool with the files you plan to touch and a one-line description of the task. Reuse teammates' decisions, avoid their dead ends, and tell the user when your plan conflicts with work in progress.

Sessions are recorded only when the user asks. When they ask to share or record this session, call \`share_session\`; when they ask to stop, call \`stop_sharing\`.`;

export interface InstallOptions {
  home: string;
  self: string[];
  dryRun: boolean;
  claudeCode: boolean;
  cursor: boolean;
  codex: boolean;
  /** Registers the MCP server with Claude Code. Injected so tests don't shell out. */
  registerClaudeMcp?: (command: string[]) => string;
  /** Registers the MCP server with Codex, which keeps it in TOML config. Injected so tests don't shell out. */
  registerCodexMcp?: (command: string[]) => string;
  log: (line: string) => void;
}

function readJson<T>(path: string, fallback: T): T {
  return existsSync(path) ? (JSON.parse(readFileSync(path, "utf8")) as T) : fallback;
}

function writeJsonWithBackup(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  const backup = `${path}.grapevine-backup`;
  if (existsSync(path) && !existsSync(backup)) copyFileSync(path, backup);
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

export function claudeSettingsPath(): string {
  return join(homedir(), ".claude", "settings.json");
}

export function cursorMcpPath(): string {
  return join(homedir(), ".cursor", "mcp.json");
}

export function cursorHooksPath(): string {
  return join(homedir(), ".cursor", "hooks.json");
}

export function codexHooksPath(): string {
  return join(homedir(), ".codex", "hooks.json");
}

export function detectAgents(): { claudeCode: boolean; cursor: boolean; codex: boolean } {
  return {
    claudeCode: existsSync(join(homedir(), ".claude")),
    cursor: existsSync(join(homedir(), ".cursor")),
    codex: existsSync(join(homedir(), ".codex")),
  };
}

export function install(options: InstallOptions): void {
  const { log, dryRun } = options;
  const write = (path: string, value: unknown, what: string) => {
    log(`${dryRun ? "would update" : "updated"} ${path} (${what})`);
    if (!dryRun) writeJsonWithBackup(path, value);
  };

  const config = configPath(options.home);
  if (existsSync(config)) log(`kept existing ${config}`);
  else write(config, DEFAULT_CONFIG, "default config");

  if (options.claudeCode) {
    const path = claudeSettingsPath();
    const hookCommand = shellCommand([...options.self, "hook", "claude-code"]);
    const result = installHooks(readJson<ClaudeSettings>(path, {}), hookCommand);
    if (result.changed) write(path, result.settings, "Stop and SessionEnd capture hooks");
    else log(`Claude Code hooks already installed in ${path}`);

    const mcpCommand = [...options.self, "mcp"];
    if (dryRun) log(`would register MCP server with Claude Code: ${shellCommand(mcpCommand)}`);
    else if (options.registerClaudeMcp) log(options.registerClaudeMcp(mcpCommand));
  }

  if (options.cursor) {
    const path = cursorMcpPath();
    const settings = readJson<{ mcpServers?: Record<string, unknown> }>(path, {});
    const [command, ...rest] = options.self;
    const entry = { command, args: [...rest, "mcp"] };
    if (JSON.stringify(settings.mcpServers?.grapevine) === JSON.stringify(entry)) {
      log(`Cursor MCP server already registered in ${path}`);
    } else {
      write(path, { ...settings, mcpServers: { ...settings.mcpServers, grapevine: entry } }, "grapevine MCP server");
    }

    const hooksPath = cursorHooksPath();
    const hookCommand = shellCommand([...options.self, "hook", cursorHooks.AGENT]);
    const result = cursorHooks.installHooks(readJson<cursorHooks.CursorHooksFile>(hooksPath, {}), hookCommand);
    if (result.changed) write(hooksPath, result.file, "stop and sessionEnd capture hooks");
    else log(`Cursor hooks already installed in ${hooksPath}`);
  }

  if (options.codex) {
    const hooksPath = codexHooksPath();
    const hookCommand = shellCommand([...options.self, "hook", codexHooks.AGENT]);
    const result = codexHooks.installHooks(readJson<codexHooks.CodexHooksFile>(hooksPath, {}), hookCommand);
    if (result.changed) write(hooksPath, result.file, "Stop and SessionEnd capture hooks");
    else log(`Codex hooks already installed in ${hooksPath}`);

    const mcpCommand = [...options.self, "mcp"];
    if (dryRun) log(`would register MCP server with Codex: ${shellCommand(mcpCommand)}`);
    else if (options.registerCodexMcp) log(options.registerCodexMcp(mcpCommand));
  }
}

export function uninstall(options: Omit<InstallOptions, "self" | "registerClaudeMcp" | "registerCodexMcp"> & {
  unregisterClaudeMcp?: () => string;
  unregisterCodexMcp?: () => string;
}): void {
  const { log, dryRun } = options;
  const write = (path: string, value: unknown, what: string) => {
    log(`${dryRun ? "would update" : "updated"} ${path} (${what})`);
    if (!dryRun) writeJsonWithBackup(path, value);
  };

  if (options.claudeCode) {
    const path = claudeSettingsPath();
    if (existsSync(path)) {
      const result = uninstallHooks(readJson<ClaudeSettings>(path, {}));
      if (result.changed) write(path, result.settings, "removed grapevine hooks");
    }
    if (!dryRun && options.unregisterClaudeMcp) log(options.unregisterClaudeMcp());
  }

  if (options.cursor) {
    const path = cursorMcpPath();
    const settings = readJson<{ mcpServers?: Record<string, unknown> }>(path, {});
    if (settings.mcpServers?.grapevine) {
      const { grapevine: _removed, ...mcpServers } = settings.mcpServers;
      write(path, { ...settings, mcpServers }, "removed grapevine MCP server");
    }

    const hooksPath = cursorHooksPath();
    if (existsSync(hooksPath)) {
      const result = cursorHooks.uninstallHooks(readJson<cursorHooks.CursorHooksFile>(hooksPath, {}));
      if (result.changed) write(hooksPath, result.file, "removed grapevine hooks");
    }
  }

  if (options.codex) {
    const hooksPath = codexHooksPath();
    if (existsSync(hooksPath)) {
      const result = codexHooks.uninstallHooks(readJson<codexHooks.CodexHooksFile>(hooksPath, {}));
      if (result.changed) write(hooksPath, result.file, "removed grapevine hooks");
    }
    if (!dryRun && options.unregisterCodexMcp) log(options.unregisterCodexMcp());
  }
  log(`left your records and config in ${options.home}`);
}
