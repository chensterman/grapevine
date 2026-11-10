import { type Transcript, type TranscriptTurn, truncate } from "@chensterman/grapevine-core";

export const AGENT = "cursor";

/** Cursor tools whose input names the file being changed. */
const EDIT_TOOLS: Record<string, string> = {
  Write: "path",
  StrReplace: "path",
  Delete: "path",
  EditNotebook: "target_notebook",
};

const DESCRIBE_KEYS = ["path", "target_notebook", "command", "pattern", "glob_pattern", "query", "search_term", "url"];

interface ContentBlock {
  type: string;
  text?: string;
  name?: string;
  input?: Record<string, unknown>;
}

interface TranscriptLine {
  role?: string;
  message?: { content?: string | ContentBlock[] };
}

function describeToolCall(name: string, input: Record<string, unknown>): string {
  for (const key of DESCRIBE_KEYS) {
    const value = input[key];
    if (typeof value === "string") return `${name}(${truncate(value, 200)})`;
  }
  return `${name}(${truncate(JSON.stringify(input), 200)})`;
}

/** Parses Cursor's `<timestamp>Sunday, Nov 8, 2026, 6:59 PM (UTC-8)</timestamp>` into ISO 8601. */
export function parseCursorTimestamp(text: string): string | undefined {
  const match = text.match(/<timestamp>\w+, (.+?) \(UTC(?:([+-])(\d{1,2})(?::(\d{2}))?)?\)<\/timestamp>/);
  if (!match) return undefined;
  const [, local, sign, hours, minutes] = match;
  const offset = sign ? `${sign}${hours!.padStart(2, "0")}${minutes ?? "00"}` : "+0000";
  const date = new Date(`${local} GMT${offset}`);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

/**
 * Returns what the person typed. Cursor wraps it in `<user_query>` alongside harness context
 * (timestamps, open files, reminders) that isn't the person talking.
 */
export function userQuery(text: string): string {
  const queries = [...text.matchAll(/<user_query>\n?([\s\S]*?)\n?<\/user_query>/g)].map((match) => match[1]!.trim());
  if (queries.length) return queries.join("\n\n");
  return text.replace(/<([a-z_]+)>[\s\S]*?<\/\1>/g, "").trim();
}

/** Parses a Cursor agent transcript (`~/.cursor/projects/<project>/agent-transcripts/<id>/<id>.jsonl`). */
export function parseCursorTranscript(jsonl: string, sessionId = "unknown"): Transcript {
  const turns: TranscriptTurn[] = [];
  const touched = new Set<string>();
  let startedAt: string | undefined;
  let endedAt: string | undefined;

  for (const raw of jsonl.split("\n")) {
    if (!raw.trim()) continue;
    let line: TranscriptLine;
    try {
      line = JSON.parse(raw) as TranscriptLine;
    } catch {
      continue;
    }
    if (line.role !== "user" && line.role !== "assistant") continue;
    const role = line.role;
    const content = line.message?.content;
    const blocks: ContentBlock[] = typeof content === "string" ? [{ type: "text", text: content }] : (content ?? []);

    for (const block of blocks) {
      if (block.type === "text" && block.text) {
        if (role === "user") {
          const at = parseCursorTimestamp(block.text);
          if (at) {
            startedAt ??= at;
            endedAt = at;
          }
          const text = userQuery(block.text);
          if (text) turns.push({ role, text });
        } else {
          turns.push({ role, text: block.text });
        }
      } else if (block.type === "tool_use" && block.name) {
        const input = block.input ?? {};
        turns.push({ role: "tool", text: describeToolCall(block.name, input) });
        const pathKey = EDIT_TOOLS[block.name];
        const path = pathKey ? input[pathKey] : undefined;
        if (typeof path === "string") touched.add(path);
      }
    }
  }

  return { sessionId, startedAt, endedAt, turns, touchedPaths: [...touched] };
}

export interface CursorHookInput {
  session_id: string;
  transcript_path: string;
  cwd?: string;
  hook_event_name?: string;
}

/** Cursor sends `cwd` only on some events, so this falls back to the first workspace root. */
export function parseHookInput(raw: string): CursorHookInput | null {
  try {
    const input = JSON.parse(raw) as Partial<CursorHookInput> & { conversation_id?: string; workspace_roots?: string[] };
    const sessionId = input.session_id ?? input.conversation_id;
    if (typeof sessionId !== "string" || typeof input.transcript_path !== "string") return null;
    return {
      session_id: sessionId,
      transcript_path: input.transcript_path,
      cwd: input.cwd || input.workspace_roots?.[0],
      hook_event_name: input.hook_event_name,
    };
  } catch {
    return null;
  }
}

/** `stop` fires after every agent turn (throttled by the CLI); `sessionEnd` fires when the chat closes. */
export const HOOK_EVENTS = ["stop", "sessionEnd"] as const;

interface HookEntry {
  command?: string;
  [key: string]: unknown;
}

export type CursorHooksFile = Record<string, unknown> & { version?: number; hooks?: Record<string, HookEntry[]> };

export function isGrapevineHook(command: string | undefined): boolean {
  return Boolean(command?.includes("grapevine") && command.includes("hook cursor"));
}

/** Adds grapevine's hooks to a Cursor `hooks.json` object. Idempotent; leaves other hooks alone. */
export function installHooks(file: CursorHooksFile, command: string): { file: CursorHooksFile; changed: boolean } {
  const next = structuredClone(file);
  next.version ??= 1;
  next.hooks ??= {};
  let changed = false;
  for (const event of HOOK_EVENTS) {
    const entries = next.hooks[event] ?? [];
    const existing = entries.find((entry) => isGrapevineHook(entry.command));
    if (existing?.command === command) continue;
    if (existing) existing.command = command;
    else entries.push({ command, timeout: 10 });
    next.hooks[event] = entries;
    changed = true;
  }
  return { file: next, changed };
}

export function uninstallHooks(file: CursorHooksFile): { file: CursorHooksFile; changed: boolean } {
  const next = structuredClone(file);
  let changed = false;
  for (const [event, entries] of Object.entries(next.hooks ?? {})) {
    const kept = entries.filter((entry) => !isGrapevineHook(entry.command));
    if (kept.length !== entries.length) changed = true;
    if (kept.length) next.hooks![event] = kept;
    else delete next.hooks![event];
  }
  return { file: next, changed };
}
