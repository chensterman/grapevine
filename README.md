# grapevine

**Your teammates' agents already figured this out.**

grapevine is path-indexed team memory for coding agents. When you ask your agent to share a session, a hook distills it into a short record: what the session set out to do, the decisions it made and why, the approaches that failed, and the questions it left open. Records are indexed by the files the session changed. Before your agent touches those files, it asks grapevine what your teammates' agents already learned.

- **Opt-in, then hands-free.** Say "share this session" and agent hooks keep the record up to date from then on. Sessions you don't share are never summarized.
- **Indexed by code.** Retrieval is driven by the paths you're about to edit, not by chat channels.
- **Distilled, not transcripts.** Only redacted summaries are stored. Raw transcripts stay on the author's machine.
- **Yours.** Local SQLite today; bring your own model for summaries, including local ones.

> Status: early (v0.1). Works locally for one person with Claude Code, Cursor, and Codex. A team shares records through a [sync target](#team-sharing) it plugs in; none ships with grapevine yet. See the [roadmap](#roadmap).

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
  "decisions": [
    {
      "text": "Capped exponential backoff with jitter, because a fixed 1s delay still overwhelmed the endpoint during incidents.",
      "paths": ["src/webhooks/backoff.ts"]
    }
  ],
  "deadEnds": [{ "text": "A fixed 1s delay between retries still overwhelmed the endpoint.", "paths": ["src/webhooks/retry.ts"] }],
  "openQuestions": [],
  "pending": [{ "text": "PR 212 is waiting for a review from the payments team.", "paths": [] }],
  "status": "done",
  "commit": "3f9c2e1…"
}
```

Decisions, dead ends, and open questions are meant to last. `pending` holds what the work was waiting on when it was captured, such as a review, an open pull request, or a planned follow-up. That stops being true within days, so pending items are not searched and agents see them only while the record is less than a week old.

The model must cite the transcript turns behind each item. Capture drops items whose cited turns don't exist or don't mention them, and keeps only file links to files the session changed. The check catches invented items, not misread ones. When an agent reads a record, grapevine checks which of its files changed in commits after the capture and marks the affected notes "changed since", so the agent checks the current code before trusting them.

### Sharing a session

Sessions are captured only when you ask. Tell your agent "share this session" (or "record this for the team") and it calls grapevine's `share_session` tool. That call lands in the session's transcript, which is how the hook knows the session is opted in; the MCP server itself stores nothing. You can ask at any point: the summary always covers the whole session, including what came before. Say "stop sharing" and the agent calls `stop_sharing`, which stops capture and deletes the session's record.

Once a session is shared, capture is throttled: the Claude Code and Codex `Stop` and Cursor `stop` hooks fire after every agent turn, so grapevine summarizes right away, then at most every 15 minutes (configurable), and always when the session ends. Each session has one record per repo it changed files in, updated in place. Each file is filed under its own checkout, so a session that runs from a folder holding several clones or worktrees is recorded under the right repos, with repo-relative paths. Files the agent read with its read tool (Claude Code and Cursor) are kept on the record as `readPaths` and count for half a changed file in a lookup. A session that changed nothing gets one record, in the repo it ran in when it read files there and otherwise in the repo it read the most. To capture everything without asking, set `capture.mode` to `always`. To capture a finished session after the fact, run `grapevine capture --transcript <file>`.

### Team sharing

Records stay on your machine until you configure a sync target: a shared place that keeps the team's records, such as a server, a git repo, or a document store. A target is a module that implements four operations:

```ts
import type { CreateSyncTarget } from "@chensterman/grapevine-core";

export const createSyncTarget: CreateSyncTarget = (options) => ({
  put: async (record) => {},     // store the record under record.id
  remove: async (id) => {},      // remove it; not an error when it is absent
  list: async () => [],          // every record held now, as { id, version }
  get: async (id) => null,       // the record, or null
});
```

Point `sync.target` in the config at the module and grapevine does the rest:

- Search and ranking stay on the local store, so a lookup works when the target is down.
- A capture is written locally, queued, and pushed in the background. A push that fails stays queued and is sent with the next one.
- Before a lookup, grapevine pulls records that are new or changed and deletes the ones the target dropped. It pulls at most every 5 minutes, and an agent's lookup waits 4 seconds at most.
- `stop_sharing` removes the session's record from the target as well.
- Records you pushed are never overwritten by the target's copy, so a target may rewrite what it stores.

`grapevine sync` pushes and pulls now, and `grapevine status` shows what is waiting. Records captured before the target was configured are not pushed.

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

Codex runs new hooks only after you trust them, and skips untrusted ones without a warning, so review and trust grapevine's hooks in Codex after `init`.

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
grapevine status                                 # capture mode, summarizer, and sync target
grapevine sync                                   # push queued records and pull teammates' records now
grapevine key set openai                         # save a key for grapevine only
grapevine mcp                                    # MCP server on stdio
```

Searches are scoped to the repo you're in (by normalized `origin` URL) unless you pass `--repo` or `--all-repos`. A path is searched in the repo it belongs to, wherever you run from. In a folder outside git, the scope is the clones and worktrees up to two levels inside it.

## MCP tools

| Tool | Use |
| --- | --- |
| `context_for` | Paths and/or a task description in; ranked records out. Call before editing. |
| `recent_work` | Latest sessions in the repo. |
| `who_touches` | Which teammates' sessions changed a path, so you know who to ask. |
| `share_session` | Marks this session for capture. Call when the user asks to share it. |
| `stop_sharing` | Stops capture and deletes this session's record. |
| `summarizer_setup` | Which summarizer runs, and step-by-step setup for a key or local model. |

Results are ranked by path proximity (same file, then same directory, then nearby or a file of the same name in another folder), full-text match, and recency. A file a session only read counts for half a changed one.

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
  "store": { "type": "sqlite", "path": "/custom/grapevine.db" },
  "sync": { "target": "~/team/grapevine-target.ts", "options": { "team": "acme" }, "pullIntervalMinutes": 5 }
}
```

- `summarizer.provider`: `auto` (Anthropic if a grapevine Anthropic key is set or saved, else OpenAI-compatible if a grapevine OpenAI key is, else heuristic), `anthropic`, `openai-compatible` (OpenAI, OpenRouter, Ollama, vLLM, ...), or `heuristic`.
- `summarizer.apiKeyEnv`: read the key from this variable instead, e.g. for a local model or to reuse a key on purpose.
- `capture.mode`: `opt-in` (default) captures only sessions shared with `share_session`; `always` captures every session.
- `redact.patterns`: extra regexes, applied on top of the built-in secret patterns.
- `capture.issuePattern`: pulls an issue key such as `ENG-42` out of branch names. Off by default.
- `capture.detectPr`: looks up the branch's PR with `gh` when available.
- `sync.target`: the module that implements the team's [sync target](#team-sharing): a file path (absolute, `~/…`, or `./…` from the grapevine home), or the name of a package installed where grapevine can import it. `sync.options` is passed to it as is. Off by default.

## Privacy

- Secrets are redacted before anything reaches the summarizer, and again on the summary. Built-in rules cover private keys, AWS, GitHub, Anthropic, OpenAI, Slack, JWTs, bearer tokens, URL credentials, and `password=`-style assignments.
- Nothing is summarized unless you share the session (or set `capture.mode` to `always`).
- With no grapevine key configured, nothing leaves your machine. With one, the redacted transcript of shared sessions is sent to that model. Use a local model if transcripts can't leave your machine.
- Only the distilled record is stored. `transcriptRef` is a local file path, never the transcript itself.
- With a sync target configured, the distilled record of each shared session is sent to it, without `transcriptRef`. Transcripts are never sent.

## Architecture

| Package | Purpose |
| --- | --- |
| [`@chensterman/grapevine-core`](packages/core) | Record format, redaction, summarizers, path ranking, git inspection, `Store` and `SyncTarget` interfaces |
| [`@chensterman/grapevine-store-sqlite`](packages/store-sqlite) | Local SQLite + FTS5 store |
| [`@chensterman/grapevine-adapter-claude-code`](packages/adapter-claude-code) | Claude Code transcript parser and hook installer |
| [`@chensterman/grapevine-adapter-cursor`](packages/adapter-cursor) | Cursor transcript parser and hook installer |
| [`@chensterman/grapevine-adapter-codex`](packages/adapter-codex) | Codex transcript parser and hook installer |
| [`@chensterman/grapevine-mcp`](packages/mcp) | MCP server |
| [`@chensterman/grapevine`](packages/cli) | `grapevine` CLI |

Adding an agent means writing an adapter that turns its transcript into the core `Transcript` type and installs its hooks. Adding a local backend means implementing `Store`. Sharing with a team means implementing `SyncTarget`.

## Roadmap

- **Sync targets:** ship two with grapevine: a git-backed one (records as files in a shared repo, no server) and a self-hostable server (`grapevine serve`, Postgres). Add a command that pushes records captured before a target was configured.
- **Review before publish:** queue records locally so authors can edit or drop them before teammates see them.
- **More agents:** Grok Build and Orca adapters.
- **Overlap detection:** warn when two people's active sessions touch the same paths.
- **Evaluation:** a set of real transcripts paired with the facts a teammate needed, to measure summary quality.
- **Long sessions:** the summarizer sees only the first 18k and last 42k characters of a transcript, so the middle of long sessions is lost. Merge new turns into the existing record instead, and skip captures with no new turns.
- **Sharper items:** require a separate `why` for decisions and dead ends, and keep agent-environment noise (sandbox errors, to-dos for the author, explanations of existing code) out of records.

## Related work

- [mcp_agent_mail](https://github.com/Dicklesworthstone/mcp_agent_mail_rust) and [agent-loom](https://github.com/osteele/agent-loom): messaging and file reservations between concurrently running agents.
- [Beads](https://github.com/gastownhall/beads): a dependency-aware issue tracker as agent memory.
- [Guild](https://github.com/mathomhaus/guild): local task board and knowledge store for agents.
- [Orca](https://github.com/stablyai/orca): runs many agents in parallel worktrees.

grapevine complements these: it doesn't coordinate live agents, it remembers what finished sessions learned and hands that to whoever touches the same code next.

## License

[MIT](LICENSE)
