# 0026. UI sessions start from a one-time code and live in an HttpOnly cookie

- Status: Accepted
- Date: 2026-09-27
- Plan: D26 (PLAN §2, §8, §9). Supersedes the "UI token embedded in the served page" part of
  [ADR 0013](0013-two-token-classes.md); the hook-token part of 0013 is unchanged.

## Context

ADR 0013 split tokens so that a hook token, which every agent can read from its environment,
never grants WS or control access. It also said the UI token is "embedded in the served page".

The threat model ([docs/security/threat-model.md](../security/threat-model.md)) found that this
undoes the split. Any local process, including a prompt-injected agent running in one of our
PTYs, can `GET http://127.0.0.1:<port>/`, read the token from the HTML, and open the WebSocket
with a forged `Origin` header. Only browsers enforce Origin, so the check doesn't stop them. The
agent would then control every session: typing into other PTYs, creating sessions and removing
worktrees.

So the browser must hold a credential that a plain HTTP client on the same machine can't obtain.

## Decision

1. **One-time bootstrap code.** At startup (and when the user asks for a new link from the
   server console), the server creates a random 256-bit code that is **single-use** and expires
   after **60 seconds**. It opens the browser at `http://127.0.0.1:<port>/#bootstrap=<code>`. A URL
   fragment is never sent to the server, so it doesn't show up in request logs.
2. **Exchange.** The page reads the fragment, removes it at once with `history.replaceState`, and
   sends `POST /api/session` with a JSON body `{ code }`. The server checks Origin and Host,
   requires `Content-Type: application/json` (so the request isn't a CORS "simple request"),
   compares the code in constant time, and invalidates it on first use, whether it succeeds or
   fails.
3. **Session cookie.** On success the server sets a random session cookie: `HttpOnly`,
   `SameSite=Strict`, `Path=/`, lasting as long as the server process. `Secure` is omitted
   because the app is plain HTTP on loopback.
4. **Authorization.** The WS upgrade and every control route require the valid session cookie
   **and** a matching Origin and Host. The served HTML and static assets contain no secret. The
   `{ t: 'auth', token }` frame is removed from the protocol (PLAN §8).
5. **Restarts and new tabs.** A restart invalidates every session. The server opens a fresh
   bootstrap link automatically. Old tabs get a clear "Server restarted, use the new window"
   state. Tabs opened from an authenticated tab share its cookie.
6. **Dev mode.** The Vite dev server proxies `/api` and `/ws` to the server, so the page, the
   cookie and the WS share one origin. Nothing changes for the dev server.
7. **Hook tokens** are unchanged (ADR 0013, 0025).

## Consequences

### Positive

- `curl` from an agent's PTY gets nothing useful: no token in the page, the cookie is never
  exposed to scripts, and the bootstrap code is gone by the time an agent could act.
- Cross-site pages can't use the cookie (`SameSite=Strict`, plus Origin checks and JSON-only
  control routes).

### Negative

- More moving parts than an embedded token: a bootstrap endpoint, cookie handling and a
  "new link" flow in the console. They need tests (task 2.9).
- **Residual risk:** while the browser is being launched, the URL with the code can appear in
  that process's command line, which other processes of the same OS user could read. It's
  single-use with a 60-second TTL. If another process redeems it first, the browser's exchange
  fails and the UI warns loudly ("this link was already used; possible local interference").
  Attackers able to read browser memory are out of scope (threat model: residual risks).
- A user who opens the app URL by hand, without a code, has to ask the server console for a new
  link.

## Revisit when

A browser-integrated credential (for example a native wrapper in Phase 8) makes the bootstrap
unnecessary, or the threat model finds a cheaper channel with the same guarantee.

## References

- [ADR 0013](0013-two-token-classes.md), [ADR 0025](0025-usage-cost-from-cli-telemetry.md)
- PLAN §2 (D13, D26), §5.6, §8, §9; tasks 2.8, 2.9, 3.1
- [docs/security/threat-model.md](../security/threat-model.md)
