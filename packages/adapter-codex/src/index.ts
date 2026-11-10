import { isAbsolute, join } from "node:path";
import {
  type ShareRequest,
  shareRequestFromToolCall,
  type Transcript,
  type TranscriptTurn,
  truncate,
} from "@chensterman/grapevine-core";

export const AGENT = "codex";

/** Tools that run shell commands, by their Codex function name. */
const SHELL_TOOLS = new Set(["shell", "shell_command", "exec_command", "local_shell", "container.exec"]);

/** `apply_patch` file headers. Patches appear as raw tool input or as escaped strings inside `exec` code. */
const PATCH_FILE = /\*\*\* (?:(?:Add|Update|Delete) File|Move to): (.+?)(?=\\n|\n|["'`]|$)/g;

/** Tool calls made from Codex's `exec` code tool, like `tools.exec_command({...})` or `tools["mcp__x__y"](...)`. */
const CODE_TOOL_CALL = /\btools\s*(?:\.\s*([\w$]+)|\[\s*["'`]([^"'`]+)["'`]\s*\])\s*\(/g;

/** Harness context Codex injects as user messages (environment, AGENTS.md, aborted turns), not the person talking. */
function isHarnessText(text: string): boolean {
  const trimmed = text.trim();
  return /^<([a-z_]+)>[\s\S]*<\/\1>$/.test(trimmed) || trimmed.startsWith("# AGENTS.md instructions");
}

/** Some clients (like Codex Desktop) wrap what the person typed in `<user_query>` next to injected context. */
function userText(text: string): string {
  const queries = [...text.matchAll(/<user_query>\n?([\s\S]*?)\n?<\/user_query>/g)].map((match) => match[1]!.trim());
  if (queries.length) return queries.join("\n\n");
  return isHarnessText(text) ? "" : text;
}

interface ContentBlock {
  type?: string;
  text?: string;
}

interface ResponseItem {
  type?: string;
  role?: string;
  name?: string;
  content?: ContentBlock[];
  arguments?: string;
  input?: string;
  output?: unknown;
  action?: { command?: string[] };
}

interface RolloutLine {
  type?: string;
  timestamp?: string;
  payload?: ResponseItem & { id?: string; cwd?: string; git?: { branch?: string } };
}

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content.map((block) => (block && typeof block === "object" && "text" in block ? String(block.text) : "")).join("\n");
  }
  if (content && typeof content === "object" && "content" in content) return textOf(content.content);
  return "";
}

function parseArguments(raw: string | undefined): Record<string, unknown> {
  try {
    const parsed = raw ? JSON.parse(raw) : {};
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

/** Parses a Codex rollout (`~/.codex/sessions/YYYY/MM/DD/rollout-<time>-<id>.jsonl`). */
export function parseCodexTranscript(jsonl: string, fallbackSessionId = "unknown"): Transcript {
  const turns: TranscriptTurn[] = [];
  const touched = new Set<string>();
  let sessionId: string | undefined;
  let cwd: string | undefined;
  let branch: string | undefined;
  let startedAt: string | undefined;
  let endedAt: string | undefined;
  let shareRequest: ShareRequest | undefined;
  let ranCommands = false;

  const notePatch = (text: string) => {
    for (const match of text.matchAll(PATCH_FILE)) {
      const path = match[1]!.trim();
      touched.add(isAbsolute(path) || !cwd ? path : join(cwd, path));
    }
  };
  const noteToolName = (name: string, input: Record<string, unknown> = {}) => {
    if (SHELL_TOOLS.has(name)) ranCommands = true;
    shareRequest = shareRequestFromToolCall(name, input) ?? shareRequest;
  };

  for (const raw of jsonl.split("\n")) {
    if (!raw.trim()) continue;
    let line: RolloutLine;
    try {
      line = JSON.parse(raw) as RolloutLine;
    } catch {
      continue;
    }
    const item = line.payload;
    if (!item) continue;
    if (line.type === "session_meta") {
      sessionId ??= item.id;
      cwd ??= item.cwd;
      if (item.git?.branch) branch = item.git.branch;
      startedAt ??= line.timestamp;
      continue;
    }
    if (line.type !== "response_item") continue;
    if (line.timestamp) {
      startedAt ??= line.timestamp;
      endedAt = line.timestamp;
    }

    if (item.type === "message" && (item.role === "user" || item.role === "assistant")) {
      const role = item.role;
      for (const block of item.content ?? []) {
        const text = role === "user" ? userText(block.text ?? "") : (block.text ?? "");
        if (text.trim()) turns.push({ role, text });
      }
    } else if (item.type === "function_call" && item.name) {
      const input = parseArguments(item.arguments);
      turns.push({ role: "tool", text: `${item.name}(${truncate(item.arguments ?? "", 200)})` });
      noteToolName(item.name, input);
      notePatch(item.arguments ?? "");
    } else if (item.type === "custom_tool_call" && item.name) {
      const code = item.input ?? "";
      turns.push({ role: "tool", text: `${item.name}(${truncate(code, 200)})` });
      noteToolName(item.name);
      for (const match of code.matchAll(CODE_TOOL_CALL)) noteToolName(match[1] ?? match[2]!);
      notePatch(code);
    } else if (item.type === "local_shell_call") {
      ranCommands = true;
      turns.push({ role: "tool", text: `shell(${truncate((item.action?.command ?? []).join(" "), 200)})` });
    } else if (item.type === "function_call_output" || item.type === "custom_tool_call_output") {
      const text = textOf(item.output);
      if (text.trim()) turns.push({ role: "tool", text: `result: ${text}` });
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

export interface CodexHookInput {
  session_id: string;
  transcript_path: string;
  cwd?: string;
  hook_event_name?: string;
}

export function parseHookInput(raw: string): CodexHookInput | null {
  try {
    const input = JSON.parse(raw) as Partial<CodexHookInput>;
    if (typeof input.session_id !== "string" || typeof input.transcript_path !== "string") return null;
    return input as CodexHookInput;
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

export type CodexHooksFile = Record<string, unknown> & { hooks?: Record<string, HookGroup[]> };

export function isGrapevineHook(command: string | undefined): boolean {
  return Boolean(command?.includes("grapevine") && command.includes("hook codex"));
}

/** Adds grapevine's hooks to a Codex `hooks.json` object. Idempotent; leaves other hooks alone. */
export function installHooks(file: CodexHooksFile, command: string): { file: CodexHooksFile; changed: boolean } {
  const next = structuredClone(file);
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
  return { file: next, changed };
}

export function uninstallHooks(file: CodexHooksFile): { file: CodexHooksFile; changed: boolean } {
  const next = structuredClone(file);
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
  return { file: next, changed };
}
