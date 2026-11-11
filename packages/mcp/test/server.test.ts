import { afterEach, describe, expect, test } from "bun:test";
import type { ContextRecord, Store } from "@chensterman/grapevine-core";
import { openSqliteStore } from "@chensterman/grapevine-store-sqlite";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { multiRepoWorkspace } from "../../core/test/workspace.ts";
import { createGrapevineServer } from "../src/index.ts";

const cwd = mkdtempSync(join(tmpdir(), "grapevine-mcp-"));
const repo = `local/${cwd.split("/").pop()}`;

function record(id: string, overrides: Partial<ContextRecord> = {}): ContextRecord {
  return {
    id,
    sessionKey: `test:${id}`,
    repo,
    author: "dev@acme.com",
    agent: "claude-code",
    updatedAt: new Date().toISOString(),
    task: `Task ${id}`,
    paths: ["src/webhooks/retry.ts"],
    decisions: [{ text: "Use jitter because retries synchronized", paths: ["src/webhooks/retry.ts"] }],
    deadEnds: [],
    openQuestions: [],
    pending: [],
    status: "done",
    ...overrides,
  };
}

let store: Store;
afterEach(() => store?.close());

async function connect(): Promise<Client> {
  store = openSqliteStore(":memory:");
  await store.upsert(record("a"));
  await store.upsert(record("b", { author: "pat@acme.com", paths: ["src/webhooks/backoff.ts"] }));
  await store.upsert(record("c", { repo: "github.com/acme/other", task: "Elsewhere" }));
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await createGrapevineServer({ store, defaultCwd: cwd, summarizerStatus: () => "Summarizer: test" }).connect(
    serverTransport,
  );
  const client = new Client({ name: "test", version: "0.0.0" });
  await client.connect(clientTransport);
  return client;
}

function textOf(result: Awaited<ReturnType<Client["callTool"]>>): string {
  return (result.content as { type: string; text: string }[]).map((block) => block.text).join("\n");
}

describe("grapevine MCP server", () => {
  test("lists its tools and instructions", async () => {
    const client = await connect();
    const { tools } = await client.listTools();
    expect(tools.map((tool) => tool.name).sort()).toEqual([
      "context_for",
      "recent_work",
      "share_session",
      "stop_sharing",
      "summarizer_setup",
      "who_touches",
    ]);
    expect(client.getInstructions()).toContain("context_for");
    expect(client.getInstructions()).toContain("share_session");
  });

  test("share_session confirms and reports the summarizer; summarizer_setup returns setup help", async () => {
    const client = await connect();
    const shared = textOf(await client.callTool({ name: "share_session", arguments: {} }));
    expect(shared).toContain("marked for sharing");
    expect(shared).toContain("Summarizer: test");
    expect(textOf(await client.callTool({ name: "summarizer_setup", arguments: {} }))).toBe("Summarizer: test");
    expect(textOf(await client.callTool({ name: "stop_sharing", arguments: {} }))).toContain("Sharing is off");
  });

  test("context_for scopes to the caller's repo and accepts absolute paths", async () => {
    const client = await connect();
    const result = textOf(
      await client.callTool({ name: "context_for", arguments: { paths: [join(cwd, "src/webhooks/retry.ts")] } }),
    );
    expect(result).toContain("### Task a");
    expect(result).toContain("Use jitter because retries synchronized");
    expect(result).not.toContain("Elsewhere");
  });

  test("repo '*' searches everywhere", async () => {
    const client = await connect();
    const result = textOf(
      await client.callTool({ name: "context_for", arguments: { paths: ["src/webhooks/retry.ts"], repo: "*" } }),
    );
    expect(result).toContain("Elsewhere");
  });

  test("who_touches groups sessions by author", async () => {
    const client = await connect();
    const result = textOf(await client.callTool({ name: "who_touches", arguments: { path: "src/webhooks" } }));
    expect(result).toContain("dev@acme.com: 1 session");
    expect(result).toContain("pat@acme.com: 1 session");
  });

  test("a workspace folder outside git covers the checkouts inside it", async () => {
    const client = await connect();
    const workspace = multiRepoWorkspace();
    await store.upsert(record("app", { repo: "github.com/acme/app", task: "In app" }));
    await store.upsert(record("lib", { repo: "github.com/acme/lib", task: "In lib" }));

    const context = textOf(
      await client.callTool({ name: "context_for", arguments: { cwd: workspace, paths: ["app/src/webhooks/retry.ts"] } }),
    );
    expect(context).toContain("In app");
    expect(context).not.toContain("In lib");
    expect(context).not.toContain("Task a");

    const recent = textOf(await client.callTool({ name: "recent_work", arguments: { cwd: workspace } }));
    expect(recent).toContain("In app");
    expect(recent).toContain("In lib");
    expect(recent).not.toContain("Task a");
    expect(recent).not.toContain("Elsewhere");

    const who = textOf(
      await client.callTool({
        name: "who_touches",
        arguments: { cwd: workspace, path: join(workspace, ".worktrees", "app-fix", "src", "webhooks") },
      }),
    );
    expect(who).toBe("- dev@acme.com: 1 session, latest just now: In app");
  });

  test("recent_work lists newest first", async () => {
    const client = await connect();
    const result = textOf(await client.callTool({ name: "recent_work", arguments: {} }));
    expect(result).toContain("Task a");
    expect(result).not.toContain("Elsewhere");
  });
});
