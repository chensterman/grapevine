import {
  formatRecord,
  formatResults,
  type RepoIdentity,
  readRepoIdentity,
  relativeTime,
  type Store,
  toRepoRelative,
  VERSION,
} from "@chensterman/grapevine-core";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const ALL_REPOS = "*";

const INSTRUCTIONS = `grapevine holds notes from teammates' coding-agent sessions: what they worked on, decisions they made, approaches that failed, and open questions, indexed by the files they changed.

Call context_for before starting a task or editing files, with the paths you plan to touch and a short description of the task. Treat the results as a teammate's notes: reuse their decisions, avoid their dead ends, and tell the user when your plan conflicts with work in progress.

Sessions are only recorded when the user asks. When they ask to share, record, or save this session for the team, call share_session. When they ask to stop, call stop_sharing. For help setting up model summaries, call summarizer_setup.`;

export interface ServerOptions {
  store: Store;
  /** Used to infer the repo when a tool call doesn't pass `cwd`. */
  defaultCwd?: string;
  /** Describes which summarizer captures will use and how to set one up. */
  summarizerStatus?: () => string;
}

const scopeFields = {
  cwd: z.string().optional().describe("Absolute path of your current workspace. Used to infer the repo."),
  repo: z
    .string()
    .optional()
    .describe('Repo id like "github.com/org/repo". Use "*" to search every repo. Defaults to the repo at cwd.'),
};

function text(value: string) {
  return { content: [{ type: "text" as const, text: value }] };
}

export function createGrapevineServer({
  store,
  defaultCwd = process.cwd(),
  summarizerStatus = () => "Summarizer status is unavailable.",
}: ServerOptions): McpServer {
  const server = new McpServer({ name: "grapevine", version: VERSION }, { instructions: INSTRUCTIONS });

  const scope = (cwd?: string, repo?: string): { identity: RepoIdentity; repo?: string } => {
    const identity = readRepoIdentity(cwd ?? defaultCwd);
    if (repo === ALL_REPOS) return { identity, repo: undefined };
    return { identity, repo: repo ?? identity.repo };
  };
  const relativize = (root: string, paths: string[]) =>
    paths.map((path) => toRepoRelative(root, path)).filter((path): path is string => path !== null);

  server.registerTool(
    "context_for",
    {
      title: "Teammate context for paths or a task",
      description:
        "Before editing files or starting a task, look up what teammates' agents already learned about the same code: their decisions, dead ends, and open questions.",
      inputSchema: {
        paths: z.array(z.string()).optional().describe("Files or directories you plan to read or change."),
        query: z.string().optional().describe("Short description of your task or the topic you need context on."),
        limit: z.number().int().min(1).max(20).optional(),
        ...scopeFields,
      },
    },
    async ({ paths, query, limit, cwd, repo }) => {
      const { identity, repo: scopedRepo } = scope(cwd, repo);
      const results = await store.search({
        repo: scopedRepo,
        paths: relativize(identity.root, paths ?? []),
        text: query,
        limit: limit ?? 5,
      });
      return text(results.length ? formatResults(results) : "No teammate context found for these paths or this topic.");
    },
  );

  server.registerTool(
    "recent_work",
    {
      title: "Recent sessions in this repo",
      description: "List the most recent coding-agent sessions recorded for a repo, newest first.",
      inputSchema: { limit: z.number().int().min(1).max(50).optional(), ...scopeFields },
    },
    async ({ limit, cwd, repo }) => {
      const records = await store.recent({ repo: scope(cwd, repo).repo, limit: limit ?? 10 });
      return text(records.length ? records.map((record) => formatRecord(record)).join("\n\n") : "No sessions recorded yet.");
    },
  );

  server.registerTool(
    "who_touches",
    {
      title: "Who has worked on a path",
      description: "Find which teammates' sessions changed a file or directory, so you know who to ask.",
      inputSchema: { path: z.string().describe("File or directory."), ...scopeFields },
    },
    async ({ path, cwd, repo }) => {
      const { identity, repo: scopedRepo } = scope(cwd, repo);
      const results = await store.search({ repo: scopedRepo, paths: relativize(identity.root, [path]), limit: 50 });
      const byAuthor = new Map<string, { count: number; latestTask: string; latestAt: string }>();
      for (const { record, matchedPaths } of results) {
        if (matchedPaths.length === 0) continue;
        const entry = byAuthor.get(record.author);
        if (!entry) byAuthor.set(record.author, { count: 1, latestTask: record.task, latestAt: record.updatedAt });
        else {
          entry.count += 1;
          if (record.updatedAt > entry.latestAt) Object.assign(entry, { latestTask: record.task, latestAt: record.updatedAt });
        }
      }
      if (byAuthor.size === 0) return text(`No recorded sessions touched ${path}.`);
      const lines = [...byAuthor.entries()]
        .sort((a, b) => b[1].latestAt.localeCompare(a[1].latestAt))
        .map(
          ([author, entry]) =>
            `- ${author}: ${entry.count} session${entry.count === 1 ? "" : "s"}, latest ${relativeTime(entry.latestAt)}: ${entry.latestTask}`,
        );
      return text(lines.join("\n"));
    },
  );

  // The share tools only mark the session: the agent's hook sees the call in the transcript and
  // captures from then on. The server can't tell which session called it, so it stores nothing here.
  server.registerTool(
    "share_session",
    {
      title: "Share this session with the team",
      description:
        "Call only when the user asks to share, record, or save this session for teammates (e.g. \"share this session\", \"turn on grapevine\"). Marks the whole session, including earlier messages, to be summarized after each turn.",
      inputSchema: {},
    },
    async () =>
      text(
        `This session is marked for sharing. When this turn ends, grapevine summarizes the whole session so far (redacted), then refreshes the summary at most every 15 minutes by default and once more when the session ends. Tell the user, and that they can say "stop sharing" at any time.\n\n${summarizerStatus()}`,
      ),
  );

  server.registerTool(
    "stop_sharing",
    {
      title: "Stop sharing this session",
      description:
        "Call when the user asks to stop sharing or recording this session. Stops future summaries and deletes this session's saved summary after this turn.",
      inputSchema: {},
    },
    async () =>
      text("Sharing is off for this session. After this turn, grapevine stops summarizing it and deletes its saved summary."),
  );

  server.registerTool(
    "summarizer_setup",
    {
      title: "Check or set up the grapevine summarizer",
      description:
        "Reports which model summarizes shared sessions and gives step-by-step instructions for setting up a key or a local model. Use when the user asks about grapevine summaries, keys, or privacy.",
      inputSchema: {},
    },
    async () => text(summarizerStatus()),
  );

  return server;
}

export async function runStdioServer(options: ServerOptions): Promise<void> {
  const server = createGrapevineServer(options);
  await server.connect(new StdioServerTransport());
}
