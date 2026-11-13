import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import {
  anthropicSummarizer,
  heuristicSummarizer,
  openAICompatibleSummarizer,
  type Summarizer,
} from "./summarize.ts";

export type SummarizerProvider = "auto" | "anthropic" | "openai-compatible" | "heuristic";
export type CaptureMode = "opt-in" | "always";
export type KeyProvider = "anthropic" | "openai";

/** Where records are shared with a team. Without it they stay on this machine. */
export interface SyncConfig {
  /**
   * A module that exports `createSyncTarget(options)`: a file path (absolute, `~/…`, or `./…` from the
   * grapevine home), or the name of a package installed where grapevine can import it.
   */
  target: string;
  /** Passed to the target as they are. */
  options?: Record<string, unknown>;
  /** Minutes a lookup trusts the last pull before pulling again. Defaults to 5. */
  pullIntervalMinutes?: number;
}

export const DEFAULT_PULL_INTERVAL_MINUTES = 5;

export interface GrapevineConfig {
  store: { type: "sqlite"; path?: string };
  sync?: SyncConfig;
  summarizer: {
    provider: SummarizerProvider;
    model?: string;
    baseUrl?: string;
    /**
     * Environment variable holding the API key. Defaults to GRAPEVINE_ANTHROPIC_API_KEY or
     * GRAPEVINE_OPENAI_API_KEY, then the key saved with `grapevine key set`.
     */
    apiKeyEnv?: string;
  };
  redact: { patterns: string[] };
  capture: {
    /** `opt-in` captures only sessions where the agent called `share_session`; `always` captures every session. */
    mode: CaptureMode;
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
  capture: { mode: "opt-in", minIntervalMinutes: 15, detectPr: true },
};

/**
 * Grapevine reads only its own key names, never generic ones like OPENAI_API_KEY that other tools
 * export, so summaries never run on a key the user didn't choose for grapevine.
 */
export const KEY_ENV: Record<KeyProvider, string> = {
  anthropic: "GRAPEVINE_ANTHROPIC_API_KEY",
  openai: "GRAPEVINE_OPENAI_API_KEY",
};

export type Credentials = Partial<Record<KeyProvider, string>>;

export interface KeySources {
  env: Env;
  /** Keys saved with `grapevine key set`. */
  credentials?: Credentials;
}

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
    ...(file.sync?.target ? { sync: file.sync } : {}),
    summarizer: { ...DEFAULT_CONFIG.summarizer, ...file.summarizer },
    redact: { ...DEFAULT_CONFIG.redact, ...file.redact },
    capture: { ...DEFAULT_CONFIG.capture, ...file.capture },
  };
}

export function credentialsPath(home = grapevineHome()): string {
  return join(home, "credentials.json");
}

export function loadCredentials(home = grapevineHome()): Credentials {
  const path = credentialsPath(home);
  return existsSync(path) ? (JSON.parse(readFileSync(path, "utf8")) as Credentials) : {};
}

/** Saves or removes (`key` undefined) a provider key in a file only the user can read. */
export function saveCredential(home: string, provider: KeyProvider, key: string | undefined): void {
  const credentials = loadCredentials(home);
  if (key) credentials[provider] = key;
  else delete credentials[provider];
  const path = credentialsPath(home);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(credentials, null, 2)}\n`, { mode: 0o600 });
  chmodSync(path, 0o600);
}

export interface ResolvedSummarizer {
  provider: Exclude<SummarizerProvider, "auto">;
  model?: string;
  baseUrl?: string;
  /** Where the key came from, e.g. `$GRAPEVINE_OPENAI_API_KEY`. Never the key itself. */
  keySource?: string;
  apiKey?: string;
  /** Set when the configured provider can't run, e.g. its key is missing. */
  problem?: string;
}

function findKey(provider: KeyProvider, sources: KeySources): { apiKey: string; keySource: string } | undefined {
  const fromEnv = sources.env[KEY_ENV[provider]];
  if (fromEnv) return { apiKey: fromEnv, keySource: `$${KEY_ENV[provider]}` };
  const saved = sources.credentials?.[provider];
  if (saved) return { apiKey: saved, keySource: `saved ${provider} key` };
  return undefined;
}

/** Works out which summarizer would run, without calling it. */
export function resolveSummarizer(config: GrapevineConfig["summarizer"], sources: KeySources): ResolvedSummarizer {
  let provider = config.provider;
  if (provider === "auto") {
    if (config.apiKeyEnv) provider = "openai-compatible";
    else if (findKey("anthropic", sources)) provider = "anthropic";
    else if (findKey("openai", sources)) provider = "openai-compatible";
    else provider = "heuristic";
  }
  if (provider === "heuristic") return { provider };

  const base = { provider, model: config.model ?? DEFAULT_MODELS[provider], baseUrl: config.baseUrl };
  const keyProvider: KeyProvider = provider === "anthropic" ? "anthropic" : "openai";
  const key = config.apiKeyEnv
    ? sources.env[config.apiKeyEnv] && { apiKey: sources.env[config.apiKeyEnv]!, keySource: `$${config.apiKeyEnv}` }
    : findKey(keyProvider, sources);
  if (!key) {
    const where = config.apiKeyEnv
      ? `$${config.apiKeyEnv}`
      : `$${KEY_ENV[keyProvider]} or \`grapevine key set ${keyProvider}\``;
    return { ...base, problem: `Summarizer "${provider}" needs an API key in ${where}` };
  }
  return { ...base, ...key };
}

export function createSummarizer(
  config: GrapevineConfig["summarizer"],
  sources: KeySources = { env: process.env },
  doFetch?: typeof fetch,
): Summarizer {
  const resolved = resolveSummarizer(config, sources);
  if (resolved.problem) throw new Error(resolved.problem);
  if (resolved.provider === "heuristic") return heuristicSummarizer();
  const options = { apiKey: resolved.apiKey!, model: resolved.model!, baseUrl: resolved.baseUrl, fetch: doFetch };
  return resolved.provider === "anthropic" ? anthropicSummarizer(options) : openAICompatibleSummarizer(options);
}

/** Plain-language status plus setup steps, written for a coding agent to relay to the user. */
export function describeSummarizer(resolved: ResolvedSummarizer, home = grapevineHome()): string {
  const setup = `To turn on model summaries, the user picks one option:
1. Save a key for grapevine only. The user runs this in their own terminal and pastes the key at the hidden prompt (\`grapevine\` is \`bun <grapevine checkout>/packages/cli/src/main.ts\` without a global install):
   grapevine key set openai      # or: grapevine key set anthropic
   Never ask the user to paste a key into the chat.
2. Or export GRAPEVINE_OPENAI_API_KEY / GRAPEVINE_ANTHROPIC_API_KEY in their shell profile, then restart the editor so hooks see it. Grapevine ignores generic names like OPENAI_API_KEY on purpose.
3. Or use a local model with no data leaving the machine: set "summarizer" in ${configPath(home)} to {"provider": "openai-compatible", "baseUrl": "http://localhost:11434/v1", "model": "<model>", "apiKeyEnv": "<any set variable>"}.
Check the result with: grapevine status`;

  if (resolved.provider === "heuristic") {
    return `Summarizer: heuristic (no model, nothing leaves this machine). Records only get the task and changed files, no decisions or dead ends.\n\n${setup}`;
  }
  const target = `${resolved.provider} (${resolved.model}${resolved.baseUrl ? ` at ${resolved.baseUrl}` : ""})`;
  if (resolved.problem) return `Summarizer: ${target} is configured but can't run: ${resolved.problem}. Captures fall back to heuristic summaries.\n\n${setup}`;
  return `Summarizer: ${target}, key from ${resolved.keySource}. The redacted transcript is sent to this model.`;
}
