import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { installHooks, parseClaudeTranscript, parseHookInput, uninstallHooks } from "../src/index.ts";

const fixture = readFileSync(join(import.meta.dir, "fixtures", "session.jsonl"), "utf8");

describe("parseClaudeTranscript", () => {
  const transcript = parseClaudeTranscript(fixture);

  test("reads session metadata", () => {
    expect(transcript.sessionId).toBe("sess-123");
    expect(transcript.cwd).toBe("/work/app");
    expect(transcript.branch).toBe("leon/eng-42-retry-backoff");
    expect(transcript.startedAt).toBe("2026-11-01T10:00:00.000Z");
    expect(transcript.endedAt).toBe("2026-11-01T10:02:00.000Z");
  });

  test("skips slash commands and meta messages", () => {
    const userTurns = transcript.turns.filter((turn) => turn.role === "user");
    expect(userTurns).toHaveLength(1);
    expect(userTurns[0]?.text).toStartWith("Fix the webhook retry loop");
  });

  test("collects edited paths but not read-only ones", () => {
    expect(transcript.touchedPaths).toEqual(["/work/app/src/webhooks/retry.ts", "/work/app/src/webhooks/backoff.ts"]);
    expect(transcript.ranCommands).toBe(false);
  });

  test("collects files that were read and never edited", () => {
    expect(transcript.readPaths).toEqual([]);
    const reading = `${fixture}\n${JSON.stringify({
      type: "assistant",
      message: { role: "assistant", content: [{ type: "tool_use", name: "Read", input: { file_path: "/work/app/src/webhooks/queue.ts" } }] },
    })}`;
    expect(parseClaudeTranscript(reading).readPaths).toEqual(["/work/app/src/webhooks/queue.ts"]);
  });

  test("turns tool calls and results into short tool turns", () => {
    const tools = transcript.turns.filter((turn) => turn.role === "tool").map((turn) => turn.text);
    expect(tools).toContain("Read(/work/app/src/webhooks/retry.ts)");
    expect(tools).toContain("result: The file has been updated.");
  });

  test("detects grapevine share requests", () => {
    expect(transcript.shareRequest).toBe("share");
    expect(parseClaudeTranscript("").shareRequest).toBeUndefined();
  });

  test("tolerates malformed lines", () => {
    expect(parseClaudeTranscript(`not json\n${fixture}`).sessionId).toBe("sess-123");
    expect(parseClaudeTranscript("", "fallback").sessionId).toBe("fallback");
  });
});

describe("parseHookInput", () => {
  test("accepts Claude Code hook payloads", () => {
    const input = parseHookInput(
      JSON.stringify({ session_id: "s", transcript_path: "/t.jsonl", cwd: "/w", hook_event_name: "SessionEnd" }),
    );
    expect(input?.hook_event_name).toBe("SessionEnd");
  });

  test("ignores Cursor payloads, which Cursor sends to Claude Code hooks too", () => {
    expect(
      parseHookInput(JSON.stringify({ session_id: "s", transcript_path: "/t.jsonl", cursor_version: "3.28.7" })),
    ).toBeNull();
    expect(
      parseHookInput(JSON.stringify({ session_id: "s", transcript_path: "/Users/me/.codex/sessions/2026/11/01/rollout-x.jsonl" })),
    ).toBeNull();
  });

  test("rejects payloads without a transcript", () => {
    expect(parseHookInput(JSON.stringify({ session_id: "s" }))).toBeNull();
    expect(parseHookInput("garbage")).toBeNull();
  });
});

describe("installHooks", () => {
  const command = "/usr/bin/bun /opt/grapevine/main.ts hook claude-code";
  const existing = { model: "opus", hooks: { Stop: [{ hooks: [{ type: "command", command: "other-tool turn-end" }] }] } };

  test("adds Stop and SessionEnd hooks next to existing ones", () => {
    const { settings, changed } = installHooks(existing, command);
    expect(changed).toBe(true);
    expect(settings.model).toBe("opus");
    expect(settings.hooks?.Stop).toHaveLength(2);
    expect(settings.hooks?.SessionEnd?.[0]?.hooks?.[0]?.command).toBe(command);
    expect(existing.hooks.Stop).toHaveLength(1);
  });

  test("is idempotent and updates a moved install in place", () => {
    const once = installHooks(existing, command).settings;
    expect(installHooks(once, command).changed).toBe(false);
    const moved = installHooks(once, "grapevine hook claude-code").settings;
    expect(moved.hooks?.Stop).toHaveLength(2);
    expect(moved.hooks?.Stop?.[1]?.hooks?.[0]?.command).toBe("grapevine hook claude-code");
  });

  test("uninstall removes only grapevine hooks", () => {
    const { settings, changed } = uninstallHooks(installHooks(existing, command).settings);
    expect(changed).toBe(true);
    expect(settings).toEqual(existing);
  });
});
