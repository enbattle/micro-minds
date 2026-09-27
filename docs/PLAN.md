# micro-minds — Build Plan

> Status: v2 · 2026-09-26 (v1 was the "AgentHQ" brainstorm; changes from v1 are listed in §15)
> Claude Code treats this file as the source of truth for scope and order of work.

---

## 1. What we are building

A local, single-user app that turns AI coding sessions (Claude Code first, then Gemini CLI and Codex CLI) into characters in a 2.5D/3D scene. A status board shows what every agent and subagent is doing.

Core experience:

- **Start sessions from the UI.** Click "New agent", pick a provider and a repo, and a character walks to a desk. A real CLI session starts behind it.
- **Prompt from the UI.** Each character has a terminal panel inside the app. You type there. It is the real CLI, so nothing is lost.
- **See everything at a glance.** The board lists every agent and subagent with its current activity, health, and time since its last event.
- **Attention signals:**
  - A raised hand means the agent is waiting for a permission decision.
  - A **?** bubble means the agent asked you a question or is idle waiting for input.
  - Red means a real problem (see §6). A single failed tool call is not a problem.
- **Subagents are characters too.** They spawn next to their parent, work, and leave when done.

### Non-goals (for now)

- Multi-user, hosted or remote access. The app is localhost only.
- Proxying, storing or reading provider credentials in any form.
- A custom chat UI that replaces the terminal (Phase 7, optional).
- Agents delegating to other providers' agents (Phase 9, experimental).

---

## 2. Key decisions (with rationale)

| # | Decision | Why | Revisit when |
|---|---|---|---|
| D1 | **Embedded real terminals** (node-pty + xterm.js) are where the user types prompts | Full CLI behavior with no chat UI to build. The most stable footing for subscription use: the official CLI, used interactively, on the user's own machine. | Phase 7 |
| D2 | **Hooks are the structured event channel** | Terminal output can't be parsed reliably. Hooks give typed lifecycle events. | Never. Adapters may add other sources. |
| D3 | **Local web app** (Node server + browser at `127.0.0.1`) | `git clone && npm install && npm run dev`. TypeScript only. Easy to wrap in Electron later. | Phase 8 |
| D4 | **The app never touches credentials** | Provider terms forbid third-party apps from intermediating subscription credentials. Users log in to each CLI themselves. | Never |
| D5 | **One git worktree per session, stored outside the repo** | Parallel agents in one tree overwrite each other. Worktrees nested in the repo break the parent repo's tooling and CLAUDE.md discovery (see D12). | Never |
| D6 | **Three.js via React Three Fiber, orthographic camera by default** | Isometric orthographic gives 2.5D. A perspective toggle gives 3D with the same scene. | Phase 4a |
| D7 | **Placeholder characters first** | Asset work must not block the state machine and UX. | Phase 4b |
| D8 | **The board is primary; the scene is a skin** | The app must stay useful with the scene hidden. | — |
| D9 | **Hooks fail open** | If the server is down, agents behave exactly as if the app did not exist. | Phase 6 (opt-in blocking permission hook, own ADR) |
| D10 | **Claude-first MVP; multi-provider by design** | Only Claude is installed and it has the richest hooks. Gemini and Codex come in Phase 5. The `ProviderAdapter` interface, provider registry and conformance test suite exist from Phase 2, so adding a provider only means adding an adapter. | Phase 5 |
| D11 | **Windows is first-class from Phase 0** | It's the primary dev machine. ConPTY, `.cmd` shims, path separators and quoting are handled from the start, not in a later pass. CI covers Windows, macOS and Linux. | Never |
| D12 | **Worktrees live at `~/.micro-minds/worktrees/<repo-slug>/<sessionId>`** | Keeps the parent repo's Vite, Vitest, tsc and Biome globs clean. Stops Claude Code loading the parent repo's CLAUDE.md twice when it walks up the directory tree. | — |
| D13 | **Two token classes: UI token vs per-session hook token** | The hook token is visible to the agent and to every subprocess it runs (it's in the environment). If that token also opened the WebSocket, one prompt-injected agent could type into other agents' terminals. Hook tokens are scoped to `POST /hooks` for a single session. | Never |
| D14 | **`raw` payloads are bounded and redacted** | Hook payloads can contain full file contents (for example `tool_response` after reading `.env`). Store a truncated, scrubbed `raw`. Keep it in full only for `unknown` events or in debug mode. Never send it over the WebSocket unless the client asks for it. | — |
| D15 | **Time enters the reducer only as events** | The server emits synthetic `clock.tick` events, so `reduce()` stays pure and replaying fixtures is deterministic, including staleness and health decay. | — |
| D16 | **Terminal scrollback is kept by a headless xterm on the server** | `@xterm/headless` + the serialize addon repaints a reconnecting client correctly. Replaying raw bytes breaks on partial escape sequences and alt-screen TUIs. | — |
| D17 | **Biome for lint and format, `tsc --noEmit` for types** | One fast tool, easy to call from a formatter hook. Add typescript-eslint later only if Biome misses a rule we need (for example floating promises). | Phase 2 review |
| D18 | **npm workspaces** (not pnpm) | Simplicity: no extra tool to install. npm doesn't stop a package importing a dependency it never declared, so Biome's `noUndeclaredDependencies` rule, a committed lockfile, `npm ci` in CI and `engine-strict` cover that gap. | If install or hoisting problems appear |
| D19 | **The app watches orchestration; it doesn't drive it** | Claude Code already routes subagent questions through the parent session. micro-minds visualizes that (hands on the right character, child→parent lines). Orchestrator behavior is steered with CLAUDE.md or agent prompts, not app code. Any routing done by the app is Phase 6/9. | Phase 9 |
| D20 | **Lightweight resume is in the MVP** | Server restarts (including `npm run dev` watch restarts) kill every PTY. Capture Claude's `session_id` from the `SessionStart` hook payload (never from `~/.claude`) and relaunch with `claude --resume <id>` in the same worktree. | If a separate PTY-owning process is needed (agents outliving the server) |
| D21 | **Graceful shutdown with a warning** | Stopping the server with live agents asks for confirmation, then interrupts each CLI, waits a grace period, and kills the process tree. Worktrees are kept and sessions stay resumable. Nothing is deleted automatically. | — |
| D22 | **Mood is derived and pure** | `mood(agent)` is a pure selector in `packages/shared`, fully tested. The scene only renders it. Working and idle are always visibly different. | Phase 4b |
| D23 | **Node runs TypeScript directly (native type stripping); only the web app has a build step** | Node 24 strips types natively, so there is no `tsc` emit, `tsx` or build output for server, shared or relay code. This requires `erasableSyntaxOnly` (no enums or namespaces) and `.ts` import extensions. `tsc --noEmit` (TypeScript 7) is used for type checking only. | If a published package ever needs emitted JS |
| D24 | **The dev-harness guard exempts Claude Code working files under `~/.claude`** | Plan mode, auto-memory and large tool outputs live in `~/.claude/plans/` and `~/.claude/projects/<slug>/{memory,tool-results}/`; blocking them broke those features without protecting any secret. Only literal paths qualify; credentials, settings and transcripts stay blocked. It applies to the dev harness only, never app code. See `docs/dev-harness.md`. | When Claude Code moves these directories |

Each decision gets a short ADR in `docs/decisions/NNNN-title.md`. Record new decisions the same way.

---

## 3. Architecture

```
┌─────────────────────────── Browser (apps/web) ───────────────────────────┐
│  Scene (R3F)      Board (list)      Inbox (hands/?)     Terminal drawer   │
│        ▲               ▲                 ▲                 ▲  │ keystrokes │
│        └──────── zustand store (shared reduce) ◄───────────┘  ▼            │
└────────────────────────────▲──────────────── UI token ─────────────────────┘
                             │ WebSocket (127.0.0.1, Origin + Host checks)
┌────────────────────────────┴───────── Server (apps/server) ────────────────┐
│  SessionManager ── spawns ──► PTY (node-pty/ConPTY) running provider CLI    │
│        │                  env: MICROMINDS_URL, _SESSION_ID, _HOOK_TOKEN     │
│        │                  (hook token: per session, /hooks only)            │
│        │                         └─ CLI fires hooks ─► http hook or relay ─┐│
│  WorktreeManager (~/.micro-minds/worktrees/...)                             ││
│  HookIngest ◄────────────────────────────────────────────── POST /hooks ───┘│
│     └─► ProviderRegistry[p].normalize(raw) ─► AgentEvent ─► EventStore      │
│                                        └─► reduce() ─► WS push              │
│  Clock (emits clock.tick) · Headless xterm per session (scrollback)         │
└────────────────────────────────────────────────────────────────────────────┘
```

### Repo layout (npm workspaces, scope `@micro-minds/*`)

```
micro-minds/
  CLAUDE.md                     ← root rules (short). Each package has its own short CLAUDE.md.
  docs/
    PLAN.md                     ← this file
    decisions/                  ← ADRs
    protocols/claude.md         ← verified facts from the Phase 1 spike, one file per provider
    manual-qa.md
  packages/
    shared/                     ← zod schemas, types, severity rules, pure reduce()
    hook-relay/                 ← fail-open relay (only for providers without native HTTP hooks)
  apps/
    server/                     ← Fastify + ws + node-pty + better-sqlite3
      src/providers/{claude,fake}/   ← gemini/, codex/ in Phase 5
    web/                        ← Vite + React + R3F + drei + zustand + xterm.js
  fixtures/{claude,fake}/*.jsonl
  evals/harness/                ← evals for the AI dev harness (§11.1)
  .claude/                      ← settings, agents, skills, hooks
  .github/workflows/ci.yml
```

### Stack

- **Runtime:** Node 24 LTS, TypeScript (strict), npm workspaces (committed `package-lock.json`, `npm ci` in CI, `engine-strict`).
- **Server:** Fastify, `ws`, `node-pty`, `better-sqlite3`, `zod`, `pino`, `@xterm/headless` + `@xterm/addon-serialize`.
- **Web:** Vite, React, `@react-three/fiber`, `@react-three/drei`, `zustand`, `@xterm/xterm` + `@xterm/addon-fit`.
- **Quality:** Vitest, Playwright, Biome, `tsc`.
- **IDs:** ULIDs, so they sort by time.

> Check current versions of every dependency when you install them. Don't pin from memory.

---

## 4. Core data model (`packages/shared`)

### 4.1 Normalized event

```ts
export type Provider = 'claude' | 'gemini' | 'codex' | 'fake';

export type EventKind =
  | 'session.started' | 'session.ended' | 'session.crashed'
  | 'prompt.submitted'
  | 'turn.finished' | 'turn.failed'
  | 'tool.started' | 'tool.finished' | 'tool.failed'
  | 'attention.permission'   // → hand raised
  | 'attention.question'     // → ? bubble (agent asked the user something)
  | 'attention.idle'         // → ? bubble (waiting for input)
  | 'agent.spawned' | 'agent.finished'   // subagents
  | 'context.compacting'
  | 'clock.tick'             // synthetic, server-only (D15)
  | 'unknown';

export interface AgentEvent {
  id: string;              // ulid
  ts: number;              // ms epoch, stamped by the server on receipt
  sessionId: string;       // OUR session id
  provider: Provider;
  agentId: string;         // = sessionId for the root agent; provider subagent id otherwise
  parentAgentId?: string;
  kind: EventKind;
  tool?: { name: string; category: ToolCategory; useId?: string; summary?: string };
  text?: string;           // short, scrubbed, human-readable line for the board
  errorClass?: 'rate_limit' | 'auth' | 'budget' | 'other';  // set by the adapter from payload facts
  raw?: unknown;           // bounded + redacted (D14); stripped from WS frames by default
}

export type ToolCategory = 'read' | 'write' | 'exec' | 'delegate' | 'ask' | 'web' | 'other';
```

Rules:

- **Adapters set facts (`kind`, `tool.category`, `errorClass`). They never set severity or health.** Severity and health are *derived state*: they depend on history (for example "3 failures in 5 minutes"), so they're computed in the reducer using `severity.ts` rules.
- **Tool categories are the cross-provider contract.** Each adapter maps its own tool names (`Read`, `read_file`, `shell`…) to a `ToolCategory`. The reducer and UI only ever see categories. That keeps adding a provider cheap (D10).
- **Unknown payloads become `kind: 'unknown'` with `raw` kept.** Never throw.

### 4.2 Derived state (pure reducer)

```ts
export type Activity =
  | 'starting' | 'idle' | 'thinking' | 'reading' | 'writing'
  | 'running' | 'delegating' | 'waiting_permission' | 'waiting_input'
  | 'done' | 'offline';

export interface AgentState {
  agentId: string; sessionId: string; parentAgentId?: string;
  provider: Provider; name: string; label?: string;
  activity: Activity;
  attention?: 'permission' | 'question' | 'idle';   // separate channel from health
  health: 'ok' | 'notice' | 'warning' | 'error';
  healthReason?: string;             // "3 tool failures in 5m", "no events for 12m", "rate limited"
  telemetry: 'full' | 'limited';     // limited = terminal-only fallback (§5.4)
  lastEventAt: number;
  currentTool?: { name: string; category: ToolCategory; summary?: string };
  failureTimes: number[];            // for the rolling window
  children: string[];
}

export function reduce(state: WorldState, e: AgentEvent, cfg: Thresholds): WorldState; // PURE
```

The server holds the authoritative state. Clients receive a snapshot, then live events, and run the same `reduce()`. `Thresholds` is one config object (§6).

### 4.3 Event → activity mapping

| Event | Activity | Notes |
|---|---|---|
| `session.started` | `starting` → `idle` | |
| `prompt.submitted` | `thinking` | Clears `attention`. |
| `tool.started` category `read`/`web` | `reading` | |
| `tool.started` `write` | `writing` | |
| `tool.started` `exec` | `running` | |
| `tool.started` `delegate` | `delegating` | The child appears on `agent.spawned`. |
| `tool.finished` / `tool.failed` | `thinking` | Clears `attention.permission`. |
| `attention.permission` | `waiting_permission` | Hand raised. |
| `attention.question` / `attention.idle` | `waiting_input` | ? bubble. |
| `turn.finished` | `idle` | Resets health to `ok` if the latest problem was a tool failure. |
| `agent.finished` | child → `done` | The UI removes the child after about 3 s. That's a UI timer, not reducer state. |
| `session.ended` | `offline` | |
| `clock.tick` | — | Recomputes staleness and failure-window decay. |

### 4.4 Mood (pure selector, D22)

`mood(agent: AgentState): Mood` is computed from activity, health and attention. The first matching row wins, so health outranks activity. Attention (✋ / ❓) is drawn as a separate overlay on top of any mood.

| Mood | Condition | Placeholder visual (4a) |
|---|---|---|
| `distressed` | health `error` (it can't continue on its own) | 😣 + red pulse ring |
| `worried` | health `warning` (repeated failures, possibly stuck) | 😟 + amber ring |
| `frustrated` | health `notice` and working (one tool failure, carrying on) | 😕, still animating |
| `focused` | activity is `thinking`/`reading`/`writing`/`running`/`delegating`, health `ok` | 🙂 + working animation (typing, bobbing, activity icon) |
| `waiting` | activity `waiting_permission`/`waiting_input` | 😐 + ✋ or ❓ overlay |
| `idle` | activity `idle`, health `ok`, no attention (turn done, nothing to do) | 😌 resting, no animation, dimmed activity icon, "idle 4m" on the board |
| `starting` | activity `starting` | walking to the desk |
| `done` / `offline` | subagent finished / session ended or interrupted | fades out / greyed at the desk |

**Working and idle must be distinguishable at a glance, without color:** they differ in animation (moving vs still), icon (activity icon vs none/💤) and board text. `cheer` 🎉 is a short one-off animation on `turn.finished` after a long turn. It's an effect, not a mood.

---

## 5. Provider integration

### 5.1 Getting hook events to the server

In order of preference, per provider:

1. **Native HTTP hook**, if the CLI supports it (Claude Code likely does: `type: "http"`; **verify in Phase 1**). The CLI POSTs straight to `/hooks`, so there's no process spawned per tool call. Mark it async/non-blocking if the CLI supports that.
2. **Relay executable** (`packages/hook-relay`), for providers that can only run a command:
   - Reads the JSON payload from stdin and `MICROMINDS_URL`, `MICROMINDS_SESSION_ID`, `MICROMINDS_HOOK_TOKEN` and `MICROMINDS_PROVIDER` from the environment.
   - POSTs to `/hooks` with a hard timeout of 300–500 ms.
   - **Always exits 0 and writes nothing to stdout.** If the env vars are missing, it exits immediately.
   - Windows: ships a `.cmd` shim. Measure startup cost on Windows specifically, because Node's cold start is slower there.

### 5.2 Injecting hooks without touching global config

Never edit `~/.claude`, `~/.gemini` or `~/.codex`.

| Provider | Mechanism | Status |
|---|---|---|
| Claude Code | Per-session settings file in `~/.micro-minds/sessions/<id>/settings.json`, passed with `claude --settings <file>`. Confirm it **merges** with user and project settings. | **Verify in Phase 1** |
| Gemini CLI | Per-session settings/env | Phase 5 spike |
| Codex CLI | Per-session config/profile/env | Phase 5 spike |

Don't write injected settings into the worktree. If a worktree file turns out to be unavoidable, add it to `.git/info/exclude`.

### 5.3 Claude Code event mapping (confirm against recorded fixtures)

| Claude hook | → AgentEvent |
|---|---|
| `SessionStart` / `SessionEnd` | `session.started` / `session.ended` |
| `UserPromptSubmit` | `prompt.submitted` |
| `PreToolUse` | `tool.started`. `AskUserQuestion` → `attention.question`. `Task`/`Agent` → category `delegate`. |
| `PostToolUse` / `PostToolUseFailure` | `tool.finished` / `tool.failed` |
| `PermissionRequest` | `attention.permission` |
| `Notification` | `attention.permission` or `attention.idle`, depending on type (verify field names) |
| `SubagentStart` / `SubagentStop` | `agent.spawned` / `agent.finished` (`agent_id`, `agent_type`) |
| `Stop` / `StopFailure` | `turn.finished` / `turn.failed` (+ `errorClass`) |
| `PreCompact` | `context.compacting` |

### 5.4 Terminal-only fallback (any provider)

If hooks aren't available, the agent still gets a character, driven by coarse signals:

- **PTY state:** `session.started`, `session.ended`, or `session.crashed` (from a non-zero exit code).
- **Output activity:** output in the last N seconds means `thinking`; quiet means `idle`. Known limitation: spinners count as output.
- The UI shows a "limited telemetry" badge. It never implies visibility it doesn't have.

### 5.5 Session lifecycle

1. **Create.** The user picks a provider, repo path, optional name and optional first prompt.
2. **Worktree.** `git worktree add ~/.micro-minds/worktrees/<repo-slug>/<sessionId> -b micro-minds/<sessionId>`. Refuse if the path isn't a git repo. "Run in place" is open question 3.
3. **Spawn.** node-pty (ConPTY on Windows) with `cwd` set to the worktree, the `MICROMINDS_*` env vars and hook injection. Size the PTY from xterm's dimensions. Resolve the binary through the provider registry, which handles `.cmd`/`.exe` on Windows. Pass the first prompt as a CLI argument if the provider supports it (`claude "<prompt>"`); otherwise pre-fill it (open question 5).
4. **Run.** PTY output goes to the headless xterm and to WS `pty.data` (batched). Input goes to the PTY. Hooks become events.
5. **Stop or kill.** "Stop" is graceful: send Ctrl-C/exit, wait a grace period, then kill the process tree. "Kill" skips the grace period. On Windows the whole tree is killed (`taskkill /T` or the equivalent). Record the exit code and keep the worktree.
6. **Worktree actions.** "Open folder"; "Remove worktree" (a separate confirmed action that warns about a dirty tree and about commits not pushed or merged). Nothing is deleted automatically.
7. **Resume (D20).** Available when the session status is `ended` or `interrupted`, a provider `resumeId` was captured, and the worktree still exists. It relaunches `claude --resume <resumeId>` in the same worktree, under the same micro-minds `sessionId`, with a new hook token. Subagents are not restored. Any raised hand or ? from before is cleared.

Session record (SQLite): `status: 'running' | 'ended' | 'interrupted'`, `endReason: 'exit' | 'user_stop' | 'user_kill' | 'app_shutdown' | 'crash_recovery'`, `exitCode`, `pid`, `resumeId?`, `worktreePath`, `branch`, `cliVersion`.

### 5.6 App lifecycle

**Startup**

1. **One server per data directory.** One server hosts any number of agent sessions; the lock only stops two *servers* from sharing state (DB, worktree registry, crash recovery). The lock is `$MICROMINDS_HOME/server.lock` (pid + port), and `MICROMINDS_HOME` defaults to `~/.micro-minds`. If a live instance holds it, open the browser to that instance and exit. A stale lock (dead pid) is replaced. Separate instances just use a different `MICROMINDS_HOME` and port. `npm run dev` defaults to `~/.micro-minds-dev` on its own port, so developing micro-minds never touches the sessions of the copy you're using day to day. All paths in §5 and §9 that say `~/.micro-minds` mean `$MICROMINDS_HOME`.
2. **Bind** to `127.0.0.1:<port>`, a fixed default overridable by env/flag. If the port is taken by something else, fail with a clear message rather than picking another port.
3. **Database:** run migrations. If the DB is corrupt, move it to `micro-minds.db.corrupt-<ts>`, start fresh, and log a warning.
4. **Crash recovery.** Sessions still marked `running` become `interrupted` (`crash_recovery`). For each recorded pid that's still alive, verify it's really our CLI (by command line, because Windows reuses pids) and offer "kill orphan" in the UI; never kill automatically. Run `git worktree prune` for known repos. Delete stale per-session settings files.
5. **Preflight:** detect installed CLIs (PATH lookup plus `--version`). Login state is never checked by reading credential files.
6. **Open the browser** with the new UI token. An old tab whose token no longer works shows "Server restarted — reload" instead of failing silently.

**While running**

- Closing the browser tab doesn't affect agents. Reopening repaints from the snapshot and `pty.snapshot`.
- **Multiple tabs** share state and can all type. The PTY size follows the most recently focused tab, so they don't fight over resizes.
- **Concurrent session cap:** configurable, default 8, with a warning about plan usage limits.
- **Sleep/wake:** if the gap between `clock.tick`s is well above the interval, the clock emits the gap and the reducer resets staleness baselines, so agents don't all show "stuck" after the laptop wakes.
- A repo or worktree deleted out from under a running session → the agent shows red with a clear reason; the server never crashes.

**Shutdown (D21)**

- Triggers: Ctrl-C/SIGTERM in the server console, or "Quit" in the UI. On Windows, also handle console-close (`SIGHUP`) and Ctrl-Break.
- If agents are running: the UI Quit asks for confirmation; the console prints a warning, and a second Ctrl-C forces the shutdown.
- Sequence: stop accepting new sessions → gracefully stop every session in parallel (grace period, then kill the tree) → mark them `ended/app_shutdown` (resumable) → flush and checkpoint SQLite → delete per-session settings files → release the lock → exit.
- A hard deadline (for example 10 s) guarantees the process exits even if a CLI hangs.

**Dev-mode note:** `npm run dev` restarts the server whenever server code changes, which ends running sessions. Resume makes this survivable. A separate PTY-owning process that lets agents outlive the server is a post-MVP option (see D20).

---

## 6. Severity, health and attention (`packages/shared/src/severity.ts`)

| Condition | Health | UI |
|---|---|---|
| Any single `tool.failed` | `notice` | Small grey mark. **Not red.** |
| ≥3 `tool.failed` in 5 min, or the same tool failing twice in a row | `warning` | Amber |
| `thinking`/`running`/`delegating` and no events for more than 10 min (evaluated on `clock.tick`) | `warning` | Amber, "possibly stuck" |
| `turn.failed`, `session.crashed`, or `errorClass` in {rate_limit, auth, budget} | `error` | **Red** outline and row, plus an inbox entry |

| Attention | UI |
|---|---|
| `permission` | Hand raised, inbox entry, optional chime |
| `question` / `idle` | ? bubble, inbox entry |

Attention is a separate channel from health. Health goes back to `ok` after 5 minutes without new failures (on `clock.tick`) or on the next `turn.finished`. All thresholds live in one exported `Thresholds` object.

---

## 7. UI specification (MVP)

### Layout

```
┌───────────────────────────────────────────────┬──────────────────┐
│              SCENE (R3F)                      │  BOARD           │
│   desks · characters · bubbles · red rings    │  ● claude-1  ✎   │
│                                               │    └ explore  📖 │
│                              [+ New agent]    │  INBOX (2)       │
├───────────────────────────────────────────────┴──────────────────┤
│  TERMINAL DRAWER  [claude-1][claude-2]   (resizable)              │
└───────────────────────────────────────────────────────────────────┘
```

### Interactions

- **Click a character or board row:** select it, open its terminal tab, focus xterm.
- **Click a hand, a ? bubble or an inbox item:** the same, plus scroll the terminal to the bottom.
- **New agent dialog:** providers (installed ones enabled, others shown as "not installed"), repo path (with a recent list), name, optional first prompt.
- **Keyboard:** `Ctrl/Cmd+1..9`, `Ctrl/Cmd+Shift+N` (new agent; `Ctrl+N` is taken by the browser), `Ctrl/Cmd+I` (oldest inbox item). While xterm has focus, only a documented escape chord is intercepted.
- **Hide-scene toggle:** board + terminal must work fully on their own (D8).
- **Board row:** status dot, name, provider, activity icon, current tool summary, relative time, health color, telemetry badge. Subagents are indented.

### Scene (Phase 4a, placeholders)

- An office floor with one desk per session, laid out in a grid.
- **Character:** a capsule colored by provider, plus an activity icon.
- **Subagent:** a smaller capsule at a side desk, with a tether to its parent. It fades out when done.
- **Hand**, **? bubble**, **error** (pulsing red ring plus emissive tint) and **stale** (amber) overlays.
- **Camera:** orthographic isometric with pan and zoom limits, plus a "3D" perspective toggle.
- **Budget:** 60 fps with 10 agents and 20 subagents on a laptop iGPU.

---

## 8. Transport protocol

`ws://127.0.0.1:<port>/ws`. The UI token goes in the first frame (`{t:'auth', token}`) or the `Sec-WebSocket-Protocol` header, not the query string, to keep it out of logs.

```ts
// server → client
{ t: 'snapshot', world: WorldState }
{ t: 'event', event: AgentEvent }               // raw stripped
{ t: 'pty.data', sessionId, data: string }      // batched ~16 ms
{ t: 'pty.exit', sessionId, code: number }
{ t: 'pty.snapshot', sessionId, data: string }  // serialized headless xterm, on (re)connect
{ t: 'error', code: string, message: string }

// client → server
{ t: 'auth', token }
{ t: 'session.create', provider, repoPath, name?, initialPrompt? }
{ t: 'session.kill', sessionId }
{ t: 'pty.input', sessionId, data: string }
{ t: 'pty.resize', sessionId, cols, rows }
```

Every inbound frame is validated with zod (discriminated union on `t`). Oversized frames are rejected.

---

## 9. Security and privacy (non-negotiable)

1. **Bind to `127.0.0.1` only.** Refuse to start otherwise.
2. **Two token classes (D13).** A **UI token**, random per server start and embedded in the served page, is required for the WS and for control HTTP. A **hook token**, random per session, is injected into that session's env and only accepted on `POST /hooks` for that `sessionId`. Compare tokens in constant time.
3. **Check the `Origin` and `Host` headers** on WS and HTTP, to block DNS rebinding and cross-site WS.
4. **No credential access (D4).** Enforced in code *and* in the dev harness (§11.1).
5. **Redaction.** `tool.summary`, `text` and the stored `raw` all go through the scrubber (API-key patterns, bearer tokens, `KEY=value` lines from env-like content, high-entropy strings). `raw` is size-capped (D14).
6. **Hook ingest hardening.** Body-size limit, zod validation, per-session rate limit. Unknown sessions get 404 with no details.
7. **Data location.** `~/.micro-minds/` (DB, worktrees, per-session settings). The README documents how to wipe it.
8. **No telemetry.** The app makes no network calls of its own.
9. **README disclaimer.** Users run the tool with their own accounts and are responsible for their providers' terms.

---

## 10. Phases

Each task is roughly one Claude Code session. **The MVP is Phases 0–4a, Claude + fake provider only.** Anything after 4a gets a scoping pass (complexity estimate plus go/no-go) before it's started.

### Phase 0: Foundations and AI developer harness

**Goal:** a repo where Claude Code can work safely and verifiably from day one, on Windows, macOS and Linux.

- [x] 0.1 Scaffold the npm-workspaces monorepo (`packages/shared`, `packages/hook-relay`, `apps/server`, `apps/web`), with a strict shared tsconfig, Biome and Vitest. Set `engines.node >=24` with `engine-strict=true` in `.npmrc`.
- [x] 0.2 Root scripts: `dev`, `build`, `test`, `lint`, `format`, `typecheck`, `check` (= lint + typecheck + test), `eval:harness` (`e2e` is added with Playwright in task 3.9).
- [x] 0.3 **node-pty smoke test on Windows**: install it and spawn `cmd.exe`/`pwsh` through ConPTY. Record in an ADR whether prebuilt binaries worked or VS Build Tools were needed.
- [x] 0.4 Root `CLAUDE.md` plus a short `CLAUDE.md` in each package (its purity and I/O rules, and its test command).
- [x] 0.5 `.claude/settings.json`: allow `npm run *`, `npm test *`, `npx biome *` and read-only git commands; deny `.env*` reads, provider config dirs, `git push`, `rm -rf`; a `PostToolUse` Biome-format hook on Edit/Write.
- [x] 0.6 `.claude/hooks/guard.ts` (a cross-platform Node script, run with native type stripping): a `PreToolUse` guard that blocks Bash/PowerShell/Read commands touching `~/.claude`, `~/.gemini`, `~/.codex` or `.env*`. It's defense in depth, because deny rules alone don't catch `cat ~/.claude/...`.
- [x] 0.7 `.claude/agents/`: `reviewer` (read-only; checks the diff against CLAUDE.md and §9) and `test-writer` (fixture-driven tests).
- [x] 0.8 `.claude/skills/`: `phase-status`, `new-adapter` (the adapter checklist) and `record-fixture` (the scrub-and-commit workflow).
- [x] 0.9 Harness evals (§11.1): `evals/harness/` with planted-violation diffs and a runner script.
- [ ] 0.10 GitHub Actions: `npm run check` on ubuntu, macos and windows.
- [x] 0.11 ADRs 0001–0023 from §2.

**Done when:** `npm run check` passes locally (Windows) and in CI on all 3 operating systems; Claude Code runs `npm run check` with no prompts; a blocked command is shown to be blocked by both the deny rule and the guard hook; `npm run eval:harness` runs.

### Phase 1: Claude protocol spike (throwaway code allowed)

**Goal:** replace every "verify" for Claude with facts and recorded fixtures.

- [ ] 1.1 A capture sink that appends payloads to `fixtures/claude/<scenario>.jsonl`, fed by an HTTP hook and by the relay.
- [ ] 1.2 Record scenarios: (a) Q&A, (b) read + edit, (c) failing shell command, (d) permission prompt, (e) AskUserQuestion, (f) subagent, (g) Ctrl-C, (h) process killed, (i) compaction if practical.
- [ ] 1.3 Confirm that `--settings` merges with user and project settings, that HTTP hooks work, and whether hooks can be made non-blocking.
- [ ] 1.4 Measure relay latency on Windows (Node vs HTTP hook) and choose one. Write an ADR.
- [ ] 1.5 Spawn Claude in node-pty inside a throwaway worktree on Windows, and check that login, colors, resize and alt-screen render correctly in xterm.js.
- [ ] 1.6 Write `docs/protocols/claude.md` with the confirmed mapping table and the CLI version tested.
- [ ] 1.7 Scrub the fixtures (paths, usernames, secrets) using the `record-fixture` skill.

**Done when:** `docs/protocols/claude.md` is complete; there are at least 8 scrubbed fixture files; every Claude "verify" in §5 is closed or turned into an ADR.

### Phase 2: Server core

**Goal:** a headless server that starts Claude agents in worktrees and produces a correct live world state.

- [ ] 2.1 `packages/shared`: zod schemas, `ToolCategory`, `Thresholds`, `severity.ts`, `reduce()`. **Tests first**, replaying fixtures, including `clock.tick` scenarios.
- [ ] 2.2 The scrubber, with its own test corpus.
- [ ] 2.3 `ProviderAdapter` interface + `ProviderRegistry` (binary resolution, injection strategy, tool-category map), plus a **conformance test suite** that every adapter must pass.
- [ ] 2.4 Claude adapter and fake provider, both passing conformance. The fake provider replays fixtures through `/hooks` and echoes PTY input.
- [ ] 2.5 `WorktreeManager` (create, list, remove with a dirty check, slug rules, Windows paths), tested against a temporary repo.
- [ ] 2.6 `SessionManager` (PTY spawn, env, hook-token issuing, headless xterm, resize, kill, exit) and preflight.
- [ ] 2.7 `HookIngest` + `EventStore` (SQLite, append-only, retention setting) + `Clock`.
- [ ] 2.8 WS server implementing §8.
- [ ] 2.9 Security tests: binding, both token classes, origin/host, hook-token scope (session A's token can't post events for session B and can't open the WS), body limits, redaction.
- [ ] 2.10 (Only if 1.4 chose the relay.) Production `hook-relay` with fail-open tests.
- [ ] 2.11 App lifecycle (§5.6): single-instance lock, crash recovery and orphan detection, graceful shutdown with a hard deadline, sleep/wake gap handling. Integration-test each path with the fake provider.
- [ ] 2.12 Resume (D20): capture `resumeId` from the adapter, relaunch into the same worktree and `sessionId`, and handle the edge cases (worktree gone, no id captured). The fake provider supports a `--resume` flag so this is tested in CI.
- [ ] 2.13 `mood()` selector (§4.4), tests first, including "working vs idle is always distinct".

**Done when:** a scripted test creates a session in a temporary repo using the fake provider and observes `session.started → prompt.submitted → tool.* → turn.finished` on the WS (in CI, and manually with real Claude); every fixture has a replay snapshot test; the conformance suite is green.

### Phase 3: Web MVP (board, terminals, inbox, no scene)

**Goal:** a usable control panel. After this phase you can do real work in micro-minds.

- [ ] 3.1 Vite + React shell; WS client with auth, reconnect, and a snapshot that replaces local state.
- [ ] 3.2 zustand store applying events through the shared `reduce()`.
- [ ] 3.3 Terminal drawer: one xterm per session, tabs, fit + resize, repaint from `pty.snapshot`.
- [ ] 3.4 Board: subagent indentation, activity icons, health colors, relative times, telemetry badge.
- [ ] 3.5 Inbox: attention items, oldest first; clicking jumps to the terminal.
- [ ] 3.6 New Agent dialog with preflight results and recent repos.
- [ ] 3.7 Keyboard shortcuts; optional notification and chime when the tab is hidden.
- [ ] 3.8 Session controls: Stop, Kill, Resume, Remove worktree (confirmed, with dirty/unpushed warnings), Quit app (confirmed when agents are running), "Server restarted — reload" banner, orphan-kill prompt.
- [ ] 3.9 Playwright smoke test with the fake provider, including stop → resume.

**Done when:** you can run 3 Claude agents at once in separate worktrees; every agent's state is on the board; a permission prompt reaches the inbox in under 1 s and one click gets you to it.

### Phase 4a: The world (placeholder scene) ← MVP complete

- [ ] 4a.1 R3F canvas: floor, desk grid, isometric orthographic camera, pan/zoom, hide-scene toggle.
- [ ] 4a.2 Character driven only by `AgentState` + `mood()`: provider color, mood face, activity icon, a distinct working animation vs a still idle pose, walk from the door to the desk.
- [ ] 4a.3 Overlays: hand, ? bubble, red pulse ring, amber stale indicator, limited-telemetry marker.
- [ ] 4a.4 Subagent spawn and despawn at side desks, with a tether.
- [ ] 4a.5 Selection sync between scene, board and terminal, both ways.
- [ ] 4a.6 Perspective camera toggle.
- [ ] 4a.7 A "demo" mode for the fake provider (10 agents, 20 subagents, scripted), plus a performance pass against the budget.

**Done when:** every activity, attention and health state has a distinct visual; it's all verifiable in demo mode; the budget is met.

### Post-MVP (each needs a scoping pass before starting)

| Phase | Scope | Rough complexity |
|---|---|---|
| 4b Art pass | Art direction, CC0 assets (`ASSETS.md`), rigged character with animations, customization, lighting | Medium–High (art-bound, not code-bound) |
| 5 Multi-provider | Install Gemini and Codex; a protocol spike per provider (same as Phase 1); adapters passing conformance; terminal-only verdict where hooks fall short | Medium per provider (the adapter work is small; the spike is the risk) |
| 6 Depth | Usage/limits panel; session history + replay; resume; opt-in blocking permission hook (own ADR, breaks D9); worktree diff/commit/PR | High overall; do the items independently |
| 7 Structured chat mode | Agent SDK / stream-json, Gemini ACP, Codex app-server; chat UI. **Re-check provider terms first.** | High |
| 8 Packaging | Electron shell, tray, native notifications | Medium |
| 9 Orchestration | Cross-provider handoff via an MCP tool exposed by micro-minds (the "town of minds" vision) | High, experimental |

---

## 11. Testing strategy

| Layer | How |
|---|---|
| Reducer, severity, adapters | Vitest replaying `fixtures/*.jsonl`. Every bug fix adds a fixture. |
| Adapter conformance | One shared suite; every provider adapter must pass it. |
| Scrubber | A corpus of known secret shapes plus negatives, to prevent over-redaction. |
| Hook relay (if used) | Exits 0 and prints nothing when the server is down, the token is wrong, or env vars are missing. |
| Server | Integration tests with a temporary git repo and the fake provider; security tests (§9). |
| Web | Component tests for board and inbox; Playwright smoke with the fake provider. |
| Real CLIs | Manual checklist `docs/manual-qa.md`. Never in CI. |

### 11.1 AI developer harness evals

The harness is code, so it gets tested too.

- **Reviewer evals:** `evals/harness/reviewer/*.diff`, each with planted violations (binding to `0.0.0.0`, an adapter setting health, `raw` sent over WS, an unvalidated WS frame, reading `~/.claude`, `any` in shared) plus an `expected.json`. The runner invokes the `reviewer` agent headlessly and scores recall. Run it manually or on demand, not in CI (it costs tokens).
- **Guard evals:** deterministic. Feed the `PreToolUse` guard a table of commands (allowed and blocked, POSIX and PowerShell forms) and assert the decisions. This one runs in CI.
- Re-run the reviewer evals whenever `CLAUDE.md`, `.claude/agents/` or §9 changes.

---

## 12. Risks and mitigations

| Risk | Likelihood | Mitigation |
|---|---|---|
| Hook formats change between CLI versions | High | `unknown` kind, conformance and fixture tests, CLI version recorded in protocol docs |
| node-pty install pain on Windows | Medium | Phase 0.3 smoke test, CI on 3 operating systems, prerequisites documented in the README |
| A prompt-injected agent pivots through the app | Low / high impact | Scoped hook tokens (D13), localhost only, origin checks |
| Sensitive data in stored payloads | Medium | Redaction and caps on `raw` (D14), local-only storage, a wipe command |
| Gemini/Codex hooks too limited | Medium | Terminal-only fallback, deferred to Phase 5 (D10) |
| 3D scope creep delays usefulness | High | Board first (D8), placeholders (D7) |
| Alert fatigue | Medium | §6 rules, one `Thresholds` config, a review after a week of use |
| Parallel agents exhaust plan limits | High | `errorClass` surfaces as red with a clear message |

---

## 13. Open questions (decide during the build; record as ADRs)

1. Visual identity (name decided: micro-minds).
2. Default to 2.5D or 3D? Pick after Phase 4a.
3. Offer "run in place" for non-git folders?
4. Event retention: default 30 days, configurable.
5. First prompt: pass it as a CLI argument (runs immediately) or pre-fill it and wait for Enter? The default is to pre-fill if the provider supports it, otherwise pass it as an argument behind a confirmation.

---

## 14. How to execute this plan with Claude Code

1. **One task at a time.** *"Read docs/PLAN.md and CLAUDE.md. We are on task N.M. Plan first, then implement."*
2. **Tests first** for `packages/shared` and every adapter.
3. **Done** means: `npm run check` green, a `reviewer` pass on the diff, one conventional commit, the task's checkbox ticked.
4. Parallel subagents are fine for tasks that don't depend on each other and don't touch the same files (for example 2.5 WorktreeManager and 2.2 scrubber). Merge their work only after `npm run check`.
5. **Don't skip Phase 1.** Every later phase depends on its fixtures.

---

## 15. Changes from v1

- Renamed AgentHQ → micro-minds (`MICROMINDS_*`, `~/.micro-minds`, `@micro-minds/*`).
- The MVP is Claude-only; Gemini and Codex move to Phase 5, with multi-provider prep kept (D10, tool categories, registry, conformance suite).
- Windows is first-class from Phase 0 (D11, 0.3).
- Worktrees moved outside the repo (D12).
- Split tokens (D13), bounded and redacted `raw` (D14), time as events (D15), headless xterm scrollback (D16), Biome (D17).
- Severity is no longer an event field; health is derived state in the reducer.
- Native HTTP hooks are preferred over the relay (to verify in Phase 1).
- Harness additions: `PreToolUse` guard hook, skills instead of commands, per-package CLAUDE.md files, harness evals.
- Per-task checkboxes; post-MVP phases get complexity estimates and a scoping gate.
- npm workspaces instead of pnpm (D18).
- The app watches native Claude orchestration; routing by the app stays in Phase 6/9 (D19).
- Lightweight resume in the MVP (D20), graceful shutdown (D21), app lifecycle and edge cases (§5.6).
- Mood model with distinct working and idle states (§4.4, D22).
