# Phase 1 terminal check (task 1.5)

Checked 2026-09-28 with Claude Code **2.1.283**, Node 24.21.0, node-pty 1.1.0 (ConPTY) and
`@xterm/xterm` 6.0.0 with `@xterm/addon-fit` 0.11.0, on Windows 11 in Chrome.

`npm run spike:pty-view` (`pty-view.ts`) creates a fresh scratch repo and a throwaway `git worktree`
of it under `~/.micro-minds-dev/spike/`, starts `claude` there in node-pty, and serves one page on
127.0.0.1 behind a random URL token: xterm.js in the browser, output over server-sent events,
keystrokes and resizes back as POSTs. The worktree is kept; the command to remove it is printed.

The driving session ran the check itself, with the user's OK, through the Claude in Chrome browser
tools: screenshots of the page, keys typed into the terminal, and the terminal container resized
inside the page (a window resize didn't change the viewport of the maximized window). It spent no
tokens: no prompt was sent.

## Results

| Check | What was done | Result |
|---|---|---|
| Login | Started `claude`; answered the folder-trust dialog for the fresh worktree | **Pass.** No login prompt: the normal input box, with the model and plan shown. The trust dialog itself also rendered correctly. |
| Colors | Screenshots of the trust dialog and the input screen | **Pass.** The orange logo and headings, the highlighted choice, and the colored mode footer, with no raw escape codes. |
| Resize | Shrank the terminal container to about 520 px wide (the page's fit addon sent the new size), then restored it | **Pass.** Claude redrew for the new width (the worktree path ends in "…", the rules shorten), and again at full width, with no garbled or duplicated lines. |
| Alternate screen | `/config`, then Esc twice (the first leaves the search box) | **Pass.** The full-screen settings view rendered cleanly, and the previous screen came back intact. |

## For task 3.3 (the terminal drawer)

- xterm.js 6 with the fit addon is enough for Claude Code's TUI, including its full-screen views.
- A resize must reach the PTY (`pty.resize`) for Claude to reflow; the fit addon's size after a
  container change is the value to send.
- The trust dialog appears in every new worktree, so the first thing a user sees in a new agent's
  terminal is that dialog (PLAN §5.5).
