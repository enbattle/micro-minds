# Threat model

STRIDE threat model for micro-minds, grounded in [PLAN.md](../PLAN.md) (§3, §5, §8, §9, §12),
the hard rules in [CLAUDE.md](../../CLAUDE.md) and the ADRs. It describes the MVP (Phases 0–4a).
Reporting process: [SECURITY.md](../../SECURITY.md).

## How to use this document

- **PR authors and the `reviewer` agent** check any change touching a component below against
  its rows. The reviewer's `HR*` and `SEC-*` rule IDs (`.claude/agents/reviewer.md`) are the
  enforceable subset of this document.
- **Update this file in the same PR** when a component's security behavior changes: a new
  endpoint, frame, token use, file location, addon or git operation. Flip a row's status when
  the test that enforces it lands.
- **Review at every phase gate** (PLAN §14 step 6): re-read the rows for the phase's tasks,
  confirm statuses, and add rows for anything new.

Status legend: `designed` (specified, no code yet) · `planned: task N.M` (the task that builds or
tests it) · `verified: task N.M` (a Phase 1 spike showed the mechanism works; the enforcing code is
still planned) · `enforced by test` (a test exists today) · `gap` (not specified anywhere yet; see
[Open gaps](#open-gaps)).

## Assets

| Asset | Where it lives | Why it matters |
|---|---|---|
| Provider sessions and credentials | `~/.claude`, `~/.gemini`, `~/.codex`, `.env` files | Account takeover, provider terms. The app never touches them (ADR 0004). |
| User's repos and worktrees | Repo paths the user picks; `$MICROMINDS_HOME/worktrees/<slug>/<id>` | Source code, uncommitted work. Loss or tampering is the worst practical outcome. |
| Hook and telemetry payloads | In flight to `/hooks`, `/otel/*`; stored `raw` in SQLite | Can contain file contents and secrets (a `tool_response` after reading `.env`). |
| UI session cookie | Browser cookie jar (`HttpOnly`); bootstrap code briefly in the launch URL | Full control: create sessions, type into every PTY, remove worktrees. |
| Hook tokens | Each session's PTY env only: the settings file's hook headers name the variable (ADR 0029), and the OTLP header is set in the PTY env (ADR 0030) | Post events and usage for one session. |
| Local database and state | `$MICROMINDS_HOME` (`micro-minds.db`, `sessions/<id>/settings.json`, `server.lock`) | Event history, resume ids, scrubbed payloads. |
| User's clipboard and terminal | Browser clipboard, xterm.js, the server console | Clipboard hijack, deceptive output, pasted-command attacks. |

## Adversaries

| Adversary | Capabilities | Not capable of (by assumption) |
|---|---|---|
| **A1 Malicious website** in the user's browser | Requests to `127.0.0.1:<port>`, DNS rebinding, cross-site WebSocket, timing probes | Reading our page or tokens unless Origin/Host checks fail |
| **A2 Prompt-injected agent** inside a PTY | Reads its own env (incl. its hook token), runs subprocesses as the user, makes local HTTP requests, prints arbitrary bytes and escape sequences, sends forged hook payloads | Bypassing the provider CLI's own permission prompts (out of scope) |
| **A3 Other local process or user** | Connects to loopback ports; a different OS user can't read our files if permissions hold | Same-OS-user processes: out of scope (see residual risks) |
| **A4 Malicious dependency** (supply chain) | Code execution at install (`postinstall`) or at runtime in server or browser | Nothing: full compromise if it lands. Mitigated only by hygiene. |
| **A5 Malicious repo** the user opens | Hostile `CLAUDE.md`, `.claude/settings.json` hooks and permissions, hostile file names, git config if it ships a `.git` dir (e.g. from an archive) | Its hooks run in the provider CLI, not in our server, but our injected per-session settings must never widen its power |

## Trust boundaries

```
  A1 website ──✗── Origin/Host check ──┐
                                        ▼
 ┌─ Browser (apps/web) ──────────┐  B1: WS /ws + control HTTP     ┌─ Server (apps/server) ─────┐
 │ board · scene · xterm.js ◄────┼── UI cookie, zod frames ──────►│ SessionManager · WS        │
 │   ▲ B5: PTY bytes rendered    │                                │ HookIngest · EventStore    │
 └───┼───────────────────────────┘                                │ WorktreeManager · Clock    │
     │ pty.data (untrusted)                                       └──▲──────────┬───────┬──────┘
     └───────────────────────────────────────────────────────────────┤          │       │
 ┌─ Agent PTY (provider CLI + subprocesses, UNTRUSTED) ──────────┐   │ B2       │ B3    │ B4
 │ env: MICROMINDS_SESSION_ID, _HOOK_TOKEN, OTEL headers         │───┘ POST     ▼       ▼
 │ cwd: own worktree · may load hostile repo config (A5)         │ /hooks   filesystem  git
 └───────────────────────────────────────────────────────────────┘ /otel/*  $MICROMINDS_HOME,
                                                                  hook tok. worktrees  (argv only)
```

- **B1 browser ⇄ server:** UI session cookie from the one-time bootstrap (ADR 0026), Origin + Host
  allow-list, zod on every frame. Everything the browser sends is authenticated user intent.
- **B2 agent ⇄ server:** hook token, scoped to one session's `POST /hooks` and `POST /otel/*`.
  Everything arriving here is attacker-controllable (A2).
- **B3 server ⇄ filesystem:** only under `$MICROMINDS_HOME`, plus the user-chosen repo path.
- **B4 server ⇄ git:** git runs in user-chosen repos, which may be hostile (A5).
- **B5 terminal output → xterm.js:** raw PTY bytes from A2 reach the user's browser and screen.

## STRIDE by component

S spoofing · T tampering · R repudiation · I information disclosure · D denial of service ·
E elevation of privilege.

### WS endpoint and control HTTP (B1)

| | Threat | Mitigation | Where | Status |
|---|---|---|---|---|
| S | Website opens a cross-site WS or rebinds DNS to reach the server | Bind `127.0.0.1` only; Origin + Host allow-list on every WS and HTTP request | PLAN §9.1, §9.3; HR3 | planned: task 2.9 |
| S | Hook token (readable by A2) used to open the WS | Separate token classes; WS accepts only the UI session cookie (ADR 0026) | ADR 0013; HR4 | planned: task 2.9 |
| S | **Local process (A2/A3) fetches the served page and reads the embedded UI token**, then connects with a forged Origin (non-browser clients set any Origin) | No secret in served HTML. A one-time, 60 s bootstrap code goes to the launched browser in a URL fragment and is exchanged for an `HttpOnly`, `SameSite=Strict` cookie. Residual: the code is briefly visible in the browser-launch command line (single-use; a failed exchange warns the user) | ADR 0026; PLAN §9.2; `HR3-missing-ui-auth`, `SEC-token-exposure` | planned: task 2.9 |
| I | UI credential leaks via query strings, logs, Referer | Bootstrap code only in a URL fragment (never sent in requests or Referer) and stripped at once; session cookie is `HttpOnly`; nothing credential-like is logged | PLAN §8; `SEC-token-exposure` | planned: task 2.8 |
| I | Timing attack on token compare | `crypto.timingSafeEqual` | PLAN §9.2; `SEC-token-compare` | planned: task 2.9 |
| T | Malformed or oversized frames | zod discriminated union on `t`; `maxPayload`; reject unauthenticated frames | PLAN §8; `CONV-unvalidated-boundary` | planned: task 2.8 |
| D | Frame floods, many connections | Frame size limit; bounded per-connection queues | PLAN §8 | designed |
| R | Who typed or removed what is not recorded | Single-user app; destructive actions require `confirm: true` from the UI | PLAN §8, HR11 | designed (accepted) |

### `POST /hooks` and `POST /otel/*` (B2)

| | Threat | Mitigation | Where | Status |
|---|---|---|---|---|
| S | Session A's token posts events or usage for session B | Token checked against the `sessionId` of the request, constant time | ADR 0013, 0025; HR4 | planned: task 2.9 |
| S | Agent forges its own session's events (fake "done", hide a hand) | None possible; the hook token is in its env | ADR 0013 | accepted |
| I | Unknown-session probing, error detail leaks | 404 with no body details | PLAN §9.6 | planned: task 2.9 |
| I | Payload secrets stored or broadcast | Scrub `text`, `tool.summary`, `raw`; cap `raw`; strip `raw` from WS | ADR 0014; HR8; the scrubber: `packages/shared/src/scrub.test.ts`, `scrub.property.test.ts` | scrubber enforced by test (2.2); using it and stripping `raw`: planned: task 2.9 |
| I | Prompts or tool details in telemetry | Exporter prompt and tool-detail logging off; logs exporter off; loopback endpoint only | PLAN §5.7; ADR 0030; `SEC-telemetry-config` | planned: task 2.14 (verified: task 1.8, prompt and response text arrive `<REDACTED>`) |
| I | Account identifiers in telemetry (`user.email`, `user.id`, `organization.id` on every metric point) stored or logged | Ingest reads only value, model, type, query source and agent type; account attributes dropped before storage or logs; no telemetry `raw` | ADR 0030 | planned: task 2.14 |
| T | A user's own settings redirect or break the session's telemetry | Telemetry config in the per-session settings file, which outranks user settings (verified with the generic endpoint variable; inferred for the per-signal one ADR 0030 uses); if a user's own OTLP headers replace ours, the result is 401s, shown as usage unavailable (expected, not recorded) | ADR 0030 | verified: task 1.8 (generic endpoint); designed (per-signal endpoint, headers) |
| I | A user's own collector credentials (their OTLP headers) arrive at `/otel` and are stored or logged | Header values of any request, rejected or not, are never logged or stored; 401 without details | ADR 0030 | planned: task 2.14 |
| S | Session A's hook token is accepted on session B's `/otel` route | The route names the session (`/otel/<sessionId>/v1/metrics`); the token is compared against that session's token only | ADR 0030; HR4 | planned: task 2.14 |
| I | Managed settings set only a metrics endpoint, so the process-env OTLP header sends the session's hook token to that collector | The token only posts to that session's loopback ingest (D13) and dies with the session | ADR 0030 | accepted |
| T | Forged usage inflates cost or totals | Per-session only; usage never affects health; cost labelled `≈` | ADR 0025 | accepted |
| D | Event floods, huge bodies, unbounded metric series | Body limit, zod on used fields only, per-session rate limit, unknown metrics ignored | PLAN §5.7, §9.6 | planned: tasks 2.7, 2.14 |
| E | Crafted payload crashes ingest or reducer | Unknown → `kind: 'unknown'`, never throw; zod at boundary | HR7 | planned: task 2.4 |

### PTY I/O and session manager

| | Threat | Mitigation | Where | Status |
|---|---|---|---|---|
| E | Injection via repo path, name or first prompt in the spawn | Binary from the provider registry; argv arrays, no `shell: true`; zod on `session.create` | `WIN-binary-resolution` | planned: tasks 2.3, 2.6 |
| E | Server writes to a PTY on its own (steering) | Only user `pty.input` reaches a PTY | HR12, ADR 0019 | designed |
| I | Other env vars (the user's secrets) reach the agent | The CLI inherits the user env anyway; we add only `MICROMINDS_*` and OTEL vars | PLAN §5.5 | designed |
| D | Many sessions exhaust CPU, memory or plan limits | Session cap (default 8) | PLAN §5.6 | designed |
| D | Orphaned CLIs after crash; pid reuse on Windows | Verify command line before offering kill; never kill automatically; tree kill | PLAN §5.6; HR11 | planned: task 2.11 |
| T | Headless xterm and browser xterm both answer terminal queries (DSR, DA) | Discard the headless xterm's `onData` replies; only the focused browser answers | ADR 0016 | planned: task 2.6 |

### Terminal rendering in the browser (B5)

Agent output is untrusted (A2, A5): anything the agent reads, including a hostile file, can
end up printed verbatim.

| | Threat | Mitigation | Where | Status |
|---|---|---|---|---|
| T | **OSC 52 clipboard write**: the agent puts a malicious command in the clipboard | Never load a clipboard addon or handler that honors OSC 52 writes | `SEC-terminal-escape` | planned: task 3.3 |
| S | **OSC 8 hyperlink** (or auto-detected link) with deceptive text | Link clicks open only after a confirmation showing the real URL | `SEC-terminal-escape` | planned: task 3.3 |
| S | OSC 0/2 title spoofing (fake tab or window titles) | Don't surface terminal titles in app chrome, or show them as plain text next to the real session name | `SEC-terminal-escape` | planned: task 3.3 |
| T | Report sequences that echo attacker text back as PTY input | Keep xterm.js `windowOptions` reports off (the default) | `SEC-terminal-escape` | planned: task 3.3 |
| D | Output floods and huge scrollback | Batched `pty.data` (~16 ms); bounded scrollback in both xterms | PLAN §8; ADR 0016 | planned: tasks 2.6, 3.3 |

### Board, inbox and scene rendering of agent text

| | Threat | Mitigation | Where | Status |
|---|---|---|---|---|
| E | XSS via `text`, `tool.summary`, agent names, `healthReason` | React escaping only; never `dangerouslySetInnerHTML` for agent text; drei `<Html>` content text-only | `SEC-terminal-escape` | planned: tasks 3.4, 4a.3 |
| I | `raw` shown in the UI | Never render `raw`; not sent over WS by default | HR8; apps/web CLAUDE.md | planned: task 2.9 |
| S | Deceptive text (bidi overrides, fake "approved") | Scrubbed, length-capped single line; UI state from `kind`, never from text | PLAN §4.1 | designed |
| D | Huge or many strings stall the scene | Capped text length; performance budget | PLAN §7 | planned: task 4a.7 |

### Worktree manager (B3, B4)

| | Threat | Mitigation | Where | Status |
|---|---|---|---|---|
| T | Path traversal via repo name, slug or `sessionId` | Slug rules; ULID ids; `path.resolve` then prefix-check under `worktrees/` | ADR 0012; `WIN-path-concat` | planned: task 2.5 |
| T | Symlink or junction tricks make "Remove worktree" delete outside the root | Resolve real paths; require a registered worktree (`git worktree list`); remove via `git worktree remove`, never a recursive delete that follows links | HR11; `SEC-worktree-removal` | planned: task 2.5 |
| T | Removal destroys uncommitted or unpushed work | Explicit confirmed action with dirty and unpushed warnings | PLAN §5.5; HR11 | planned: tasks 2.5, 3.8 |
| E | Hostile repo's git config (`core.fsmonitor`, `core.hooksPath`) runs code when we run `git` | Argv only, `--` before paths, `-c core.fsmonitor=false`, empty hooks path | `SEC-worktree-removal` | planned: task 2.5 |
| E | Our injected settings widen a hostile repo's power | Per-session file holds only hooks and env; no permission allows, no permission-skip flags; outside the worktree | PLAN §5.2; HR2; `spikes/phase-1/SETTINGS.md` | verified: task 1.3 (settings merge with project hooks; the file holds hooks only); planned: task 2.6 |

### Event store and local data (B3)

| | Threat | Mitigation | Where | Status |
|---|---|---|---|---|
| I | Secrets at rest in SQLite | Scrubbed, capped `raw`; retention setting; documented wipe | ADR 0014; PLAN §9.7; the scrubber and cap: `packages/shared/src/scrub.test.ts` | scrubber enforced by test (2.2); storage: planned: task 2.7 |
| I | Hook tokens at rest in `sessions/<id>/settings.json` (readable by other agents) | Prefer env interpolation so the file holds no token; delete on shutdown | PLAN §5.6; `spikes/phase-1/SETTINGS.md` | verified: task 1.3 (the header reads the token only through `allowedEnvVars`); planned: task 2.6 |
| I | Tokens or `raw` in logs; log injection via agent text | Never log tokens or `raw`; pino JSON escapes control characters | HR8; `SEC-token-exposure` | planned: task 2.7 |
| T | Corrupt DB bricks startup | Move aside and start fresh | PLAN §5.6 | planned: task 2.11 |

### Hook relay (only for CLIs without native HTTP hooks)

Task 1.4 chose native HTTP hooks for Claude (ADR 0029), so the relay is unused in the MVP. These
rows apply if Phase 5 registers it for Gemini or Codex.

| | Threat | Mitigation | Where | Status |
|---|---|---|---|---|
| E | Relay output alters the CLI's decision | Exit 0, print nothing to stdout, 300–500 ms timeout | HR5, ADR 0009 | planned: Phase 5, if a CLI needs the relay (D29) |
| I | Changed `MICROMINDS_URL` sends payloads and token off-box | Relay posts only to a loopback URL | HR5 | planned: Phase 5, if a CLI needs the relay (D29) |
| D | Huge stdin payload | Cap bytes read; server body limit | PLAN §9.6 | planned: Phase 5, if a CLI needs the relay (D29) |

### Dev harness (Claude Code working on this repo)

| | Threat | Mitigation | Where | Status |
|---|---|---|---|---|
| I | Claude Code reads provider credentials or `.env` | Deny rules plus `PreToolUse` guard; narrow ADR 0024 exemption | [dev-harness.md](../dev-harness.md) | enforced by test (`evals/harness/guard/guard.test.ts`) |
| E | Prompt injection via fixtures or diffs tempts rule-breaking | Scrubbed fixtures; reviewer pass; red-team evals | PLAN §11.1 | planned: task 2.16 |
| T | Claude weakens or rewrites tests so a broken change passes | Tests written first by a separate `test-writer`, committed with a `Test-lock:` trailer; `scripts/tests-locked.ts` fails on any later test change; independent reviewer re-runs it and checks test config (`TEST-lock`); the user's merge as the boundary (CI doesn't run the lock) | ADR 0028 | enforced by test (`scripts/tests-locked.test.ts`) |
| T | Claude pushes harmful code, or data that should stay local, to GitHub | Pushes only to task and phase branches (no force, no `main`, no merge); `protect-main` and `ci-verify` rulesets; the user merges after review; `/finish-task` refuses untracked or unstaged files; secret scanning with push protection | ADR 0027; `.claude/settings.json` | enforced by test (`evals/harness/integrity/integrity.test.ts`) and rulesets |
| E | Malicious dependency (A4) | Lockfile, `npm ci`, `save-exact`, Dependabot with a 7-day cooldown, SHA-pinned actions, `SEC-network-call` | PLAN D18; `.github/dependabot.yml` | designed |
| I | Dev server exposed on the LAN | Vite dev server bound to `127.0.0.1`, `strictPort` | `apps/web/vite.config.ts` | designed (config, no test) |

## Residual and accepted risks

- **Same-OS-user processes are trusted.** Anything running as the user, including an agent's
  subprocesses, can read `$MICROMINDS_HOME`, other worktrees, process memory and environment.
  D13 stops the cheapest pivot (reuse of an env token), not a determined local attacker.
  OS-level sandboxing is the provider CLI's job.
- **A malicious agent can forge its own session's events and usage** (ADR 0013). The board
  shows what the agent reports; the terminal stays the ground truth.
- **Scrubbing is heuristic** (ADR 0014): novel secret shapes can slip through to the local DB.
  Known gaps, left open so ordinary text survives (task 2.2 reviews): hex-only keys (they look like
  git hashes), random tokens under 40 characters with no known prefix, single-case letter-only
  tokens, and secrets in YAML or JSON colon forms, `-p<pw>` / `-u user:pw` flags, cookies and
  custom headers. Also (unit 2.2-fix): in a spaced or indented assignment, a value that is a
  language literal or an all-lower-case dotted name (`hunter.two`) is taken for code; a key counts
  as secret-named only by whole words (a bare `key` or `primaryKey` doesn't, `API_KEY` does); and
  a single-case run joined from short `-`/`_` parts is taken for a name. Task 2.9's body limit
  bounds the scrubber's cost (about 0.6 s per MB at worst); an input past the regex engine's limits
  is replaced whole by the marker rather than passed through.
- **Hooks fail open** (ADR 0009): lost events can briefly show a wrong state; never a wrong action.
- **Opening a repo means trusting it** for git and for the CLI's own config loading, as if the
  user ran the CLI there by hand. We only promise not to widen that trust.
- **Supply chain**: a compromised dependency has full user privileges. Hygiene reduces, but
  does not remove, this risk.

## Open gaps

None right now. The six gaps found in the first pass (2026-09-27) each became an ADR or a
PLAN acceptance item: UI authentication (ADR 0026, task 2.9), hook tokens kept out of settings
files (1.3), safe worktree removal and git hardening (2.5), headless xterm query replies (2.6),
and a loopback-only relay (Phase 5, only if a CLI needs it; D29). New gaps go here with a `gap` status in the tables above.
