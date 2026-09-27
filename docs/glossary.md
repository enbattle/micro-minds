# Glossary

Terms with a specific meaning in micro-minds. Several sound interchangeable but aren't; using the
wrong one leads to wrong code (for example, putting health logic in an adapter). When a term here
conflicts with casual usage, this page wins. PLAN.md is the source for the underlying design.

## Sessions and agents

| Term | Meaning | Not to be confused with |
|---|---|---|
| **Session** | One provider CLI process that micro-minds started, in its own PTY and worktree, with its own `sessionId` (a ULID). The unit you create, stop, kill and resume. | The provider's own conversation id (`resumeId`), or the UI session (below). |
| **Agent** | Anything that shows up as a character and a board row. The **root agent** of a session has `agentId = sessionId`. | "Session": one session can contain many agents. |
| **Subagent** | An agent the root agent spawned inside the same session (Claude Code's Task/Agent tool). It has its own `agentId` and a `parentAgentId`, and gets a smaller character at a side desk. | A second session. Subagents share their parent's PTY and worktree. |
| **Provider** | Which CLI runs the session: `claude`, `gemini`, `codex`, or `fake`. | A model. One provider can use several models (see usage). |
| **Fake provider** | A scripted stand-in CLI that replays recorded hook payloads through the real pipeline. It's used for tests, CI and demo mode. | A mock inside the code. It's a real child process. |
| **resumeId** | The provider's own session id, captured from the `SessionStart` hook payload and used for `claude --resume` (D20). | Our `sessionId`, which stays the same across resumes. |
| **Worktree** | The git worktree a session runs in, under `$MICROMINDS_HOME/worktrees/<repo-slug>/<sessionId>` on branch `micro-minds/<sessionId>` (D5, D12). | The user's main checkout, which sessions never touch. |

## State an agent is in

These are four **independent channels**. An agent can be `running`, `warning` and `focused` all at
once, with a raised hand on top.

| Term | Values | Who sets it |
|---|---|---|
| **Activity** | `starting`, `idle`, `thinking`, `reading`, `writing`, `running`, `delegating`, `waiting_permission`, `waiting_input`, `done`, `offline` | Derived by `reduce()` from events (§4.3) |
| **Health** | `ok`, `notice`, `warning`, `error` (shown grey, amber, red) | Derived by `reduce()` using `severity.ts` rules (§6). **Never** set by adapters (hard rule 6) |
| **Attention** | `permission` (✋) or `question` / `idle` (❓), or none | Derived from `attention.*` events. A waiting agent isn't failing, so this is separate from health |
| **Mood** | `distressed`, `worried`, `frustrated`, `focused`, `waiting`, `idle`, `starting`, `done`/`offline` | Pure `mood()` selector over the three above (§4.4, D22). The scene renders it; nothing stores it |

**Severity** is the older name for the rules that produce health. The rules live in `severity.ts`.
"A failing tool" is a fact on an event; "warning health" is a conclusion the reducer draws from
facts over time.

**Telemetry level:** `full` when hooks work, or `limited` in the terminal-only fallback (§5.4),
which is shown as a badge.

## Events and state

| Term | Meaning |
|---|---|
| **Hook** | A command or HTTP call the provider CLI makes on lifecycle moments (tool start/finish, permission, stop). Hooks are the structured event channel (D2). |
| **Hook relay** | `packages/hook-relay`: the fail-open command a CLI runs when it can't POST hooks natively (D9). |
| **AgentEvent** | The normalized, provider-independent event (§4.1). Adapters produce **facts** only: `kind`, `tool.category`, `errorClass`, `usage`. |
| **Adapter** | Per-provider code turning raw hook payloads into `AgentEvent`s. It must pass the shared conformance suite. |
| **Tool category** | `read`, `write`, `exec`, `delegate`, `ask`, `web`, `other`: the cross-provider vocabulary the reducer and UI use instead of tool names. |
| **raw** | The original payload kept on an event. It's size-capped and scrubbed, and never sent over the WS by default (D14). |
| **Reducer** | The pure `reduce(world, event, thresholds)` in `packages/shared`. Time enters only through `clock.tick` events (D15). |
| **World state** | Everything the reducer produces: all agents' state plus usage totals. The server holds the authoritative copy; clients replay the same reducer. |
| **Usage** | Token counts and **API-equivalent** cost (`≈ $`) reported by the CLI's telemetry (D25). Never a bill, and never computed from a price table. |

## Credentials

| Term | Who holds it | What it's valid for |
|---|---|---|
| **Bootstrap code** | The launched browser, briefly, in a URL fragment | One `POST /api/session` exchange, within 60 s, once (ADR 0026) |
| **UI session cookie** | The browser (`HttpOnly`, `SameSite=Strict`) | The WS and control routes, with Origin and Host checks |
| **Hook token** | One agent session's environment (every subprocess can read it) | That session's `POST /hooks` and `POST /otel/*` **only**, never WS or control (D13, hard rule 4) |

There is no longer a "UI token" in pages or frames. That design was replaced by ADR 0026.

## Process and harness

| Term | Meaning |
|---|---|
| **Task** | A PLAN checkbox like `2.7`, roughly one PR. Done means: for code, its tests written by the test writer and locked before the implementation (ADR 0028); the check and the test lock green; an independent adversarial review (plus a security pass where due); the checkbox ticked; and any eval cases due with it added. |
| **Phase gate** | Extra criteria before a phase counts as complete: harness evals with 3 trials, a baseline row, no overdue eval rules (PLAN §14). |
| **Harness** | Everything that shapes how AI agents work on this repo: CLAUDE.md files, `.claude/` (settings, hooks, agents, skills) and `evals/harness/`. See [dev-harness.md](dev-harness.md). |
| **Rule ID** | A reviewer finding category, like `HR4-hook-token-scope` or `SEC-terminal-escape`, from `.claude/agents/reviewer.md`. |
| **Planted case / clean case** | A reviewer eval diff with deliberate violations it must find, or one with none, where it must stay quiet. |
| **Due rule** | A rule ID in `uncovered.json` scheduled for a task. That task's PR must add a planted case for it. |
