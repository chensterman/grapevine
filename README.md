# grapevine

**Your teammates' agents already figured this out.**

grapevine is path-indexed team memory for coding agents. When you ask your agent to share a session, a hook distills it into a short record: what the session set out to do, the decisions it made and why, the approaches that failed, and the questions it left open. Records are indexed by the files the session changed. Before your agent touches those files, it asks grapevine what your teammates' agents already learned.

- **Opt-in, then hands-free.** Say "share this session" and agent hooks keep the record up to date from then on. Sessions you don't share are never summarized.
- **Indexed by code.** Retrieval is driven by the paths you're about to edit, not by chat channels.
- **Distilled, not transcripts.** Only redacted summaries are stored. Raw transcripts stay on the author's machine.
- **Yours.** Local SQLite today; bring your own model for summaries, including local ones.

> Status: early (v0.1). Works locally for one person with Claude Code, Cursor, and Codex. Team sharing is next; see the [roadmap](#roadmap).

## How it works

```
 "share this session" ──(MCP: share_session)
 agent session ──(Stop / SessionEnd hook)──▶ grapevine capture (shared sessions only)
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

### Sharing a session

Sessions are captured only when you ask. Tell your agent "share this session" (or "record this for the team") and it calls grapevine's `share_session` tool. That call lands in the session's transcript, which is how the hook knows the session is opted in; the MCP server itself stores nothing. You can ask at any point: the summary always covers the whole session, including what came before. Say "stop sharing" and the agent calls `stop_sharing`, which stops capture and deletes the session's record.

Once a session is shared, capture is throttled: the Claude Code and Codex `Stop` and Cursor `stop` hooks fire after every agent turn, so grapevine summarizes right away, then at most every 15 minutes (configurable), and always when the session ends. Each session has one record that is updated in place. To capture everything without asking, set `capture.mode` to `always`. To capture a finished session after the fact, run `grapevine capture --transcript <file>`.

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

`grapevine init` detects Claude Code, Cursor, and Codex and:

- adds `Stop` and `SessionEnd` capture hooks to `~/.claude/settings.json`
- registers the MCP server with Claude Code (`claude mcp add --scope user grapevine ...`)
- adds the MCP server to `~/.cursor/mcp.json`
- adds `stop` and `sessionEnd` capture hooks to `~/.cursor/hooks.json`
- adds `Stop` and `SessionEnd` capture hooks to `~/.codex/hooks.json`
- registers the MCP server with Codex (`codex mcp add grapevine ...`)
- writes `~/.grapevine/config.json`

It backs up each file it changes to `<file>.grapevine-backup`. Use `--dry-run` to preview, and `grapevine uninstall` to undo. Then add the printed snippet to your `AGENTS.md` or `CLAUDE.md` so agents call `context_for` before editing.

### Model summaries

By default grapevine uses no model: a record gets the task (your first message) and the changed files, and nothing leaves your machine. For decisions, dead ends, and open questions, give grapevine its own key:

```sh
grapevine key set openai        # or anthropic; pastes into a hidden prompt, saved to ~/.grapevine/credentials.json (0600)
grapevine status                # shows the capture mode and which summarizer will run
```

You can also export `GRAPEVINE_OPENAI_API_KEY` or `GRAPEVINE_ANTHROPIC_API_KEY`, or point grapevine at a local model (see [Configuration](#configuration)). grapevine deliberately ignores generic names like `OPENAI_API_KEY`, so it never spends a key another tool exported. Ask your agent "help me set up grapevine summaries": it calls `summarizer_setup` and walks you through it, without asking you to paste the key into chat.

## CLI

```sh
grapevine search -p src/webhooks/retry.ts        # what do we know about this file?
grapevine search "redis cluster multi"           # full-text over tasks, decisions, dead ends
grapevine recent --all-repos                     # newest sessions everywhere
grapevine capture --transcript ~/.claude/projects/<project>/<session>.jsonl   # share a past session
grapevine status                                 # capture mode and summarizer
grapevine key set openai                         # save a key for grapevine only
grapevine mcp                                    # MCP server on stdio
```

Searches are scoped to the repo you're in (by normalized `origin` URL) unless you pass `--repo` or `--all-repos`.

## MCP tools

| Tool | Use |
| --- | --- |
| `context_for` | Paths and/or a task description in; ranked records out. Call before editing. |
| `recent_work` | Latest sessions in the repo. |
| `who_touches` | Which teammates' sessions changed a path, so you know who to ask. |
| `share_session` | Marks this session for capture. Call when the user asks to share it. |
| `stop_sharing` | Stops capture and deletes this session's record. |
| `summarizer_setup` | Which summarizer runs, and step-by-step setup for a key or local model. |

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
  "capture": { "mode": "opt-in", "minIntervalMinutes": 15, "detectPr": true, "issuePattern": "([a-z]+-\\d+)" },
  "store": { "type": "sqlite", "path": "/custom/grapevine.db" }
}
```

- `summarizer.provider`: `auto` (Anthropic if a grapevine Anthropic key is set or saved, else OpenAI-compatible if a grapevine OpenAI key is, else heuristic), `anthropic`, `openai-compatible` (OpenAI, OpenRouter, Ollama, vLLM, ...), or `heuristic`.
- `summarizer.apiKeyEnv`: read the key from this variable instead, e.g. for a local model or to reuse a key on purpose.
- `capture.mode`: `opt-in` (default) captures only sessions shared with `share_session`; `always` captures every session.
- `redact.patterns`: extra regexes, applied on top of the built-in secret patterns.
- `capture.issuePattern`: pulls an issue key such as `ENG-42` out of branch names. Off by default.
- `capture.detectPr`: looks up the branch's PR with `gh` when available.

## Privacy

- Secrets are redacted before anything reaches the summarizer, and again on the summary. Built-in rules cover private keys, AWS, GitHub, Anthropic, OpenAI, Slack, JWTs, bearer tokens, URL credentials, and `password=`-style assignments.
- Nothing is summarized unless you share the session (or set `capture.mode` to `always`).
- With no grapevine key configured, nothing leaves your machine. With one, the redacted transcript of shared sessions is sent to that model. Use a local model if transcripts can't leave your machine.
- Only the distilled record is stored. `transcriptRef` is a local file path, never the transcript itself.

## Architecture

| Package | Purpose |
| --- | --- |
| [`@chensterman/grapevine-core`](packages/core) | Record format, redaction, summarizers, path ranking, git inspection, `Store` interface |
| [`@chensterman/grapevine-store-sqlite`](packages/store-sqlite) | Local SQLite + FTS5 store |
| [`@chensterman/grapevine-adapter-claude-code`](packages/adapter-claude-code) | Claude Code transcript parser and hook installer |
| [`@chensterman/grapevine-adapter-cursor`](packages/adapter-cursor) | Cursor transcript parser and hook installer |
| [`@chensterman/grapevine-adapter-codex`](packages/adapter-codex) | Codex transcript parser and hook installer |
| [`@chensterman/grapevine-mcp`](packages/mcp) | MCP server |
| [`@chensterman/grapevine`](packages/cli) | `grapevine` CLI |

Adding an agent means writing an adapter that turns its transcript into the core `Transcript` type and installs its hooks. Adding a backend means implementing `Store`.

## Roadmap

- **Team sharing:** a self-hostable server (`grapevine serve`, Postgres) and a git-backed store (records as Markdown in a shared repo, no server).
- **Review before publish:** queue records locally so authors can edit or drop them before teammates see them.
- **More agents:** Grok Build and Orca adapters.
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
