# Claude Code multi-agent event capture — build plan

## What this project is

A local, open-source tool that captures everything Claude Code exposes about a
multi-agent delegation session (a manager session spawning subagents, tool
calls, permission requests, completions, failures) into a structured,
queryable event log — with a minimal UI to prove the data is complete and
useful, and eventually a 2D interactive scene once that data is proven
sufficient. **Phases 1–4 are explicitly not about visuals.** Phase 5 (the
interactive 2D layer) is designed in this document so the schema doesn't have
to be redesigned to support it, but is not built until Phase 4's definition of
done is met. Do not start on rendering, character design, or animation work
before then.

**Primary audience: you, using this daily against your own real Claude Code
work. Secondary: it's open-source on GitHub, so anyone can clone it, and it
should hold up to that.** This isn't a personal script held to a lower bar
because the audience is small — it's held to a high bar because it captures
real source code and real prompts on your own machine every day, and because
a repo that's genuinely well-built is worth building well regardless of who
else ever reads it. Concretely, that means: storage/network/logging decisions
get the same care they'd get if a stranger cloned it tomorrow (because one
might), and the repo itself should be a _good place for an AI agent to work_
— clear conventions, fast feedback loops, decisions explained in writing —
since you'll be using Claude Code to build and extend this, not just to be
observed by it. Phase 0 below sets both of these up before any capture logic
is written.

## Non-negotiable architecture principles

Follow these even where they cost extra effort — they are the actual point of
the project, not implementation detail:

1. **Total decoupling of capture from presentation.** The daemon and its event
   schema must not know that a UI, let alone a game, will ever consume them.
   Any UI is a read-only client of the same API a third party could build
   against.
2. **The software in this repo — hook scripts, daemon, UI, MCP server —
   never originates a network call beyond localhost, full stop.** This is a
   claim about what _we_ build, not a claim that the overall system is
   airgapped: Claude Code itself inherently talks to Anthropic's API to
   function at all, and may hit the web via `WebSearch`/`WebFetch` — that's
   true, unavoidable, and outside anything this project touches or is
   responsible for. What stays entirely within our control is that nothing
   we write re-sends, phones home, or independently transmits any of the
   data it captures — no telemetry, no external analytics, no automatic
   summarization-via-API, nothing. The distinction matters because Claude
   Code's own network use is a transaction the user already consented to by
   using it; this tool taking already-captured, possibly cross-session data
   and sending it elsewhere on its own would be a new, additional data flow
   nobody agreed to just by using Claude Code. The data captured here
   includes real source code and prompts — treat that as sensitive by
   default, precisely because this boundary is what's actually being
   protected.
3. **The event schema is the real deliverable.** Version it, document it as a
   standalone JSON Schema file in the repo, and treat changes to it as
   breaking changes requiring a version bump.
4. **Fail open, except where explicitly designed to block.** A hook script
   that can't reach the daemon must never prevent Claude Code from working
   normally, with one deliberate exception: the human-in-the-loop hook in
   Phase 3, whose entire job is to block.
5. **One language, end to end.** Node.js + TypeScript for hook scripts, the
   daemon, and any future UI. This is an open-source tool other people will
   run locally — minimizing the toolchain they need to install matters more
   than picking the "best" language per component.
6. **Distribution is GitHub-clone-only for now — do not publish to npm.**
   The install path is `git clone` → `npm install` → `npm link` (or running
   the CLI directly via `node dist/cli.js` from the checked-out repo). No
   npm registry account, no `npm publish`, no public package listing. This
   is a deliberate deferral, not an oversight — publishing brings semver
   obligations and public-issue triage that don't make sense before the
   daemon and HITL flow are even proven. Revisit publishing only after
   Phase 4 is validated, as a separate, later decision.
7. **The schema and daemon must not bake in "Claude Code" as the only
   possible agent source.** The long-term intent is for characters to be
   backed by Claude Code, Gemini CLI, or GPT-based coding agent sessions
   interchangeably. Do not build adapters for Gemini or GPT in this pass —
   their hook/observability surfaces are unresearched and may not even
   support an equivalent capture mechanism. What you must do now, because it
   is cheap now and expensive to retrofit, is avoid naming or structuring
   things in a way that assumes Claude Code implicitly: include an explicit
   `provider` (or `agent_runtime`) field on every event from Phase 1 onward,
   keep the hook-capture script conceptually separate as "the Claude Code
   adapter" rather than as if it were the only possible source of events,
   and keep provider-specific parsing logic (payload normalization) isolated
   from the provider-agnostic daemon/storage/schema code. If a design choice
   would require a rewrite to add a second provider later, flag it rather
   than silently choosing the Claude-Code-only version.

   Make this concrete with a real interface, not just a naming convention:
   define a `ProviderAdapter` contract (roughly
   `normalize(hookEventName: string, rawPayload: unknown): CanonicalEvent`)
   that any provider adapter must implement, and structure the repo so the
   boundary is enforced by the folder layout, not just by convention:

   ```
   /adapters/claude-code/   -- hook scripts + normalizer implementing ProviderAdapter
   /adapters/<future>/      -- e.g. gemini-cli, added later, same interface
   /schema/                 -- the JSON Schema, the actual contract
   /daemon/                 -- provider-agnostic: only ever sees CanonicalEvent,
                             -- never imports anything from /adapters
   ```

   The daemon's `POST /events` accepts only the canonical shape. Adding a
   second provider later — once its hook/observability surface is actually
   researched — means writing a new adapter package that implements the same
   contract and POSTs to the same endpoint. No daemon or schema change should
   be required unless research reveals something a provider exposes that the
   canonical schema genuinely can't represent, in which case that's a real
   schema version bump (principle 3), not a workaround.

8. **The daemon binds to `127.0.0.1` only — never `0.0.0.0` or any other
   interface.** This is not a configurable default, it's a hard requirement.
   The entire value of this tool is capturing real source code and real
   prompts; a daemon that accidentally listens on all interfaces makes that
   data reachable from anything else on the same network. Write a test that
   asserts the bind address, not just documentation that says so.
9. **Localhost binding is a network-boundary claim, not an access-control
   one — the daemon also needs application-layer auth.** Binding to
   `127.0.0.1` stops another machine from reaching it; it does not stop
   another local process on the same machine, and specifically does not stop
   a malicious web page open in a browser on that machine — a page can issue
   requests to `localhost` ports, and "it's only on localhost" is a
   well-known, real category of vulnerability for local dev tools, not a
   hypothetical. Given this daemon serves real captured source code and
   prompts on `GET /sessions/:id/events`, require a shared-secret token on
   every request: generate one at daemon startup (or install time), write it
   to a file with restrictive permissions (`0600`), and have every consumer
   this repo builds (hook scripts, the UI, the MCP server, the `doctor`
   command) read and send it. This is cheap to build and closes a real gap
   that binding alone leaves open.
10. **Every consumer discovers the daemon's address and token the same way —
    this is a structural decision, not a detail to leave implicit.** Nothing
    in this repo should hardcode a port. Decide one shared discovery
    mechanism early (a small local state/config file the daemon writes on
    startup, in a fixed, documented location, is the simplest option — an
    env var can override it) and have hook scripts, the UI, the MCP server,
    and the `doctor` command all read from that same place. The specific
    port number doesn't matter and can be picked freely; the existence of
    one shared discovery path does — getting this wrong means touching every
    consumer later to add configurability that should have existed from the
    first hook script.
11. **Validate incoming events against the JSON Schema at the API boundary.**
    `POST /events` rejects anything that doesn't conform rather than storing
    it anyway. Principle 3 calls the schema "the real deliverable" — this is
    what makes that actually true instead of aspirational; a schema nothing
    enforces is just a comment.
12. **Captured content is data, never instructions.** This daemon stores
    arbitrary tool outputs, file contents, and prompts verbatim — some of
    which may contain text an attacker (or an over-helpful web page) crafted
    to look like an instruction. If any current or future feature (a
    summarizer, an LLM-based classifier if identity inference is ever
    revisited) reads captured content back into a model, that content must be
    treated strictly as untrusted data to reason about, never as a directive
    to follow.
13. **Storage has a documented lifecycle, not just a write path — and it's a
    tiered one, not just "keep everything or prune everything."** SQLite and
    JSONL both grow unbounded with real, sensitive data and no cleanup story
    currently exists. Full-fidelity data (the raw event log) is the source
    of truth and stays the default — this project's whole value depends on
    faithful replay, so a summary-only design isn't an option. What's
    provided is: a `prune`/`gc` command (or explicit documentation of where
    data lives and how to clear it) for the raw log, a cheap non-LLM
    per-session summary record (see Phase 4) that's what browsing/history
    actually reads instead of full transcripts, and an explicit "pin" action
    a user can apply to a specific session to exempt it from pruning. Don't
    let a user discover unbounded growth of their own captured source code
    by accident, and don't let an automatic retention policy silently delete
    the one session they actually wanted to keep.
14. **Logs are not a second copy of the sensitive data.** Default log output
    must not include `raw_payload` or other captured content — that's a
    second, typically less-protected copy of the same real prompts and code
    principle 2 already treats as sensitive by default. Gate anything that
    detailed behind an explicit verbose/debug flag.
15. **Schema versioning is concrete, not just a promise to "bump it."** Add a
    `schema_version` field to the canonical event shape and maintain a
    `/schema/CHANGELOG.md`. Principle 3 already says schema changes are
    breaking changes — this is what lets a third party (or your own Phase 5
    UI) actually detect and handle a version they weren't built against,
    instead of silently misreading old or new data.
16. **Identity-inference output (Phase 2) is always a derived value, never a
    stored fact.** "Is this session the manager or a worker" is computed by
    the daemon from raw signals (parent/child relationship, declared name)
    at query time, or cached as a session-level derived field the daemon
    can recompute — it is not written into the immutable Phase 1 event log
    itself. This keeps the raw event log a faithful, untouched record and
    means an improved inference rule later doesn't require rewriting
    history, consistent with Phase 5 treating the root session as "just the
    node with no parent" rather than a special stored concept.

## Development workflow for building this project

This project handles real source code, real prompts, and a mechanism
(Phase 3) that's designed to actually block a running agent — both are the
kind of thing worth a heavier review process than "write code, glance at it,
move on." Use a formal, role-separated pipeline for each phase's work rather
than one continuous session writing and reviewing its own code:

1. **Spec, locked before implementation.** Each phase's section in this
   document is the spec. Before implementation starts on a phase, its
   Definition of Done should be turned into concrete, checkable test cases —
   written and committed, confirmed to fail for the right reason (not "file
   not found"), before any implementation code exists. Implementation is not
   allowed to weaken or edit these tests to make them pass; if a locked test
   looks wrong once implementation is underway, that's a spec problem —
   escalate it and fix the spec, don't quietly patch the test.
2. **Separate roles per phase, run in fresh sessions.** A test-writer session
   writes the phase's tests from the spec alone, with no visibility into how
   it'll be implemented — this is what keeps the tests honest to the spec
   rather than to whatever the implementation turns out to do. A separate
   implementer session writes the phase's code against the locked tests and
   never edits them. A separate reviewer session — fresh context, given only
   the diff, the spec, and the tests, never the implementer's own reasoning
   or conversation — reviews adversarially: its job is to construct failure
   cases, not confirm the diff looks reasonable. In this codebase, the
   `/code-review` skill run in a fresh context is the concrete mechanism for
   this reviewer role.
3. **Cap rejection rounds, then escalate to a human.** Two rejection rounds
   from the reviewer on the same phase, then stop and bring it to Steven
   rather than continuing to loop the implementer against reviewer feedback
   indefinitely.
4. **Every loop in the system itself needs a budget and an exit, not just the
   human workflow around it.** This applies concretely to Phase 3's
   answer-polling loop: a hard maximum wait tied to the configured hook
   timeout, and an explicit, logged escalation path on timeout — never a
   silent retry-forever.
5. **Artifacts carry state across sessions, not conversations.** Anything a
   later role/session needs (the spec, the locked tests, the diff, review
   findings) should be a file in the repo, not something only visible in a
   prior chat transcript — this is what makes the role separation in point 2
   actually possible to run in genuinely fresh sessions. Concretely: each
   phase's locked spec lives at `docs/specs/phase-N-<name>.md`, written before
   that phase's implementation starts — this mirrors a working pattern from a
   sibling project (`til`'s `docs/specs/`), not an invented convention. This
   document (the overall plan) stays the index; `docs/specs/` holds the
   per-phase detail once a phase is actually underway, so this file doesn't
   grow into the "read everything" context dump it would otherwise become
   phase by phase.
6. **Every phase review nominates at least one removal, not just approvals.**
   A workspace that only accretes files, principles, and code is decaying in
   slow motion even while every individual change looks fine. The reviewer
   role in point 2 should name at least one thing that could be simplified or
   deleted, each phase — including in this plan document itself once
   implementation reveals a step here was unnecessary.

## Tech stack for this pass

- **Runtime:** Node.js + TypeScript throughout
- **Daemon framework:** Fastify or Express (your choice — pick one and be consistent)
- **Storage:** SQLite via `better-sqlite3` (embedded, zero setup for end users), plus a raw append-only JSONL file per session as a durability backstop independent of the database
- **Realtime transport:** `ws` for WebSocket broadcast to connected clients
- **Packaging:** structure the CLI as a normal npm-installable package from
  the start (proper `package.json` with a `bin` field, no assumptions baked
  in about being run from a specific relative path) even though the only
  supported install path right now is cloning the repo and running
  `npm link` locally. This costs nothing extra today and means that _if_
  the project is ever published to npm, it's a registry action later, not
  an engineering rewrite. Do not add any `npm publish` step, CI publish
  workflow, or registry-account setup in this pass.
- **Hook scripts:** plain Node scripts, no framework — they must start and
  exit fast. Shape every hook script the same way regardless of which event
  it handles: read stdin, try/catch around all real logic, and always
  `process.exit(0)` on the non-blocking ones (see architecture principle 4) —
  never let an unhandled exception be the thing that blocks Claude Code.
- **CI mirrors self-check exactly.** Whatever commands a Claude Code session
  is told to run before considering a phase done (typecheck, lint, test,
  build) should be the literal commands wired into `package.json` scripts
  and into the GitHub Actions workflow — no gap between what's self-checked
  and what's enforced. Use least-privilege CI permissions
  (`contents: read` unless a job genuinely needs more).
- **Automated dependency updates:** a `.github/dependabot.yml` for the `npm`
  and `github-actions` ecosystems, weekly, grouping minor/patch updates
  together — taken directly from `til`'s working config rather than
  reinvented.

---

## Phase 0 — Repository scaffolding and AI-developer-experience setup

**Goal:** set up everything a well-run repository needs _before_ any capture
logic exists — both the hygiene a stranger cloning it would expect, and the
conventions that make this a genuinely good repo for a coding agent (Claude
Code, and you working through it) to build the rest of this in. This phase
is almost entirely non-negotiable process/config, not capture logic — it
should be fast.

- `LICENSE` — MIT, matching both sibling projects in this workspace
  (`cortex-workspace`, `til`), same author. Change only if you have a
  specific reason to diverge from your own established precedent.
- `SECURITY.md` — a vulnerability-reporting path, and an explicit,
  plainly-worded statement of what this tool captures (real source code,
  real prompts, tool outputs) and where it lives on disk by default. This
  matters most for _you_, running this daily against your own real work —
  it's not written for a hypothetical stranger, it's the thing you'd want to
  be able to point to and trust yourself.
- `CONTRIBUTING.md` — the "Development workflow for building this project"
  section above, written down once rather than re-explained every session:
  the spec-lock step, the fresh-context role separation, the
  two-rejection-round cap, where `docs/specs/` fits in. You're the primary
  reader of this file for now — it exists so the workflow doesn't quietly
  drift session to session, and it's ready if anyone else ever clones this.
- **`docs/decisions/` — a short architecture decision record (ADR) per
  genuinely non-obvious choice**, numbered (`0001-subagents-not-agent-
teams.md`, etc.), each just: the decision, the alternatives considered, and
  why — a few paragraphs, not a template-heavy document. This is the single
  highest-value thing for making the project's judgment legible to someone
  reading the code cold (including future-you), instead of the reasoning
  living only in this planning doc or a chat history nobody else can see.
  Write the first batch now, retroactively, for decisions this plan has
  already made: subagents over agent teams, SQLite+JSONL over a single
  store, 2D over 3D for Phase 5, GitHub-clone-only distribution, the
  provider-adapter boundary, and the daemon's discovery mechanism plus
  shared-secret auth (principles 9-10) — write the actual port number and
  discovery-file location you land on into this one, since it's the concrete
  decision every later phase's code depends on agreeing to. These are all
  genuinely settled — none of them hinge on Phase 1's open empirical
  questions (payload shapes, `task_id`, `TaskCreated` timing), so write them
  as accepted, not provisional. Give
  every ADR a status line (`Accepted` / `Provisional — pending Phase N
finding`), though, and use `Provisional` for any future one whose reasoning
  actually does depend on an unresolved open question — the point is to
  never let a decision record look more settled than it is. Add a new one
  whenever a future decision would otherwise only be explained in a commit
  message or, worse, not explained at all.
- `CLAUDE.md` at the repo root — short, a router, not a dump, but not empty
  either. It needs three things to actually make this a good repo for an
  agent to work in: (1) pointers — to this plan, `docs/specs/`, and
  `docs/decisions/`, so an agent starting cold knows where to look rather
  than guessing or re-deriving; (2) the exact self-check commands to run
  before considering any task done (typecheck/lint/test/build — the same
  ones wired into CI, see the tech-stack note on that); (3) the two or three
  things that are _not_ obvious from the code and that this plan already
  flags as easy to get wrong here specifically — e.g. "never assume a hook
  payload shape, check `fixtures/` or capture a real one," "the daemon must
  bind to 127.0.0.1 only," and "every request to the daemon needs the
  shared-secret token — see `docs/decisions/000N-daemon-discovery-and-
auth.md` for where it lives and how it's read." Keep it short enough that
  it's actually read in full every session — a large file here defeats its
  own purpose, since instruction-following degrades as the context an agent
  has to hold grows.
- `docs/specs/README.md` — a one-paragraph explanation of the convention
  (one locked spec file per phase, written before that phase's
  implementation begins), mirroring `til`'s working pattern.
- `.github/dependabot.yml` — as specified in the tech stack section above.
- `README.md` — the actual install instructions (`git clone` →
  `npm install` → `npm link`, no `npx package-name` anywhere — see Phase 1's
  README note below) plus the one-paragraph "what this is and what it is
  not" framing from the top of this document.
- A CI workflow skeleton (`.github/workflows/ci.yml`) wired to run whatever
  `package.json` scripts exist at this point (even if that's just
  typecheck/lint on an empty project) — so CI exists and is green from the
  start, and each later phase only ever adds to it rather than bootstrapping
  it from nothing under time pressure.

**Definition of done:** a fresh clone of the repo, with zero capture logic
yet, already reads like a well-run project — `SECURITY.md`, `CONTRIBUTING.md`,
and `docs/decisions/` explain what the tool does with data and why its key
choices were made, `CLAUDE.md` is short enough to read in full and gives an
agent everything it needs to start working, and CI is green.

---

## Phase 1 — Event schema and hook capture

**Goal:** every relevant Claude Code hook event is captured, normalized, and
durably written somewhere, with nothing else built on top yet.

- Define a canonical internal event shape (session_id, parent_session_id if
  any, `task_id` — see below, `provider` — e.g. `"claude-code"`, reserved for
  future values like `"gemini-cli"` or `"codex"` — event_type, timestamp,
  raw_payload, and any fields you extract from raw_payload). Write this as a
  JSON Schema file in the repo — this is the contract everything else depends
  on. Only `"claude-code"` is implemented in this pass; the field exists so
  nothing downstream has to assume a single provider.
- **Capture full assistant text, not just tool-call metadata.** Hook payloads
  for `PreToolUse`/`PostToolUse` carry only tool name/input/output — they do
  not include what the agent actually said. Without deliberately capturing
  assistant text, the event log can only ever render a transcript of tool
  calls and prompts, not the agent's reasoning — which is thinner than what
  a "click a character to see their session" UI (Phase 4 and beyond) needs.
  To fix this: capture `last_assistant_message` off `Stop` and
  `SubagentStop` — this alone is enough to satisfy this phase's Definition of
  Done and is not optional. Additionally, add the `MessageDisplay` hook to
  the wired-up list below for finer-grained, in-progress text — but treat
  this specific addition as best-effort, not required: `MessageDisplay`'s
  payload shape isn't documented as of this writing, and it's possible it
  doesn't exist or doesn't fire the way assumed in the installed Claude Code
  version. **If `MessageDisplay` turns out not to work as expected, Phase 1
  is still done** with `last_assistant_message` alone — don't let an
  unresolved `MessageDisplay` finding block this phase's completion.
- **Give retries/iteration a stable identity — but this feature has a real
  fallback if the underlying fact doesn't hold.** When a manager
  re-delegates the same logical task to a fresh subagent (e.g. after QA
  feedback), each attempt is a brand-new `session_id` with no built-in link
  back to the original task — without one, the daemon (Phase 2) can't tell
  "dev agent, attempt 2" from an unrelated new agent. Add a `task_id` field
  to the canonical event shape, and investigate whether Claude Code's
  `TaskCreated`/`TaskCompleted` events (or another correlating field in the
  payloads) can supply it — verify empirically rather than assuming. **If
  nothing in the payloads supplies a natural task identity: do not invent
  one, and do not approximate it with a fragile heuristic (e.g. "same
  declared name + same parent + close in time") that would masquerade as
  real data it isn't.** Instead, cut Phase 2's retry-linking and Phase 4's
  retry-thread UI for this pass — log them as a deferred practice ("no
  natural task identity found in Claude Code's hook payloads as of
  [version]"; revisit if that changes) rather than shipping a feature built
  on data that doesn't actually exist.
- Write one hook script (or one parameterized script reused across events)
  wired up for at minimum: `SessionStart`, `UserPromptSubmit`, `PreToolUse`,
  `PostToolUse`, `PostToolUseFailure`, `SubagentStart`, `SubagentStop`,
  `MessageDisplay`, `TaskCreated`, `TaskCompleted`, `Notification`,
  `PreCompact`, `Stop`, `SessionEnd`. Add `PermissionRequest` here too even
  though its blocking behavior isn't wired up until Phase 3 — capture it as a
  normal observe-only event for now. **This list is a floor, not a ceiling:**
  Phase 3 explicitly hedges that `PermissionRequest` might not turn out to be
  the right hook to block on ("or another blocking-capable event") — if
  Phase 3 needs a different or additional hook, add it then rather than
  treating this list as final.
- Each hook script reads its JSON payload from stdin, normalizes it into the
  canonical event shape, reads the daemon's address and auth token from the
  shared discovery file (principles 9-10), and POSTs it to the daemon with
  that token attached. On any failure to reach the daemon — including a
  missing or invalid discovery file — log the error locally and exit 0 —
  never block Claude Code because your daemon is down.
- **Do not assume the exact payload shape for each hook event from
  documentation alone.** Claude Code's hook payloads can differ from what's
  written up or change between versions. Instrument a real session, log the
  raw payloads for every event type, and build the normalizer against what
  you actually observe. Flag any event whose payload is ambiguous or
  underdocumented rather than guessing at its meaning.
- **Make "instrument a real session" a script, not a one-off manual step.**
  You'll do this again — when Claude Code updates, when a payload looks
  wrong, when a future provider adapter needs the same treatment. Write a
  small `scripts/capture-fixtures.ts` (or equivalent) that wires up a
  temporary hook config, points it at a throwaway log file instead of the
  daemon, and drops the raw payloads into `fixtures/<event-name>/`. This is
  the concrete tool that makes the fixture-diff regression test below
  something you can re-run in five minutes instead of re-deriving from
  scratch, and it's exactly the kind of thing worth having _before_ you need
  it urgently.
- Provide an installer command that writes the hook configuration into
  `~/.claude/settings.json`. This is an edit to a file the user already
  depends on — back up the existing file before writing, show a diff of what
  will change, and require confirmation before writing.
- **Keep a registry that can't silently drift from the code.** Maintain a
  single manifest listing every hook event this pass captures and which
  normalizer function handles it, and write a test that fails if the JSON
  Schema's known event types and the registry disagree, or if the registry
  and the adapter's actual normalizer map disagree. This is what catches "we
  added a normalizer but forgot the schema" or the reverse, instead of
  finding out at runtime.

**What to test:**

- Unit tests per normalizer: given a captured raw-payload fixture for a hook
  event, assert the normalizer produces the expected canonical event.
- The registry-sync test described above.
- A fixture-diff regression check, with two distinct cadences — don't
  conflate them: (1) asserting normalizer output against the _already-
  committed_ fixtures runs on every CI run, same as any other test — this is
  what catches a normalizer change that silently stops matching known-good
  payloads; (2) actually _re-capturing fresh fixtures_ from a live session
  (via `scripts/capture-fixtures.ts`) is manual/on-demand, not scheduled or
  CI-triggered, since it requires a real Claude Code session to run — do it
  when you suspect drift or after upgrading Claude Code, and diff the new
  capture against the committed fixtures by hand before deciding whether to
  update them.

**Definition of done:** running a real Claude Code session with subagents
produces a complete, correctly-ordered set of normalized events, visible in
the raw storage layer, with no gaps you can identify by comparing against
what you saw happen in the terminal.

**README note:** `README.md` already exists from Phase 0 — this phase should
only need to add capture-specific setup detail to it (the installer command,
what gets written to `~/.claude/settings.json`), not write install
instructions from scratch. Keep reinforcing the same rule Phase 0 set: `git
clone` → `npm install` → `npm link`, never `npx <package-name>`.

## Phase 2 — Local daemon

**Goal:** a persistent local service that stores events durably and makes
them queryable and streamable.

- `POST /events` — receives normalized events from hook scripts, persists to
  SQLite and to the JSONL backup, and broadcasts to connected WebSocket
  clients.
- `GET /sessions` — list known sessions/agents with current status derived
  from their most recent event.
- `GET /sessions/:id/events` — full ordered event history for one session,
  for replay.
- `GET /health` — trivial liveness check.
- **Implement principles 8-10 here, concretely, not just as standalone
  rules:** bind to `127.0.0.1` only with a test asserting it; on startup,
  generate (if not already present) a shared-secret token, write it to a
  restrictively-permissioned (`0600`) file at the discovery-file location
  decided in Phase 0's ADR, and require it on every request; that same
  discovery file is what hook scripts, the UI, the MCP server, and the
  `doctor` command all read to find the daemon's address and token — no
  consumer hardcodes a port.
- **Session/character identity mapping is a real design decision, not a
  given** — Claude Code does not hand you a role label. Work out and
  explicitly document how you infer whether a session is "the manager" versus
  a delegated worker, and what identifying info (declared subagent
  name/description, prompt content, parent/child relationship from
  `SubagentStart`) you use to do it. Per principle 16, this is a value the
  daemon derives at query time (or caches as a recomputable session-level
  field) — it does not get written into the immutable Phase 1 event log
  itself. Don't leave the inference rule implicit in scattered code — write
  it down somewhere a reader can find it.
- **Use the `task_id` field from Phase 1 to link retried/re-delegated
  attempts at the same logical task back to each other — if Phase 1 actually
  found one.** This is what lets a query like "show me every attempt at the
  QA task" return a coherent sequence instead of a set of unrelated sessions.
  If Phase 1 instead concluded no natural task identity exists in the real
  payloads, this bullet and Phase 4's retry-thread UI are both cut for this
  pass per Phase 1's guidance — don't build a weaker approximation here to
  compensate.
- Daemon must run as a long-lived local process, startable via the same CLI
  that does the hook installation.
- **A `doctor` command.** One CLI command that checks: is the daemon running
  and reachable on `127.0.0.1`, is the discovery file present with a valid
  token and readable permissions, are the hooks actually installed in
  `~/.claude/settings.json` and pointed at the right script paths, is the
  SQLite file writable. This is a small thing to build and a large thing for
  day-to-day use — "why isn't this working" is the single most likely
  support question you'll ask yourself (or Claude Code will ask on your
  behalf while debugging), and a deterministic answer beats re-deriving the
  diagnosis by hand every time.
- **One command to start the whole local stack.** `npm run dev` (or
  equivalent) should start the daemon — and, once Phase 4 exists, the UI
  alongside it — so iterating on this project doesn't require juggling
  multiple terminals by hand. Small, but it's exactly the kind of iteration-
  speed investment that determines whether working on this day to day feels
  good or feels like friction.
- Identity inference should be rule-based (structural signals: parent/child
  relationship, declared subagent name/description) for this pass, not
  LLM-based classification. Rule-based inference is deterministic and cheaply
  unit-testable; an LLM-judged classifier is the kind of thing that needs a
  fault-injection eval suite (planted ambiguous cases, checked against a
  known-correct answer) to trust — that's real infrastructure this project
  doesn't need yet. If rule-based inference turns out too thin to reliably
  tell agents apart, say so as an open question rather than silently reaching
  for an LLM classifier and skipping the eval work that choice would require.

**What to test:**

- Integration tests against a real running daemon and a real (test) SQLite
  database, hitting the actual HTTP and WebSocket API — not mocked storage.
- A kill-and-restart replay test: start a session, kill the daemon mid-way,
  restart it, and confirm the full event history is still reconstructable
  from the JSONL backstop alone. This is the thing that actually proves the
  "durability backstop independent of the database" tech-stack choice does
  something, rather than being unused insurance.
- Identity-inference unit tests against known `SubagentStart` fixtures,
  including at least one deliberately ambiguous case — if inference gets that
  case wrong, that's the signal the open question above is asking you to
  watch for, not a test to quietly loosen.

**Definition of done:** with the daemon running, you can query it mid-session
and get an accurate, current picture of every active agent and its status,
and after the session ends, replay its full event history from storage alone.

## Phase 2.5 — Read-only MCP server (query, not act)

**Goal:** let a Claude Code session query the daemon directly, as a tool
call, without leaving the conversation — the thing the plain UI can't give
you, since Claude Code's own primitives don't let a session see its sibling
sessions' live status. This is deliberately scoped to _reading_ the same
data Phase 2's REST API already exposes; it adds no new capability to the
system, just a second, agent-facing consumer of it — consistent with the
decoupling principle the daemon is already built around.

- An MCP server (stdio or local HTTP transport, whichever the MCP SDK makes
  simpler here) exposing tools that map directly onto Phase 2's existing
  endpoints: `list_sessions` (all sessions/agents the daemon is currently
  tracking, not just the caller's own — this cross-session visibility is the
  actual point), `get_session_status(session_id)`, `get_session_events
(session_id)` for history/replay. Same as every other consumer, it reads
  the daemon's address and auth token from the shared discovery file
  (principles 9-10) rather than hardcoding either.
- Strictly read-only for this pass. **Do not** add a tool that lets an agent
  answer a `PermissionRequest` on your behalf — that's a materially different
  risk (an agent auto-resolving a permission request instead of a human) and
  belongs, if it ever gets built at all, only after Phase 3's blocking
  mechanism is proven reliable and its fail-open ceiling is well understood,
  not bundled in here.
- Register it as an MCP server for your own Claude Code config so you can
  actually use it day to day — this is a "does it work for me" feature
  first, not a demo built and then set aside.

**What to test:** integration tests calling each MCP tool against a real
running daemon with multiple concurrent tracked sessions (a single-session
test wouldn't exercise the actual reason this exists — cross-session
visibility). Also a deliberate manual check: from within a real Claude Code
session with subagents running, ask it to check on a sibling session's status
via this tool and confirm the answer matches what the daemon actually has.

**Definition of done:** from inside a live Claude Code session, you can ask
about the status of a different, concurrently-running session (not the one
you're in) and get a correct answer back as a tool call — no browser, no
terminal-switching.

## Phase 3 — Human-in-the-loop hook (build and prove in isolation first)

**Goal:** de-risk the hardest and most failure-prone part of this system
before building anything that depends on it.

- Use `PermissionRequest` (or another blocking-capable event) as the
  mechanism. When it fires, the hook script posts an "awaiting input" event
  to the daemon, then polls a `GET /sessions/:id/answer` endpoint until either
  an answer appears or a timeout is reached.
- **The default hook timeout (60 seconds) is very likely too short for a
  human to actually notice and respond to a request.** Explicitly configure a
  longer timeout for this specific hook, and explicitly decide and document
  what happens on timeout — does Claude Code get denied, allowed, or does the
  agent stall in some other way? Do not leave this as accidental default
  behavior; log every timeout event so it's visible during testing.
- **Known risk, verified elsewhere, not hypothetical: Claude Code hooks fail
  open on timeout.** A sibling project (`til`) built a blocking pre-commit
  hook on this same mechanism and killed it after finding empirically that if
  the hook process doesn't finish inside its configured timeout, the tool
  call proceeds regardless of what the hook wanted to do — the block is not
  guaranteed just because you configured a long timeout. Do not assume your
  daemon's "deny" answer is actually enforced once you're past the timeout
  boundary; **empirically verify, on your own machine, what really happens**
  when nothing answers before timeout (does it deny, allow, or hang?) rather
  than assuming the desired behavior. If the answer is "it allows," default
  the hook's own fallback behavior to the safer of the two where you have any
  control over it (e.g. exit in a way that signals deny rather than the
  reverse), and document the actual observed ceiling on this mechanism's
  reliability plainly rather than presenting it as a hard guarantee it isn't.
- Build a bare-bones way to answer (even a `curl`/CLI command is fine for this
  phase — the real answer UI belongs in Phase 4). The point of this phase is
  proving the block-and-wait mechanism works reliably, not building UI for it.
- Give the answer-polling loop a hard budget: a maximum wait tied to the
  configured hook timeout, never an unbounded poll. On exhausting the budget,
  log the timeout loudly — this loop is exactly the kind of thing that must
  not fail silently.
- Test this against a real session with a real permission prompt before
  moving on. If it can't be made reliable here, say so plainly rather than
  building further phases on a shaky foundation.

**What to test:**

- The happy path: trigger a permission request, answer it externally, confirm
  Claude Code resumes correctly.
- The timeout boundary itself, as a required case, not an afterthought: let a
  request go unanswered past the configured timeout and record exactly what
  Claude Code does. This is the empirical check the risk note above calls
  for — don't skip it because the happy path passed.
- Repeat-reliability: trigger the round trip N times in a row (not once) and
  confirm zero silent failures — a mechanism that works once and flakes on
  repetition is not done.

**Definition of done:** you can trigger a permission request in a live
session, answer it from outside the terminal, and watch Claude Code resume
correctly — repeatedly, without flaky timeouts — **and** you have a written,
empirically-verified (not assumed) answer to what happens on timeout. If
testing shows the block genuinely cannot be made reliable beyond a certain
point, that finding is itself an acceptable Phase 3 outcome — document the
ceiling and its implications for Phase 4/5's HITL UI rather than silently
building further phases on an unproven guarantee.

**This finding is load-bearing for everything downstream, and it changes what
"done" means later, not just what Phase 3 documents.** Phase 4's Definition
of Done and the project's overall success criteria (below) are both written
as if a HITL round trip reliably works — that's only valid if Phase 3 comes
back clean. Concretely, once Phase 3 concludes:

- **If reliable (within some window):** Phase 4/5's Definition of Done and
  the overall success criteria stand as written, but scoped to answering
  within that documented window — not "always," since "always" was never
  actually tested.
- **If not reliable at all:** don't let Phase 4/5 or the overall success
  criteria continue to silently require an unconditional HITL round trip.
  Rewrite them to match what's actually true — e.g., the UI still surfaces
  and lets you _attempt_ to answer a permission request (useful, honest,
  observable behavior), but the project's definition of "done" drops the
  guarantee that the attempt reliably lands before Claude Code proceeds
  anyway. Say this plainly in the relevant Definitions of Done rather than
  leaving them describing a guarantee Phase 3 disproved.

## Phase 4 — Minimal introspection UI (plain, not the game)

**Goal:** prove the schema and daemon are sufficient to build _something_
useful before investing in Phase 5's visual layer — and build it well enough
that it's genuinely usable day to day in the meantime, since this may end up
being what you actually use for a while before Phase 5 exists.

- A small web app (Vite + React is fine, but this is one of the areas you
  have latitude — pick what's fast to build) that connects to the daemon over
  WebSocket for live updates and REST for history.
- **Wire this UI into Phase 2's `npm run dev` single-command stack, as that
  phase already anticipated** — this is easy to forget since it's only
  mentioned in Phase 2's prose, not repeated here as a task. Do it now so the
  one-command dev loop is actually complete once this phase exists, not left
  half-finished.
- **The board — the primary landing view.** A named, live view of every
  currently-tracked session and its status (idle, working, awaiting-input,
  error, done) — literally "what is everyone doing right now." This is the
  human-facing mirror of Phase 2.5's `list_sessions` MCP tool: same
  underlying data, two consumers. Group/indent by parent/child relationship
  rather than a flat list — even in the plain UI, "who spawned whom" is core
  to understanding delegation, not a Phase 5-only nicety.
- **A "waiting on me" filter on the board.** Given more than a handful of
  concurrent agents gets hard to scan visually (an earlier finding this
  project has already leaned on), a one-click filter down to only
  blocked/errored agents is the fast path past that, rather than asking you
  to eyeball a long list every time.
- **A persistent "N agents waiting on you" indicator, visible from every
  view, not just the board.** The HITL feature only delivers value if you
  actually notice a request — a board you have to already be looking at
  defeats that. This should follow you across pages (a badge/toast), not be
  something you only see if you happen to be on the right screen.
- **A connection/daemon-health indicator.** If the WebSocket drops, the UI
  should visibly say "disconnected — showing data as of [time]," not
  silently keep looking normal while quietly going stale.
- Click into a session to see its full event/transcript history.
- **A retry/attempt thread, not scattered independent rows.** `task_id`
  (Phase 1/2) links retried attempts at the same logical task — render that
  as one connected thread ("QA task — attempt 1 (failed) → attempt 2 (in
  progress)"), not unrelated entries that happen to look similar.
- **A history/archive view, separate from the live board.** The board
  answers "what's happening now"; this answers "show me past sessions,"
  which needs its own entry point rather than only working if you already
  know a session ID. Back it with a **lightweight, non-LLM summary record**
  generated automatically per finished session (role/name, start/end time,
  duration, final status, `task_id`/attempt number, tool-call count, a
  truncated preview of `last_assistant_message`) so browsing history doesn't
  mean loading every full transcript just to render a list — the summary is
  an index for browsing, never a replacement for the full stored event log
  it's derived from.
- **A "pin" action on a past session**, exempting it from whatever automatic
  pruning principle 13's retention policy eventually applies — so the
  session where a hard bug actually got fixed, or the first HITL round-trip
  that worked, doesn't get silently swept away by a policy tuned for the
  common case.
- A real answer UI for HITL requests, replacing the Phase 3 CLI stopgap.
- No game aesthetic, no animation, no time spent on visual polish for its own
  sake — that investment belongs in Phase 5. That's a different instruction
  from "make it unpleasant to use": it should be fast, legible, and not
  fight you, since you may be looking at this screen daily for a while.
- **Captured content is untrusted when it reaches the browser, same as
  principle 12 says at the daemon level.** This UI is the first place
  `raw_payload`/tool-output/prompt text actually renders in a browser — treat
  it strictly as text, never as HTML or unsanitized markdown. Don't reach for
  `dangerouslySetInnerHTML` (or equivalent) on anything sourced from captured
  content; a tool output containing something that looks like a `<script>`
  tag is realistic, not a hypothetical, given this data comes from arbitrary
  shell commands and file contents.

**What to test:** this phase is validated primarily by the golden-path manual
QA run described in the Definition of Done below, since it's explicitly not
the deliverable — a handful of component tests for the session-list and
event-history views are enough; don't over-invest in test infrastructure for
a UI you already intend to replace visually in Phase 5.

**Definition of done:** using only this UI, with no terminal open, you can
watch a real multi-agent session run, see an agent raise a HITL request,
answer it from the UI, and watch the session continue and complete
correctly.

## Phase 5 — Interactive 2D visualization layer (designed now, gated on Phase 4)

**Goal:** replace Phase 4's plain UI with a visually legible scene that makes
multi-agent status readable at a glance, without inventing any signal that
isn't already a real field in the event schema. **Do not start building this
phase until Phase 4's definition of done is met on a real session.** This
section exists so the schema and daemon aren't redesigned later to support
visualization — designing for it now is cheap, building it early is not.

**Why 2D, not 3D:** the underlying data is discrete, not continuous — an
agent's state changes at lifecycle boundaries (idle → working → error/
awaiting-input → done), not smoothly over time. 3D's actual strengths (fluid
motion, spatial navigation, continuous animation) answer a question this data
doesn't ask, and faking continuity to fill the medium is exactly the
decorative-not-state-encoding trap this project has otherwise avoided. 2D also
scales better for the actual use case — legibility drops once a 3D scene has
more than a handful of agents in view, where a 2D grid or hierarchy layout
keeps scanning cheap. Because the daemon knows nothing about presentation
(architecture principle 1), this choice isn't load-bearing forever: a 3D
renderer would be a new consumer of the same event stream if ever justified
later, not a rewrite.

- Each active session/agent renders as a state-driven sprite or icon (Canvas,
  SVG, or DOM+CSS — no WebGL/3D engine needed). State transitions (idle,
  working, awaiting-input, error, done) map to distinct visual states —
  color, icon, or simple CSS-transition changes, not continuous tweened
  animation, since the source data has no continuous signal to drive one
  honestly.
- Layout reflects the real parent/child and `task_id` relationships from
  Phase 1/2 — e.g. a hierarchy or grouped-by-task layout — rather than an
  arbitrary or purely aesthetic arrangement. The root session (no
  `parent_session_id`) is not a special "orchestrator" concept in the schema
  — it's simply the node with no parent, and before any subagent spawns, it's
  the only character in the scene.
- **A character's full lifecycle: pending (maybe) → active → awaiting-input
  → done/error, and it does not disappear at "done."** A finished agent
  transitions to a dimmed, visually distinct "done" state and stays in the
  scene, clickable — both because you'll want to open its transcript after
  the fact, and because a retry thread (Phase 4) only reads as a thread if
  attempt 1 is still visible next to attempt 2, not vanished the moment the
  retry starts.
- **A "pending" slot before a session exists is possible only if a specific
  empirical fact holds: does `TaskCreated` fire before the corresponding
  `SubagentStart`, for the same unit of work?** If so, render a
  ghost/placeholder the moment `TaskCreated` fires and attach the real
  session to it when `SubagentStart` arrives — a nicer entrance than a
  character materializing from nothing. **Go in expecting this probably
  isn't buildable, not treating it as the likely default:** `TaskCreated`/
  `TaskCompleted` most plausibly track Claude Code's todo/plan-list
  mechanism, not the Task-tool subagent-spawning mechanism — a todo item
  frequently gets done by the main agent with no subagent ever spawned, and
  a subagent can be spawned without ever being tracked as a discrete todo
  item, so the two event streams are more likely uncorrelated than 1:1
  linked. Verify empirically in Phase 1 regardless (see open questions) —
  but design and build the simpler fallback (agents simply appear on
  `SubagentStart`, no pending state) as the primary path, and treat the
  pending-slot version as a bonus if the empirical check happens to allow
  it, not as the thing Phase 5 is planned around.
- **There is no fixed pool of "empty" agent slots, and no scenario where you
  spawn more agents than a pre-allocated capacity.** Claude Code's subagent
  spawning has no fixed worker-pool concept to mirror — a pending slot (if
  buildable per the point above) exists 1:1 with a real, currently-unmatched
  `TaskCreated` event, and simply stops existing once matched or resolved.
  An arbitrary fixed pool size would itself be invented UI state with
  nothing behind it.
- **Layout must reflow around however many agents actually exist, including
  a sudden burst (e.g. a manager spawning 30 subagents at once) — this is a
  rendering question, not a capacity question.** Concretely: the
  hierarchical/grouped-by-parent layout already specified above mostly
  solves this by construction, since a burst of subagents from one parent
  clusters under that parent rather than scattering across the scene. Add:
  a brief, one-time entrance transition (fade/scale-in, not continuous
  animation) so a sudden burst reads as "arrived" rather than a jarring
  flash of new elements; and collapse a sibling group past some size
  threshold into an expandable summary node ("12 QA agents ▸") rather than
  rendering every icon at every scale — the same pattern file trees and chat
  threads use for overflow. Explicitly do not build viewport
  virtualization/pan-zoom for very large scenes now — that's a real
  technique if a burst ever actually causes rendering lag in practice, but
  building it against a guess, before it's a demonstrated problem, is the
  same premature-generalization trap the rest of this plan avoids elsewhere.
- Clicking a character opens the same session-detail view built in Phase 4
  (reused, not reimplemented) — this is the concrete realization of the
  "click a character to see their session" feature that motivated the whole
  project.
- The real HITL answer UI (already built in Phase 4) gets a visual trigger
  here — e.g. a hand-raise state — but the underlying answer mechanism is
  unchanged from Phase 3/4.
- Every visual cue must trace back to a real field in the event schema. If
  you find yourself wanting a visual state that doesn't correspond to
  anything the schema captures, that's a signal to add the field properly
  (schema version bump) rather than invent UI-only state.
- **Write down the visual identity, then enforce it mechanically.** Once
  there's a real palette/state-color mapping (error = red, awaiting-input =
  hand-raise, etc.), put it in a short `docs/DESIGN.md` and reference colors
  through named tokens, never raw hex values scattered through components —
  mirroring `til`'s `docs/DESIGN.md` + `check:colors` pattern: a small guard
  script in CI that fails if a raw color value shows up outside the token
  definitions, so drift is caught mechanically instead of relying on review
  to notice it. Also set a bundle-size budget for this UI (`til` uses
  `size-limit`) — a local tool doesn't need to be tiny, but an unbounded,
  unmonitored bundle is still worth catching before it happens rather than
  after.

**What to test:** the same golden-path multi-agent + HITL round trip as
Phase 4's Definition of Done, run entirely through this UI with no terminal
open — this phase doesn't get its own separate success bar, it has to clear
the same one Phase 4 did, visually.

**Definition of done:** identical to Phase 4's, but achieved through this UI.

---

## Deferred practices

Each entry: what it is, why it's deferred (a real reason, not "not needed
yet"), and the concrete trigger that would make it worth revisiting — not
"eventually."

- **LLM-generated session summaries.** What: replacing (or augmenting) the
  structural, non-LLM per-session summary record (Phase 4) with a natural-
  language one generated by calling a model. This splits into two distinct
  cases, deferred for different reasons — worth keeping separate rather than
  treating "LLM summary" as one blocked idea:
  - **Via a remote/hosted model API** (Anthropic's or any other provider's):
    blocked outright by principle 2 — this is the daemon itself sending
    captured, sensitive content (real prompts, real code) as a new network
    call beyond localhost, which is exactly the boundary that principle
    exists to hold. Not a "less ideal" option, a ruled-out one, regardless of
    cost or quality.
  - **Via a genuinely local model** (e.g. something like Ollama running on
    the same machine, called over `127.0.0.1`): this would _not_ actually
    violate principle 2 as scoped — a localhost call to a local model never
    leaves the machine. It's still deferred, but for different reasons: it
    still has to honor principle 12 (captured content fed back into any
    model, local or not, is treated as untrusted data, never as
    instructions), and it's new, unevaluated scope — bundling or requiring a
    local model runtime as a dependency, plus a real quality tradeoff versus
    a hosted model for summarization specifically. Worth a real look later,
    just not something to fold in quietly now.
  - Also, either way, real secondary cost: token/latency/non-determinism
    added to what's currently a fast, deterministic summary step for no
    added build cost.
    Revisit when: for the remote case, you've decided specifically how
    consent/opt-in for that data flow should work; for the local-model case,
    once there's an actual evaluated reason to want it (better summaries,
    specifically) weighed against the new dependency it introduces.
- **MCP-driven HITL answering.** What: an MCP tool that lets an agent answer
  a `PermissionRequest` on your behalf, as an extension of Phase 2.5's
  read-only MCP server. Why deferred: an agent auto-resolving a permission
  request is a materially different risk than a human doing it, and Phase
  2.5 is deliberately scoped to read-only for exactly this reason. Revisit
  when: Phase 3's blocking mechanism and its fail-open ceiling are proven and
  well-documented, and you've decided, deliberately, what class of requests
  (if any) are safe to let an agent resolve on your behalf.
- **3D visualization.** What: a Three.js (or similar) rendered scene replacing
  Phase 5's 2D layer. Why deferred: the underlying data is discrete, not
  continuous (see Phase 5's rationale) — 3D's strengths don't answer a
  question this data asks, and it costs far more to build (asset pipeline,
  rigging, pathfinding). Revisit when: Phase 5's 2D layer is in real use and
  a specific, named limitation of 2D shows up that 3D would actually fix —
  not as a default upgrade.
- **Agent-teams live-messaging capture.** What: capturing direct
  teammate-to-teammate messages from Claude Code's experimental agent-teams
  feature, as opposed to the hub-and-spoke subagent model this plan captures.
  Why deferred: agent teams are experimental, disabled by default, and it's
  unverified how much of teammate-to-teammate messaging is exposed in a
  structured way versus buried in each teammate's own transcript. It also
  doesn't match your actual current workflow, which is a pipeline
  (manager → worker → worker), not live negotiation between peers. Revisit
  when: a real workflow needs agents to iterate with each other before a
  manager sees the result (not just be retried by the manager with feedback,
  which the current subagent model already covers), or Claude Code
  stabilizes agent-teams' observability surface.
- **Multi-machine or remote aggregation, cloud sync, hosting, or multi-user
  features.** What: anything beyond a single local daemon on one machine for
  one user. Why deferred: violates the 100% local / no-network-beyond-
  localhost principle that exists specifically because captured data includes
  real source code and prompts; also unnecessary complexity before the
  single-machine case is even proven. Revisit when: never, without a
  deliberate, separate security- and privacy-reviewed decision — this isn't a
  "not yet," it's a high bar.
- **Gemini CLI or GPT/Codex-based agent adapters.** What: `/adapters/gemini-
cli/`, `/adapters/codex/`, etc., implementing the `ProviderAdapter`
  contract from architecture principle 7. Why deferred: unresearched whether
  these tools expose anything analogous to Claude Code's hooks at all —
  building an adapter against an unverified surface is exactly the kind of
  guessing this plan tells you not to do even for Claude Code's own hooks.
  Revisit when: that research happens (see open questions below) and
  confirms a usable capture mechanism exists.
- **npm publishing.** What: an `npm publish` workflow, registry account, and
  public package listing. Why deferred: see architecture principle 6 — brings
  semver and public-issue-triage obligations before the daemon and HITL flow
  are even proven. Revisit when: Phase 4 (or 5) is validated and there's an
  actual person other than you who wants a one-line install.
- **Formal eval suite (fault-injection style, LLM-as-judge).** What: planted
  ambiguous/adversarial test cases run against the system's own judgment
  calls, graded on defensible reasoning rather than exact match. Why
  deferred: Phase 1–3 of this project is conventional integration testing
  (did the daemon durably and correctly store what happened) — there's no
  LLM judgment call in the loop yet, since Phase 2's identity inference is
  deliberately rule-based, not LLM-classified. Revisit when: identity
  inference (or anything else in this system) becomes fuzzy/LLM-based enough
  that "is this classification correct" stops being a deterministic question.
- **`CODE_OF_CONDUCT.md`.** What: a formal contributor code of conduct,
  alongside the `SECURITY.md`/`CONTRIBUTING.md` pair built in Phase 0. Why
  deferred: neither sibling project in this workspace has one, and it mostly
  matters once a repo has an actual external contributor community to
  govern — premature for a project with a single maintainer. Revisit when:
  the project starts receiving outside PRs or issues from people other than
  you.

## Open questions to flag rather than silently resolve

- The exact JSON shape of each hook event's payload on the Claude Code
  version in use — verify empirically in Phase 1, don't assume from docs.
- Whether hook timeouts are configurable per-hook-event or only globally —
  this materially affects the Phase 3 design.
- What metadata is actually available on `SubagentStart` to support role
  inference in Phase 2 — if it's thin, say so and propose an alternative.
- What actually happens when a `PermissionRequest` hook's poll times out
  unanswered — deny, allow, or something else. A sibling project's experience
  (see Phase 3) suggests Claude Code hooks fail open on timeout regardless of
  configured timeout length; confirm this empirically for `PermissionRequest`
  specifically rather than assuming it behaves identically to the hook that
  project tested.
- The exact JSON shape of `MessageDisplay`'s payload — undocumented as of
  this writing. Verify empirically whether it carries incremental text,
  full-message text, or something else before building the normalizer for
  it.
- Whether `TaskCreated`/`TaskCompleted` (or some other payload field) actually
  supplies a stable identifier that can serve as `task_id` for linking
  retried attempts of the same logical task — verify empirically; if nothing
  in the real payloads supplies this, say so rather than inventing an
  identifier that doesn't correspond to anything Claude Code actually gives
  you.
- **Whether `TaskCreated` fires before the corresponding `SubagentStart`, or
  the two are effectively uncorrelated.** This determines whether Phase 5's
  "pending slot" design (render a placeholder the moment a task is planned,
  attach the real session once it spawns) is buildable at all, or whether
  agents can only ever appear at the moment they're actually spawned. Best
  guess going in, not a neutral coin flip: `TaskCreated`/`TaskCompleted`
  most plausibly track Claude Code's todo/plan-list mechanism rather than
  the Task-tool subagent-spawning mechanism, and the two are more likely
  uncorrelated than 1:1 linked — plan around the simpler "agents appear on
  spawn" fallback as the primary path, and treat a favorable empirical
  result as a bonus, not the design center. Verify empirically in Phase 1
  alongside the `task_id` question above regardless of this guess.
- Whether Gemini CLI or GPT/Codex-based coding agents expose any
  hook-equivalent, event-emitting, or transcript-log mechanism at all — this
  is unknown and determines whether the `provider` field is ever more than a
  placeholder. Do not investigate this in depth during this pass; a quick
  note if you happen to know is fine, but this is future-phase research.

## Overall success criteria

Run a real project task that requires multi-agent delegation (manager +
several subagents) end to end, entirely observed and interacted with through
this system with no terminal visible — including at least one real
human-in-the-loop round trip — and have the replayed event log in SQLite
match what actually happened, completely and in the correct order.

**The human-in-the-loop round trip requirement here is conditional on Phase
3's finding, not an assumed guarantee** — see Phase 3's Definition of Done
for what "done" means for this criterion if the block turns out not to be
reliable. Don't treat this bar as fixed and unconditional if Phase 3's actual
result says otherwise.

This bar applies at Phase 4 (through the plain UI) and again, unchanged, at
Phase 5 (through the 2D scene) — Phase 5 doesn't get an easier or different
success criterion just because it's the more visually ambitious phase; it has
to reproduce the same real, verifiable outcome, just through a different
window onto the same event log.
