import {
  type ShareRequest,
  shareRequestFromToolCall,
  type Transcript,
  type TranscriptTurn,
  truncate,
} from "@chensterman/grapevine-core";

export const AGENT = "claude-code";

/** Claude Code tools whose input names the file being changed. */
const EDIT_TOOLS: Record<string, string> = {
  Edit: "file_path",
  MultiEdit: "file_path",
  Write: "file_path",
  NotebookEdit: "notebook_path",
};

/** Harness-generated user messages (slash commands, their output) that aren't the person talking. */
const HARNESS_PREFIXES = ["<command-", "<local-command-"];

interface ContentBlock {
  type: string;
  text?: string;
  name?: string;
  input?: Record<string, unknown>;
  content?: unknown;
}

interface TranscriptLine {
  type?: string;
  isMeta?: boolean;
  sessionId?: string;
  cwd?: string;
  gitBranch?: string;
  timestamp?: string;
  message?: { role?: string; content?: string | ContentBlock[] };
}

function describeToolCall(name: string, input: Record<string, unknown>): string {
  for (const key of ["file_path", "notebook_path", "command", "pattern", "query", "url"]) {
    const value = input[key];
    if (typeof value === "string") return `${name}(${truncate(value, 200)})`;
  }
  return `${name}(${truncate(JSON.stringify(input), 200)})`;
}

function toolResultText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((block) => (block && typeof block === "object" && "text" in block ? String(block.text) : ""))
      .join("\n");
  }
  return "";
}

/** Parses a Claude Code session file (`~/.claude/projects/<project>/<session>.jsonl`). */
export function parseClaudeTranscript(jsonl: string, fallbackSessionId = "unknown"): Transcript {
  const turns: TranscriptTurn[] = [];
  const touched = new Set<string>();
  let sessionId: string | undefined;
  let cwd: string | undefined;
  let branch: string | undefined;
  let startedAt: string | undefined;
  let endedAt: string | undefined;
  let shareRequest: ShareRequest | undefined;
  let ranCommands = false;

  for (const raw of jsonl.split("\n")) {
    if (!raw.trim()) continue;
    let line: TranscriptLine;
    try {
      line = JSON.parse(raw) as TranscriptLine;
    } catch {
      continue;
    }
    sessionId ??= line.sessionId;
    cwd ??= line.cwd;
    if (line.gitBranch && line.gitBranch !== "HEAD") branch = line.gitBranch;
    if (line.timestamp) {
      startedAt ??= line.timestamp;
      endedAt = line.timestamp;
    }
    if ((line.type !== "user" && line.type !== "assistant") || line.isMeta) continue;

    const role = line.type;
    const content = line.message?.content;
    if (typeof content === "string") {
      if (!HARNESS_PREFIXES.some((prefix) => content.trimStart().startsWith(prefix))) {
        turns.push({ role, text: content });
      }
      continue;
    }
    for (const block of content ?? []) {
      if (block.type === "text" && block.text) {
        turns.push({ role, text: block.text });
      } else if (block.type === "tool_use" && block.name) {
        const input = block.input ?? {};
        turns.push({ role: "tool", text: describeToolCall(block.name, input) });
        const pathKey = EDIT_TOOLS[block.name];
        const path = pathKey ? input[pathKey] : undefined;
        if (typeof path === "string") touched.add(path);
        if (block.name === "Bash") ranCommands = true;
        shareRequest = shareRequestFromToolCall(block.name, input) ?? shareRequest;
      } else if (block.type === "tool_result") {
        const text = toolResultText(block.content);
        if (text.trim()) turns.push({ role: "tool", text: `result: ${text}` });
      }
    }
  }

  return {
    sessionId: sessionId ?? fallbackSessionId,
    cwd,
    branch,
    startedAt,
    endedAt,
    turns,
    touchedPaths: [...touched],
    ranCommands,
    shareRequest,
  };
}

export interface ClaudeHookInput {
  session_id: string;
  transcript_path: string;
  cwd?: string;
  hook_event_name?: string;
}

/** Returns null for other agents that may also run Claude Code hooks, like Cursor and Codex, which have their own adapters. */
export function parseHookInput(raw: string): ClaudeHookInput | null {
  try {
    const input = JSON.parse(raw) as Partial<ClaudeHookInput> & { cursor_version?: string };
    if (input.cursor_version !== undefined) return null;
    if (typeof input.session_id !== "string" || typeof input.transcript_path !== "string") return null;
    if (/[/\\]\.codex[/\\]/.test(input.transcript_path)) return null;
    return input as ClaudeHookInput;
  } catch {
    return null;
  }
}

/** Stop fires after every agent turn (throttled by the CLI); SessionEnd fires once when the session closes. */
export const HOOK_EVENTS = ["Stop", "SessionEnd"] as const;

interface HookCommand {
  type: string;
  command?: string;
  timeout?: number;
}

interface HookGroup {
  matcher?: string;
  hooks?: HookCommand[];
}

export type ClaudeSettings = Record<string, unknown> & { hooks?: Record<string, HookGroup[]> };

export function isGrapevineHook(command: string | undefined): boolean {
  return Boolean(command?.includes("grapevine") && command.includes("hook claude-code"));
}

/** Adds grapevine's hooks to a Claude Code settings object. Idempotent; leaves other hooks alone. */
export function installHooks(settings: ClaudeSettings, command: string): { settings: ClaudeSettings; changed: boolean } {
  const next = structuredClone(settings);
  next.hooks ??= {};
  let changed = false;
  for (const event of HOOK_EVENTS) {
    const groups = next.hooks[event] ?? [];
    const existing = groups.flatMap((group) => group.hooks ?? []).find((hook) => isGrapevineHook(hook.command));
    if (existing?.command === command) continue;
    if (existing) existing.command = command;
    else groups.push({ hooks: [{ type: "command", command, timeout: 10 }] });
    next.hooks[event] = groups;
    changed = true;
  }
  return { settings: next, changed };
}

export function uninstallHooks(settings: ClaudeSettings): { settings: ClaudeSettings; changed: boolean } {
  const next = structuredClone(settings);
  let changed = false;
  for (const [event, groups] of Object.entries(next.hooks ?? {})) {
    const kept = groups
      .map((group) => {
        const hooks = (group.hooks ?? []).filter((hook) => !isGrapevineHook(hook.command));
        if (hooks.length !== (group.hooks ?? []).length) changed = true;
        return { ...group, hooks };
      })
      .filter((group) => group.hooks.length > 0);
    if (kept.length) next.hooks![event] = kept;
    else delete next.hooks![event];
  }
  if (next.hooks && Object.keys(next.hooks).length === 0) delete next.hooks;
  return { settings: next, changed };
}
