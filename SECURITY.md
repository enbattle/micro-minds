# Security

## What this tool captures

micro-minds captures everything Claude Code exposes about a multi-agent
session through its hooks: tool calls, tool inputs and outputs, prompts,
permission requests, and (once captured — see the build plan) assistant
response text. This is, plainly, **real source code and real prompts from
your own work** — treat it as sensitive by default, because it is.

## Where it lives

Everything this tool captures and stores lives locally, on the machine
running it, under `~/.micro-minds/`:

- A SQLite database (`better-sqlite3`) — the queryable store.
- An append-only JSONL file per session — an independent durability backstop.
- `daemon.json` — a discovery file containing the daemon's port and a
  short-lived auth token (see
  [`docs/decisions/0006-daemon-discovery-and-auth.md`](docs/decisions/0006-daemon-discovery-and-auth.md)),
  written with restrictive (`0600`) permissions.

Nothing captured by this tool is ever sent anywhere else. The software in
this repository — hook scripts, the daemon, the UI, the MCP server — never
originates a network call beyond `127.0.0.1`. No telemetry, no analytics, no
phone-home. (Claude Code itself, the tool being observed, does of course
talk to Anthropic's API and possibly the web to do its own work — that's
outside anything this project touches or is responsible for. See
[`docs/decisions/`](docs/decisions/) and the build plan's architecture
principles for the full reasoning.)

The daemon binds to `127.0.0.1` only and requires a per-session auth token
on every request — binding to localhost alone does not stop another local
process, or a malicious web page's request to a `localhost` port, from
reaching an otherwise-unauthenticated local service, so this tool doesn't
rely on network binding as its only protection.

## Reporting a vulnerability

Please use GitHub's private vulnerability reporting for this repository
(the "Report a vulnerability" option under the repo's Security tab) rather
than opening a public issue. This lets a real fix land before the details
are public.

## Data retention

Captured data accumulates under `~/.micro-minds/` with no automatic
expiration by default. A `prune`/`gc` command (see the build plan, Phase 2)
is planned for managing this; until then, deleting `~/.micro-minds/` removes
everything this tool has captured.
