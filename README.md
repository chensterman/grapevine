# grapevine

**Your teammates' agents already figured this out.**

grapevine is passive, path-indexed team memory for coding agents. When a coding-agent session ends, a hook distills it into a short record: what the session set out to do, the decisions it made and why, the approaches that failed, and the questions it left open. Records are indexed by the files the session changed. Before your agent touches those files, it asks grapevine what your teammates' agents already learned.

- **Passive.** Capture runs from agent hooks. Nobody has to remember to post updates.
- **Indexed by code.** Retrieval is driven by the paths you're about to edit, not by chat channels.
- **Distilled, not transcripts.** Only redacted summaries are stored. Raw transcripts stay on the author's machine.
- **Yours.** Local SQLite today; bring your own model for summaries, including local ones.

> Status: early (v0.1). Works locally for one person with Claude Code. Team sharing is next; see the [roadmap](#roadmap).

## How it works

```
 agent session ──(Stop / SessionEnd hook)──▶ grapevine capture
                                               │ redact secrets
                                               │ summarize with your model
                                               │ add paths from tool calls + git diff
                                               ▼
                                         record store (SQLite)
                                               ▲
 your next agent ──(MCP: context_for)──────────┘
```

A record looks like this:

```json
{
  "task": "Make the webhook retry loop in src/webhooks/retry.ts back off exponentially.",
  "repo": "github.com/acme/app",
  "branch": "leon/eng-42-retry-backoff",
  "author": "leon@acme.com",
  "agent": "claude-code",
  "paths": ["src/webhooks/retry.ts", "src/webhooks/backoff.ts"],
  "decisions": ["Capped exponential backoff with jitter, because a fixed 1s delay still overwhelmed the endpoint during incidents."],
  "deadEnds": ["A fixed 1s delay between retries still overwhelmed the endpoint."],
  "openQuestions": [],
  "status": "done"
}
```

Capture is throttled: the Claude Code `Stop` hook fires after every agent turn, so grapevine re-summarizes at most every 15 minutes per session (configurable), and always on `SessionEnd`. Each session has one record that is updated in place.

## Quick start

Requires [Bun](https://bun.sh) 1.2+ and git.

```sh
git clone https://github.com/chensterman/grapevine
cd grapevine
bun install
bun run grapevine init        # installs hooks and registers the MCP server
alias grapevine="bun $PWD/packages/cli/src/main.ts"   # optional, for the commands below
```

Hooks and MCP config point at the absolute path of this checkout, so they keep working without `grapevine` on your `PATH`. npm packages are coming.

`grapevine init` detects Claude Code and Cursor and:

- adds `Stop` and `SessionEnd` capture hooks to `~/.claude/settings.json`
- registers the MCP server with Claude Code (`claude mcp add --scope user grapevine ...`)
- adds the MCP server to `~/.cursor/mcp.json`
- writes `~/.grapevine/config.json`

It backs up each file it changes to `<file>.grapevine-backup`. Use `--dry-run` to preview, and `grapevine uninstall` to undo. Then add the printed snippet to your `AGENTS.md` or `CLAUDE.md` so agents call `context_for` before editing.

To get real summaries, set `ANTHROPIC_API_KEY` or `OPENAI_API_KEY`. Without a key, grapevine falls back to a heuristic summary (the first user message as the task).

## CLI

```sh
grapevine search -p src/webhooks/retry.ts        # what do we know about this file?
grapevine search "redis cluster multi"           # full-text over tasks, decisions, dead ends
grapevine recent --all-repos                     # newest sessions everywhere
grapevine capture --transcript ~/.claude/projects/<project>/<session>.jsonl
grapevine mcp                                    # MCP server on stdio
```

Searches are scoped to the repo you're in (by normalized `origin` URL) unless you pass `--repo` or `--all-repos`.

## MCP tools

| Tool | Use |
| --- | --- |
| `context_for` | Paths and/or a task description in; ranked records out. Call before editing. |
| `recent_work` | Latest sessions in the repo. |
| `who_touches` | Which teammates' sessions changed a path, so you know who to ask. |

Results are ranked by path proximity (same file, then same directory, then nearby), full-text match, and recency.

## Configuration

`~/.grapevine/config.json` (or `$GRAPEVINE_HOME/config.json`):

```json
{
  "summarizer": {
    "provider": "auto",
    "model": "claude-haiku-4-5",
    "baseUrl": "http://localhost:11434/v1",
    "apiKeyEnv": "OLLAMA_API_KEY"
  },
  "redact": { "patterns": ["acme-customer-\\d+"] },
  "capture": { "minIntervalMinutes": 15, "detectPr": true, "issuePattern": "([a-z]+-\\d+)" },
  "store": { "type": "sqlite", "path": "/custom/grapevine.db" }
}
```

- `summarizer.provider`: `auto` (Anthropic if `ANTHROPIC_API_KEY` is set, else OpenAI-compatible if `OPENAI_API_KEY` is set, else heuristic), `anthropic`, `openai-compatible` (OpenAI, OpenRouter, Ollama, vLLM, ...), or `heuristic`.
- `redact.patterns`: extra regexes, applied on top of the built-in secret patterns.
- `capture.issuePattern`: pulls an issue key such as `ENG-42` out of branch names. Off by default.
- `capture.detectPr`: looks up the branch's PR with `gh` when available.

## Privacy

- Secrets are redacted before anything reaches the summarizer, and again on the summary. Built-in rules cover private keys, AWS, GitHub, Anthropic, OpenAI, Slack, JWTs, bearer tokens, URL credentials, and `password=`-style assignments.
- The transcript is sent to the summarizer you configure. Use a local model if transcripts can't leave your machine.
- Only the distilled record is stored. `transcriptRef` is a local file path, never the transcript itself.

## Architecture

| Package | Purpose |
| --- | --- |
| [`@chensterman/grapevine-core`](packages/core) | Record format, redaction, summarizers, path ranking, git inspection, `Store` interface |
| [`@chensterman/grapevine-store-sqlite`](packages/store-sqlite) | Local SQLite + FTS5 store |
| [`@chensterman/grapevine-adapter-claude-code`](packages/adapter-claude-code) | Claude Code transcript parser and hook installer |
| [`@chensterman/grapevine-mcp`](packages/mcp) | MCP server |
| [`@chensterman/grapevine`](packages/cli) | `grapevine` CLI |

Adding an agent means writing an adapter that turns its transcript into the core `Transcript` type and installs its hooks. Adding a backend means implementing `Store`.

## Roadmap

- **Team sharing:** a self-hostable server (`grapevine serve`, Postgres) and a git-backed store (records as Markdown in a shared repo, no server).
- **Review before publish:** queue records locally so authors can edit or drop them before teammates see them.
- **More agents:** Cursor, Codex, and Orca adapters.
- **Overlap detection:** warn when two people's active sessions touch the same paths.
- **Evaluation:** a set of real transcripts paired with the facts a teammate needed, to measure summary quality.

## Related work

- [mcp_agent_mail](https://github.com/Dicklesworthstone/mcp_agent_mail_rust) and [agent-loom](https://github.com/osteele/agent-loom): messaging and file reservations between concurrently running agents.
- [Beads](https://github.com/gastownhall/beads): a dependency-aware issue tracker as agent memory.
- [Guild](https://github.com/mathomhaus/guild): local task board and knowledge store for agents.
- [Orca](https://github.com/stablyai/orca): runs many agents in parallel worktrees.

grapevine complements these: it doesn't coordinate live agents, it remembers what finished sessions learned and hands that to whoever touches the same code next.

## License

[MIT](LICENSE)
