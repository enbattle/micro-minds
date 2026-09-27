<!--
Maintainer note: private vulnerability reporting must be switched on for the link below to work.
GitHub repo → Settings → Security (Code security) → Private vulnerability reporting → Enable.
-->

# Security policy

micro-minds is a local, single-user web app that runs AI coding CLIs in embedded terminals. It is
a solo-maintained side project in early development (pre-1.0). This page says what is in scope,
how to report a problem, and what to expect afterwards.

## Scope

In scope:

- **The app** (`apps/server`, `apps/web`, `packages/*`): the server bound to `127.0.0.1`, its
  WebSocket and HTTP endpoints (`/ws`, `POST /hooks`, `POST /otel/*`), UI and hook tokens,
  worktree and session management, the event store under `$MICROMINDS_HOME`, terminal
  rendering in the browser, and the hook relay.
- **The dev harness** (`.claude/`, `evals/harness/`): for example a way to get Claude Code,
  working in this repo, past the credential guard. See [docs/dev-harness.md](docs/dev-harness.md).

Examples of what we want to hear about: a web page that can reach the local server (DNS
rebinding, cross-site WebSocket), a hook token that grants more than its own session's ingest
endpoints, terminal output that can write your clipboard or run script in the page, secrets that
end up unscrubbed in the database or on the wire, a path that lets a worktree operation touch
files outside `$MICROMINDS_HOME/worktrees/`, or app code reading provider credential directories.

## Supported versions

| Version | Supported |
|---|---|
| `main` | Yes |
| Anything else (old commits, forks) | No |

There are no releases yet. Fixes land on `main` only.

## Reporting a vulnerability

**Please do not open a public issue, discussion or pull request for a security problem.**

Report it privately through GitHub: open the repository's **Security** tab and click
**Report a vulnerability**. Only the maintainer can see the report.

Please include:

- What the problem is and what an attacker gains (for example "a website can type into an
  agent's terminal").
- The attacker you assume: a website in your browser, a prompt-injected agent, another local
  process, a malicious repo or dependency.
- Steps to reproduce, ideally with the fake provider rather than a real CLI.
- The commit hash, OS (Windows, macOS or Linux), Node version and browser.
- Any logs or payloads, **with tokens, keys and personal paths removed**.
- A suggested fix, if you have one.

## What to expect

This is a best-effort, one-person project, so there is no formal SLA:

- Acknowledgement within about **7 days**.
- An initial assessment (confirmed, needs more information, or out of scope) within about
  **30 days**.
- A fix on `main` as soon as practical, prioritised by impact. Credit in the advisory if you
  want it.
- Please allow time for a fix before disclosing publicly. If you have heard nothing after
  30 days, a polite follow-up on the report is welcome.

## Out of scope

- **The provider CLIs themselves** (Claude Code, Gemini CLI, Codex CLI) and their hooks,
  permission systems or sandboxes. Report those to their vendors.
- **Attacks that need an already-compromised local account**, including any process running as
  your OS user that reads memory, environment variables or files in your home directory.
- **Your own provider terms and accounts.** micro-minds never reads or proxies credentials; you
  use each CLI with your own login and are responsible for your provider's terms.
- Exposing the server beyond `127.0.0.1` by modifying the code (it refuses to bind elsewhere).
- Actions an agent performs inside its own worktree that the provider CLI's permission prompts
  allowed.
- Denial of service that needs you to click through the UI, or that only affects your own
  machine through normal heavy use.

## Threat model

The assets, attackers, trust boundaries and per-component mitigations are in
[docs/security/threat-model.md](docs/security/threat-model.md). The security requirements it
builds on are in [docs/PLAN.md](docs/PLAN.md) §9 and the hard rules in [CLAUDE.md](CLAUDE.md).
