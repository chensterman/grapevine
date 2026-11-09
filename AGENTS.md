# Contributing to grapevine

## Commands

- `bun install`
- `bun test`: all packages
- `bun run typecheck`
- `bun run grapevine <command>`: run the CLI from source

## Layout

- `packages/core`: no runtime-specific code beyond `node:` built-ins. Everything else depends on it; it depends on nothing in this repo.
- `packages/store-*`: implementations of `Store`. Ranking lives in core (`rankCandidates`); stores only fetch candidates.
- `packages/adapter-*`: one per coding agent. Converts the agent's transcript to `Transcript` and installs its hooks. Keep agent-specific formats out of core.
- `packages/mcp`, `packages/cli`: thin layers over core and a store.

## Rules

- Stay generic. No company-, team-, or vendor-specific defaults beyond the public model APIs.
- Hooks must never break an agent session: hook entry points exit 0 and log failures to `$GRAPEVINE_HOME/logs`.
- Never store raw transcripts. Redact before summarizing and again on the summary.
- Tests must not touch the real `~`, call model APIs, or need network access. Use `GRAPEVINE_HOME`, `HOME`, and injected `fetch`.
