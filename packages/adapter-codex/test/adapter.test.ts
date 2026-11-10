import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { installHooks, parseCodexTranscript, parseHookInput, uninstallHooks } from "../src/index.ts";

const fixture = readFileSync(join(import.meta.dir, "fixtures", "session.jsonl"), "utf8");

const line = (payload: Record<string, unknown>) =>
  JSON.stringify({ timestamp: "2026-11-01T18:06:00.000Z", type: "response_item", payload });

describe("parseCodexTranscript", () => {
  const transcript = parseCodexTranscript(fixture, "fallback");

  test("reads session metadata", () => {
    expect(transcript).toMatchObject({
      sessionId: "thread-1",
      cwd: "/work/app",
      branch: "leon/eng-42-retry-backoff",
      startedAt: "2026-11-01T18:00:00.000Z",
      endedAt: "2026-11-01T18:05:00.000Z",
    });
  });

  test("keeps what the person typed and drops injected context", () => {
    const userTurns = transcript.turns.filter((turn) => turn.role === "user").map((turn) => turn.text);
    expect(userTurns).toEqual([
      "Fix the webhook retry loop in src/webhooks/retry.ts so it backs off exponentially. Share this session.",
      "Also cap it at five attempts.",
    ]);
    expect(transcript.turns.some((turn) => turn.text.includes("You are Codex"))).toBe(false);
  });

  test("collects patched paths from exec code, resolving relative ones against cwd", () => {
    expect(transcript.touchedPaths).toEqual(["/work/app/src/webhooks/retry.ts", "/work/app/src/webhooks/backoff.ts"]);
    expect(transcript.ranCommands).toBe(true);
  });

  test("includes tool calls and their results", () => {
    const tools = transcript.turns.filter((turn) => turn.role === "tool").map((turn) => turn.text);
    expect(tools[0]).toStartWith("exec(const t = ALL_TOOLS");
    expect(tools).toContain("result: mcp__grapevine__share_session");
    expect(tools.some((text) => text.startsWith('shell({"command"'))).toBe(true);
  });

  test("detects share calls but not mentions of the tool name", () => {
    expect(transcript.shareRequest).toBe("share");
    const mentionOnly = fixture
      .split("\n")
      .filter((row) => !row.includes("tools.mcp__grapevine__share_session"))
      .join("\n");
    expect(parseCodexTranscript(mentionOnly).shareRequest).toBeUndefined();

    const stopped = `${fixture}${line({ type: "custom_tool_call", name: "exec", input: 'await tools["mcp__grapevine__stop_sharing"]({});' })}\n`;
    expect(parseCodexTranscript(stopped).shareRequest).toBe("stop");
    const direct = `${fixture}${line({ type: "function_call", name: "mcp__grapevine__stop_sharing", arguments: "{}" })}\n`;
    expect(parseCodexTranscript(direct).shareRequest).toBe("stop");
  });

  test("a session with only reads ran no commands and edited nothing", () => {
    const readOnly = [
      fixture.split("\n")[0],
      line({ type: "message", role: "user", content: [{ type: "input_text", text: "What does retry.ts do?" }] }),
      line({ type: "custom_tool_call", name: "exec", input: 'text(await tools.view_image({path:"a.png"}));' }),
    ].join("\n");
    expect(parseCodexTranscript(readOnly)).toMatchObject({ touchedPaths: [], ranCommands: false });
  });

  test("unwraps <user_query> from clients that add context around it", () => {
    const text = "<external_links>\nsearch results\n</external_links>\n<timestamp>Mon</timestamp>\n<user_query>\nFix the flaky test\n</user_query>";
    const wrapped = line({ type: "message", role: "user", content: [{ type: "input_text", text }] });
    const turns = parseCodexTranscript(wrapped).turns;
    expect(turns).toEqual([{ role: "user", text: "Fix the flaky test" }]);
  });

  test("tolerates empty and malformed input", () => {
    expect(parseCodexTranscript("not json\n\n", "fallback")).toMatchObject({ sessionId: "fallback", turns: [] });
  });
});

describe("parseHookInput", () => {
  test("accepts Codex's Stop payload", () => {
    const raw = JSON.stringify({
      session_id: "thread-1",
      transcript_path: "/t.jsonl",
      cwd: "/work/app",
      hook_event_name: "Stop",
      turn_id: "turn-1",
      stop_hook_active: false,
    });
    expect(parseHookInput(raw)).toMatchObject({ session_id: "thread-1", cwd: "/work/app", hook_event_name: "Stop" });
  });

  test("rejects payloads without a transcript", () => {
    expect(parseHookInput(JSON.stringify({ session_id: "s" }))).toBeNull();
    expect(parseHookInput("garbage")).toBeNull();
  });
});

describe("installHooks", () => {
  const command = "/usr/bin/bun /opt/grapevine/main.ts hook codex";
  const existing = { hooks: { Stop: [{ hooks: [{ type: "command", command: "./other.sh", timeout: 10 }] }] } };

  test("adds Stop and SessionEnd hooks next to existing ones, idempotently", () => {
    const { file, changed } = installHooks(existing, command);
    expect(changed).toBe(true);
    expect(file.hooks?.Stop).toHaveLength(2);
    expect(file.hooks?.SessionEnd).toEqual([{ hooks: [{ type: "command", command, timeout: 10 }] }]);
    expect(existing.hooks.Stop).toHaveLength(1);
    expect(installHooks(file, command).changed).toBe(false);
  });

  test("uninstall removes only grapevine hooks", () => {
    const { file, changed } = uninstallHooks(installHooks(existing, command).file);
    expect(changed).toBe(true);
    expect(file).toEqual(existing);
  });
});
