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
}

const TOOL_TURN_LIMIT = 400;

export function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}…`;
}

/** Renders a transcript for summarization, keeping the start (intent) and the end (outcome). */
export function renderTranscript(transcript: Transcript, maxChars = 60_000): string {
  const full = transcript.turns
    .map((turn) => {
      const text = turn.role === "tool" ? truncate(turn.text.trim(), TOOL_TURN_LIMIT) : turn.text.trim();
      return `${turn.role.toUpperCase()}: ${text}`;
    })
    .join("\n\n");
  if (full.length <= maxChars) return full;
  const head = Math.floor(maxChars * 0.3);
  const tail = maxChars - head;
  return `${full.slice(0, head)}\n\n[... ${full.length - maxChars} characters omitted ...]\n\n${full.slice(-tail)}`;
}
