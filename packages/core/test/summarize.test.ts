import { describe, expect, test } from "bun:test";
import { createSummarizer } from "../src/config.ts";
import { parseSummary, type SummaryInput } from "../src/summarize.ts";

const input: SummaryInput = {
  transcript: { sessionId: "s", turns: [{ role: "user", text: "Fix retries\nmore detail" }], touchedPaths: [] },
  rendered: "USER: Fix retries",
  paths: ["src/retry.ts"],
  branch: "fix/retries",
};

const modelJson = JSON.stringify({
  task: "Add backoff to webhook retries",
  decisions: ["Used jitter because synchronized retries caused thundering herds", "  "],
  deadEnds: ["Fixed 1s delay still overwhelmed the endpoint"],
  openQuestions: [],
  status: "done",
});

describe("parseSummary", () => {
  test("extracts JSON wrapped in prose or code fences", () => {
    const summary = parseSummary(`Here you go:\n\`\`\`json\n${modelJson}\n\`\`\``);
    expect(summary.task).toBe("Add backoff to webhook retries");
    expect(summary.decisions).toHaveLength(1);
    expect(summary.status).toBe("done");
  });

  test("fills defaults and coerces unknown statuses", () => {
    expect(parseSummary('{"task":"x","status":"shipped"}')).toEqual({
      task: "x",
      decisions: [],
      deadEnds: [],
      openQuestions: [],
      status: "in_progress",
    });
  });

  test("throws when there is no JSON", () => {
    expect(() => parseSummary("I can't do that")).toThrow();
  });
});

describe("createSummarizer", () => {
  test("auto picks heuristic without API keys", async () => {
    const summarizer = createSummarizer({ provider: "auto" }, {});
    expect(summarizer.name).toBe("heuristic");
    expect((await summarizer.summarize(input)).task).toBe("Fix retries");
  });

  test("calls the Anthropic messages API", async () => {
    let request: { url: string; headers: Record<string, string>; body: Record<string, unknown> } | undefined;
    const fakeFetch = (async (url: string, init: RequestInit) => {
      request = { url, headers: init.headers as Record<string, string>, body: JSON.parse(String(init.body)) };
      return Response.json({ content: [{ type: "text", text: modelJson }] });
    }) as unknown as typeof fetch;
    const summarizer = createSummarizer({ provider: "auto" }, { ANTHROPIC_API_KEY: "k" }, fakeFetch);
    const summary = await summarizer.summarize(input);
    expect(summary.deadEnds).toEqual(["Fixed 1s delay still overwhelmed the endpoint"]);
    expect(request?.url).toBe("https://api.anthropic.com/v1/messages");
    expect(request?.headers["x-api-key"]).toBe("k");
    expect(request?.body.model).toBe("claude-haiku-4-5");
  });

  test("calls OpenAI-compatible endpoints with a custom base URL and key env", async () => {
    let url: string | undefined;
    const fakeFetch = (async (target: string) => {
      url = target;
      return Response.json({ choices: [{ message: { content: modelJson } }] });
    }) as unknown as typeof fetch;
    const summarizer = createSummarizer(
      { provider: "auto", apiKeyEnv: "OLLAMA_KEY", baseUrl: "http://localhost:11434/v1", model: "qwen3" },
      { OLLAMA_KEY: "local" },
      fakeFetch,
    );
    expect(summarizer.name).toBe("openai-compatible:qwen3");
    expect((await summarizer.summarize(input)).status).toBe("done");
    expect(url).toBe("http://localhost:11434/v1/chat/completions");
  });

  test("surfaces API errors", async () => {
    const fakeFetch = (async () => new Response("rate limited", { status: 429 })) as unknown as typeof fetch;
    const summarizer = createSummarizer({ provider: "anthropic" }, { ANTHROPIC_API_KEY: "k" }, fakeFetch);
    expect(summarizer.summarize(input)).rejects.toThrow("429");
  });

  test("explicit providers require a key", () => {
    expect(() => createSummarizer({ provider: "anthropic" }, {})).toThrow("ANTHROPIC_API_KEY");
  });
});
