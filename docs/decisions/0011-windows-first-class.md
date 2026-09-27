# 0011. Windows is first-class from Phase 0

- Status: Accepted
- Date: 2026-09-26
- Plan: D11 (PLAN §2)

## Context

The primary dev machine runs Windows 11. Windows-specific issues (ConPTY, `.cmd` shims for
npm-installed CLIs, path separators, quoting, killing process trees, pid reuse, console-close
signals) are expensive to retrofit. node-pty install pain on Windows is a known risk
(PLAN §12).

## Decision

Windows is handled from the start: `path` APIs instead of string concatenation, no POSIX-only
shell in scripts, binaries resolved through the provider registry (`.cmd`/`.exe`), tree kill
(`taskkill /T` or equivalent), `SIGHUP`/Ctrl-Break handling, and LF line endings forced by
`.gitattributes`. CI (`.github/workflows/ci.yml`) runs `npm ci`, `npm run check` and
`npm run build` on `ubuntu-latest`, `macos-latest` and `windows-latest`.

Verified in task 0.3: node-pty 1.1.0 installed on Windows 11 using bundled prebuilds
(prebuilds exist for win32-x64, win32-arm64, darwin-x64 and darwin-arm64), so no Visual Studio
Build Tools were needed. Linux builds node-pty from source (ubuntu runners have python3, make
and g++). The ConPTY smoke test `apps/server/src/pty/pty.smoke.test.ts` passes locally and runs
on every OS in CI.

## Consequences

### Positive

- Platform bugs surface in the task that introduces them, not in a late porting pass.
- Contributors on any OS get the same `npm run check`.

### Negative

- CI costs roughly three times the minutes (macOS and Windows runners are slower and bill at
  higher multipliers), and matrix failures add complexity to every PR.
- Every script and path-handling change must be written and reviewed for two shell families.
- Linux installs need a C/C++ toolchain for node-pty.

## Revisit when

Never.

## References

- PLAN §5.5, §5.6, §10 (tasks 0.3, 0.10), §12
- CLAUDE.md working style
- ADR 0023
