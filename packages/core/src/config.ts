import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  anthropicSummarizer,
  heuristicSummarizer,
  openAICompatibleSummarizer,
  type Summarizer,
} from "./summarize.ts";

export type SummarizerProvider = "auto" | "anthropic" | "openai-compatible" | "heuristic";

export interface GrapevineConfig {
  store: { type: "sqlite"; path?: string };
  summarizer: {
    provider: SummarizerProvider;
    model?: string;
    baseUrl?: string;
    /** Environment variable holding the API key. Defaults to ANTHROPIC_API_KEY or OPENAI_API_KEY. */
    apiKeyEnv?: string;
  };
  redact: { patterns: string[] };
  capture: {
    /** Minimum minutes between mid-session captures. Session end always captures. */
    minIntervalMinutes: number;
    detectPr: boolean;
    /** Regex for an issue key in the branch name, e.g. `([a-z]+-\\d+)` for Linear or Jira. */
    issuePattern?: string;
  };
}

export const DEFAULT_CONFIG: GrapevineConfig = {
  store: { type: "sqlite" },
  summarizer: { provider: "auto" },
  redact: { patterns: [] },
  capture: { minIntervalMinutes: 15, detectPr: true },
};

export const DEFAULT_MODELS = {
  anthropic: "claude-haiku-4-5",
  "openai-compatible": "gpt-5-mini",
} as const;

type Env = Record<string, string | undefined>;

export function grapevineHome(env: Env = process.env): string {
  return env.GRAPEVINE_HOME ?? join(homedir(), ".grapevine");
}

export function configPath(home = grapevineHome()): string {
  return join(home, "config.json");
}

export function storePath(config: GrapevineConfig, home = grapevineHome()): string {
  return config.store.path ?? join(home, "grapevine.db");
}

export function loadConfig(home = grapevineHome()): GrapevineConfig {
  const path = configPath(home);
  if (!existsSync(path)) return structuredClone(DEFAULT_CONFIG);
  const file = JSON.parse(readFileSync(path, "utf8")) as Partial<GrapevineConfig>;
  return {
    store: { ...DEFAULT_CONFIG.store, ...file.store },
    summarizer: { ...DEFAULT_CONFIG.summarizer, ...file.summarizer },
    redact: { ...DEFAULT_CONFIG.redact, ...file.redact },
    capture: { ...DEFAULT_CONFIG.capture, ...file.capture },
  };
}

export function createSummarizer(
  config: GrapevineConfig["summarizer"],
  env: Env = process.env,
  doFetch?: typeof fetch,
): Summarizer {
  let provider = config.provider;
  if (provider === "auto") {
    if (config.apiKeyEnv) provider = "openai-compatible";
    else if (env.ANTHROPIC_API_KEY) provider = "anthropic";
    else if (env.OPENAI_API_KEY) provider = "openai-compatible";
    else provider = "heuristic";
  }
  if (provider === "heuristic") return heuristicSummarizer();

  const keyEnv = config.apiKeyEnv ?? (provider === "anthropic" ? "ANTHROPIC_API_KEY" : "OPENAI_API_KEY");
  const apiKey = env[keyEnv];
  if (!apiKey) throw new Error(`Summarizer "${provider}" needs an API key in $${keyEnv}`);
  const options = {
    apiKey,
    model: config.model ?? DEFAULT_MODELS[provider],
    baseUrl: config.baseUrl,
    fetch: doFetch,
  };
  return provider === "anthropic" ? anthropicSummarizer(options) : openAICompatibleSummarizer(options);
}
