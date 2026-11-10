import { describe, expect, test } from "bun:test";
import { shareRequestFromToolCall } from "../src/transcript.ts";

describe("shareRequestFromToolCall", () => {
  test("recognizes namespaced MCP tool names", () => {
    expect(shareRequestFromToolCall("mcp__grapevine__share_session", {})).toBe("share");
    expect(shareRequestFromToolCall("mcp__grapevine__stop_sharing", {})).toBe("stop");
  });

  test("recognizes generic MCP-call tools that name the server and tool in their input", () => {
    const call = (toolName: string, namespace: string) => shareRequestFromToolCall("CallDynamicTool", { namespace, toolName });
    expect(call("share_session", "user-grapevine")).toBe("share");
    expect(call("stop_sharing", "user-grapevine")).toBe("stop");
  });

  test("ignores other servers' tools and unrelated calls", () => {
    expect(shareRequestFromToolCall("mcp__other__share_session", {})).toBeUndefined();
    expect(shareRequestFromToolCall("CallDynamicTool", { namespace: "slack", toolName: "share_session" })).toBeUndefined();
    expect(shareRequestFromToolCall("Grep", { pattern: "share_session grapevine" })).toBeUndefined();
  });
});
