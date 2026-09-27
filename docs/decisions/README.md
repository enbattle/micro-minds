# Architecture Decision Records

Short records of the decisions that shape micro-minds. ADRs 0001–0023 correspond one-to-one to
decisions D1–D23 in [PLAN §2](../PLAN.md#2-key-decisions-with-rationale).

| # | Title | Status |
|---|---|---|
| [0001](0001-embedded-real-terminals.md) | Embedded real terminals for prompting | Accepted |
| [0002](0002-hooks-as-structured-event-channel.md) | Hooks are the structured event channel | Accepted |
| [0003](0003-local-web-app.md) | Local web app bound to 127.0.0.1 | Accepted |
| [0004](0004-no-credential-access.md) | The app never touches credentials | Accepted |
| [0005](0005-one-worktree-per-session.md) | One git worktree per session, stored outside the repo | Accepted |
| [0006](0006-r3f-orthographic-camera.md) | Three.js via React Three Fiber, orthographic camera by default | Accepted |
| [0007](0007-placeholder-characters-first.md) | Placeholder characters first | Accepted |
| [0008](0008-board-primary-scene-skin.md) | The board is primary; the scene is a skin | Accepted |
| [0009](0009-hooks-fail-open.md) | Hooks fail open | Accepted |
| [0010](0010-claude-first-multi-provider-by-design.md) | Claude-first MVP, multi-provider by design | Accepted |
| [0011](0011-windows-first-class.md) | Windows is first-class from Phase 0 | Accepted |
| [0012](0012-worktrees-under-micro-minds-home.md) | Worktrees live under `~/.micro-minds/worktrees/<repo-slug>/<sessionId>` | Accepted |
| [0013](0013-two-token-classes.md) | Two token classes: UI token vs per-session hook token | Accepted |
| [0014](0014-bounded-redacted-raw.md) | `raw` payloads are bounded and redacted | Accepted |
| [0015](0015-time-enters-reducer-as-events.md) | Time enters the reducer only as events | Accepted |
| [0016](0016-headless-xterm-scrollback.md) | Terminal scrollback is kept by a headless xterm on the server | Accepted |
| [0017](0017-biome-and-tsc.md) | Biome for lint and format, `tsc --noEmit` for types | Accepted |
| [0018](0018-npm-workspaces.md) | npm workspaces (not pnpm) | Accepted |
| [0019](0019-watch-orchestration-dont-drive.md) | The app watches orchestration; it doesn't drive it | Accepted |
| [0020](0020-lightweight-resume.md) | Lightweight resume is in the MVP | Accepted |
| [0021](0021-graceful-shutdown.md) | Graceful shutdown with a warning | Accepted |
| [0022](0022-mood-derived-and-pure.md) | Mood is derived and pure | Accepted |
| [0023](0023-node-native-type-stripping.md) | Node runs TypeScript directly (native type stripping) | Accepted |

## When to write an ADR

- Any decision that adds to, changes or reverses a decision in PLAN §2.
- Anything that changes agent behavior (CLAUDE.md hard rule 12), for example the Phase 6
  opt-in blocking permission hook, which breaks [0009](0009-hooks-fail-open.md).
- Answers to the open questions in PLAN §13, and verdicts the plan asks to "record as an ADR"
  (for example task 1.4, relay vs HTTP hook).

## How to add one

1. Copy [`0000-template.md`](0000-template.md) to `NNNN-kebab-title.md`, using the next free
   number. New decisions continue after 0023; if the decision is also added to PLAN §2 as
   `Dxx`, note that in the `Plan:` line.
2. Fill in Context, Decision, Consequences (positive and negative, with mitigations), Revisit
   when and References. Keep it short and concrete: name mechanisms, files and trade-offs.
3. Set Status to `Proposed` while under discussion, `Accepted` once agreed.
4. Never rewrite an accepted ADR's decision. Supersede it: write a new ADR, and change the old
   one's Status to `Superseded by NNNN`.
5. Update PLAN §2 and the table above in the same commit.
