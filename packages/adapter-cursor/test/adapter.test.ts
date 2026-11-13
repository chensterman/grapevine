import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  installHooks,
  parseCursorTimestamp,
  parseCursorTranscript,
  parseHookInput,
  uninstallHooks,
  userQuery,
} from "../src/index.ts";

const fixture = readFileSync(join(import.meta.dir, "fixtures", "session.jsonl"), "utf8");

describe("parseCursorTranscript", () => {
  const transcript = parseCursorTranscript(fixture, "conv-1");

  test("reads session id and times from timestamps", () => {
    expect(transcript.sessionId).toBe("conv-1");
    expect(transcript.startedAt).toBe("2026-11-01T18:00:00.000Z");
    expect(transcript.endedAt).toBe("2026-11-01T18:05:00.000Z");
  });

  test("keeps only what the person typed from user messages", () => {
    const userTurns = transcript.turns.filter((turn) => turn.role === "user").map((turn) => turn.text);
    expect(userTurns).toEqual([
      "Fix the webhook retry loop in src/webhooks/retry.ts so it backs off exponentially.",
      "Also cap it at five attempts.",
    ]);
  });

  test("collects edited paths but not read-only ones", () => {
    expect(transcript.touchedPaths).toEqual(["/work/app/src/webhooks/retry.ts", "/work/app/src/webhooks/backoff.ts"]);
    expect(transcript.ranCommands).toBe(true);
  });

  test("collects files that were read and never edited", () => {
    expect(transcript.readPaths).toEqual([]);
    const reading = `${fixture}\n${JSON.stringify({
      role: "assistant",
      message: { content: [{ type: "tool_use", name: "Read", input: { path: "/work/app/src/webhooks/queue.ts" } }] },
    })}`;
    expect(parseCursorTranscript(reading).readPaths).toEqual(["/work/app/src/webhooks/queue.ts"]);
  });

  test("turns tool calls into short tool turns", () => {
    const tools = transcript.turns.filter((turn) => turn.role === "tool").map((turn) => turn.text);
    expect(tools).toEqual([
      "CallDynamicTool(share_session)",
      "Read(/work/app/src/webhooks/retry.ts)",
      "StrReplace(/work/app/src/webhooks/retry.ts)",
      "Write(/work/app/src/webhooks/backoff.ts)",
      "Shell(bun test src/webhooks)",
    ]);
  });

  test("detects grapevine share requests made through Cursor's MCP tool", () => {
    expect(transcript.shareRequest).toBe("share");
    const stopped = `${fixture}\n${JSON.stringify({
      role: "assistant",
      message: { content: [{ type: "tool_use", name: "CallDynamicTool", input: { namespace: "user-grapevine", toolName: "stop_sharing" } }] },
    })}`;
    expect(parseCursorTranscript(stopped).shareRequest).toBe("stop");
  });

  test("tolerates empty input", () => {
    expect(parseCursorTranscript("", "fallback")).toMatchObject({ sessionId: "fallback", turns: [] });
    expect(parseCursorTranscript("", "fallback").shareRequest).toBeUndefined();
  });
});

describe("helpers", () => {
  test("parses timestamps with and without offsets", () => {
    expect(parseCursorTimestamp("<timestamp>Monday, Jan 5, 2027, 10:03 AM (UTC+5:30)</timestamp>")).toBe(
      "2027-01-05T04:33:00.000Z",
    );
    expect(parseCursorTimestamp("<timestamp>Tuesday, Mar 3, 2026, 1:00 PM (UTC)</timestamp>")).toBe(
      "2026-03-03T13:00:00.000Z",
    );
    expect(parseCursorTimestamp("no timestamp")).toBeUndefined();
  });

  test("strips harness tags when there is no user_query", () => {
    expect(userQuery("<timestamp>x</timestamp>\nplain request")).toBe("plain request");
  });
});

describe("parseHookInput", () => {
  test("falls back to the first workspace root when cwd is missing", () => {
    const input = parseHookInput(
      JSON.stringify({
        conversation_id: "c",
        session_id: "c",
        transcript_path: "/t.jsonl",
        hook_event_name: "stop",
        workspace_roots: ["/work/app"],
      }),
    );
    expect(input).toEqual({ session_id: "c", transcript_path: "/t.jsonl", cwd: "/work/app", hook_event_name: "stop" });
  });

  test("rejects payloads without a transcript", () => {
    expect(parseHookInput(JSON.stringify({ session_id: "s" }))).toBeNull();
    expect(parseHookInput("garbage")).toBeNull();
  });
});

describe("installHooks", () => {
  const command = "/usr/bin/bun /opt/grapevine/main.ts hook cursor";
  const existing = { version: 1, hooks: { stop: [{ command: "./hooks/other.sh" }] } };

  test("adds stop and sessionEnd hooks next to existing ones", () => {
    const { file, changed } = installHooks(existing, command);
    expect(changed).toBe(true);
    expect(file.hooks?.stop).toEqual([{ command: "./hooks/other.sh" }, { command, timeout: 10 }]);
    expect(file.hooks?.sessionEnd).toEqual([{ command, timeout: 10 }]);
    expect(existing.hooks.stop).toHaveLength(1);
  });

  test("creates a versioned file from scratch and is idempotent", () => {
    const once = installHooks({}, command).file;
    expect(once.version).toBe(1);
    expect(installHooks(once, command).changed).toBe(false);
  });

  test("uninstall removes only grapevine hooks", () => {
    const { file, changed } = uninstallHooks(installHooks(existing, command).file);
    expect(changed).toBe(true);
    expect(file).toEqual(existing);
  });
});
