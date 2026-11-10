export type TurnRole = "user" | "assistant" | "tool";

export interface TranscriptTurn {
  role: TurnRole;
  text: string;
}

/** Agent-agnostic view of a session. Adapters convert each tool's native format into this. */
export interface Transcript {
  sessionId: string;
  cwd?: string;
  branch?: string;
  startedAt?: string;
  endedAt?: string;
  turns: TranscriptTurn[];
  /** Paths the agent edited, as reported by its tool calls. May be absolute. */
  touchedPaths: string[];
  /** Whether the agent ran shell commands, which can change files its edit tools don't report. */
  ranCommands?: boolean;
  /** The latest grapevine `share_session` or `stop_sharing` call in the session, if any. */
  shareRequest?: ShareRequest;
}

export type ShareRequest = "share" | "stop";

export const SHARE_TOOLS: Record<string, ShareRequest> = { share_session: "share", stop_sharing: "stop" };

/**
 * Recognizes a call to grapevine's share tools however the agent records MCP calls: as a
 * namespaced tool name (`mcp__grapevine__share_session`) or as a generic MCP-call tool whose input
 * names the server and tool (`{ namespace: "user-grapevine", toolName: "share_session" }`).
 */
export function shareRequestFromToolCall(name: string, input: Record<string, unknown>): ShareRequest | undefined {
  for (const [tool, request] of Object.entries(SHARE_TOOLS)) {
    if (name.includes("grapevine") && name.endsWith(tool)) return request;
    const target = input.toolName ?? input.tool_name ?? input.tool;
    const server = input.namespace ?? input.server ?? input.serverName ?? input.server_name;
    if (target === tool && typeof server === "string" && server.includes("grapevine")) return request;
  }
  return undefined;
}

const TOOL_TURN_LIMIT = 400;

export function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}…`;
}

/**
 * Renders a transcript for summarization, keeping the start (intent) and the end (outcome). Turns are
 * numbered from 1 so summaries can cite them.
 */
export function renderTranscript(transcript: Transcript, maxChars = 60_000): string {
  const full = transcript.turns
    .map((turn, index) => {
      const text = turn.role === "tool" ? truncate(turn.text.trim(), TOOL_TURN_LIMIT) : turn.text.trim();
      return `[${index + 1}] ${turn.role.toUpperCase()}: ${text}`;
    })
    .join("\n\n");
  if (full.length <= maxChars) return full;
  const head = Math.floor(maxChars * 0.3);
  const tail = maxChars - head;
  return `${full.slice(0, head)}\n\n[... ${full.length - maxChars} characters omitted ...]\n\n${full.slice(-tail)}`;
}
