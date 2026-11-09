import { z } from "zod";
import { type Transcript, truncate } from "./transcript.ts";
import { RECORD_STATUSES, type RecordStatus } from "./types.ts";

const MAX_ITEMS = 8;
const MAX_ITEM_CHARS = 400;

export interface Summary {
  task: string;
  decisions: string[];
  deadEnds: string[];
  openQuestions: string[];
  status: RecordStatus;
}

export interface SummaryInput {
  /** Already redacted. */
  transcript: Transcript;
  rendered: string;
  paths: string[];
  branch?: string;
}

export interface Summarizer {
  name: string;
  summarize(input: SummaryInput): Promise<Summary>;
}

export const SYSTEM_PROMPT = `You write handoff notes that teammates' coding agents read before working in the same code.

Given a coding-agent session transcript, extract only what would change another engineer's decisions. Respond with a single JSON object and nothing else:
{"task": string, "decisions": string[], "deadEnds": string[], "openQuestions": string[], "status": "in_progress" | "done" | "paused" | "abandoned"}

- task: one sentence describing what the session set out to do.
- decisions: choices that were made and why. Always include the why.
- deadEnds: approaches that were tried and failed, and why they failed.
- openQuestions: unresolved problems, known gaps, and follow-ups.
- status: done if the goal was achieved, abandoned if dropped, paused if explicitly left for later, otherwise in_progress.

Only include what the transcript states or clearly shows. Never speculate, suggest improvements, or invent follow-ups: an open question must have been raised or left unresolved in the session. Prefer fewer, sharper items, at most 4 per list. Each item is one sentence under 30 words and names concrete files, functions, commands, or services. Leave out routine steps, chit-chat, and anything that looks like a credential or personal data. Empty arrays are fine.`;

const SummarySchema = z.object({
  task: z.string().default(""),
  decisions: z.array(z.string()).default([]),
  deadEnds: z.array(z.string()).default([]),
  openQuestions: z.array(z.string()).default([]),
  status: z.enum(RECORD_STATUSES as [RecordStatus, ...RecordStatus[]]).catch("in_progress"),
});

function cleanItems(items: string[]): string[] {
  return items
    .map((item) => item.trim())
    .filter(Boolean)
    .slice(0, MAX_ITEMS)
    .map((item) => truncate(item, MAX_ITEM_CHARS));
}

/** Parses a model response, tolerating prose or code fences around the JSON object. */
export function parseSummary(raw: string): Summary {
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start < 0 || end <= start) throw new Error("Summarizer response did not contain a JSON object");
  const parsed = SummarySchema.parse(JSON.parse(raw.slice(start, end + 1)));
  return {
    task: truncate(parsed.task.trim(), 300),
    decisions: cleanItems(parsed.decisions),
    deadEnds: cleanItems(parsed.deadEnds),
    openQuestions: cleanItems(parsed.openQuestions),
    status: parsed.status,
  };
}

export function buildUserPrompt(input: SummaryInput): string {
  const files = input.paths.slice(0, 50).join(", ") || "none detected";
  return `Branch: ${input.branch ?? "unknown"}\nFiles changed: ${files}\n\nTranscript:\n${input.rendered}`;
}

/** No model: uses the first user message as the task. Useful offline and in tests. */
export function heuristicSummarizer(): Summarizer {
  return {
    name: "heuristic",
    async summarize({ transcript }) {
      const first = transcript.turns.find((turn) => turn.role === "user" && turn.text.trim());
      const firstLine = first?.text.trim().split("\n")[0] ?? "";
      return {
        task: truncate(firstLine, 200) || "Untitled session",
        decisions: [],
        deadEnds: [],
        openQuestions: [],
        status: "in_progress",
      };
    },
  };
}

export interface ModelSummarizerOptions {
  apiKey: string;
  model: string;
  baseUrl?: string;
  fetch?: typeof fetch;
}

async function postJson(
  doFetch: typeof fetch,
  url: string,
  headers: Record<string, string>,
  body: unknown,
): Promise<unknown> {
  const response = await doFetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    throw new Error(`${url} returned ${response.status}: ${truncate(await response.text(), 300)}`);
  }
  return response.json();
}

export function anthropicSummarizer(options: ModelSummarizerOptions): Summarizer {
  const baseUrl = options.baseUrl ?? "https://api.anthropic.com";
  return {
    name: `anthropic:${options.model}`,
    async summarize(input) {
      const data = (await postJson(
        options.fetch ?? fetch,
        `${baseUrl}/v1/messages`,
        { "x-api-key": options.apiKey, "anthropic-version": "2023-06-01" },
        {
          model: options.model,
          max_tokens: 1500,
          system: SYSTEM_PROMPT,
          messages: [{ role: "user", content: buildUserPrompt(input) }],
        },
      )) as { content?: { type: string; text?: string }[] };
      const text = (data.content ?? [])
        .filter((block) => block.type === "text")
        .map((block) => block.text ?? "")
        .join("");
      return parseSummary(text);
    },
  };
}

/** Works with OpenAI and any server exposing `/chat/completions` (OpenRouter, Ollama, vLLM, ...). */
export function openAICompatibleSummarizer(options: ModelSummarizerOptions): Summarizer {
  const baseUrl = options.baseUrl ?? "https://api.openai.com/v1";
  return {
    name: `openai-compatible:${options.model}`,
    async summarize(input) {
      const data = (await postJson(
        options.fetch ?? fetch,
        `${baseUrl}/chat/completions`,
        { authorization: `Bearer ${options.apiKey}` },
        {
          model: options.model,
          response_format: { type: "json_object" },
          messages: [
            { role: "system", content: SYSTEM_PROMPT },
            { role: "user", content: buildUserPrompt(input) },
          ],
        },
      )) as { choices?: { message?: { content?: string } }[] };
      return parseSummary(data.choices?.[0]?.message?.content ?? "");
    },
  };
}
