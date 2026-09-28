// Task 1.5: Claude Code in node-pty (ConPTY on Windows), inside a throwaway git worktree, shown in
// xterm.js in the browser, so a person can check that login, colors, resize and the alternate
// screen render correctly. Spike only: the real terminal drawer is task 3.3.
//
//   npm run spike:pty-view                 run claude (spends your tokens if you prompt it)
//   npm run spike:pty-view -- --shell      run cmd.exe (or $SHELL) instead, for a smoke test
//
// It creates a fresh scratch repo and a worktree of it under ~/.micro-minds-dev/spike/, starts the
// process there, and serves one page on 127.0.0.1 behind a random URL token. Output streams to the
// page over server-sent events; keystrokes and resizes come back as POSTs. The server uses Node
// built-ins and node-pty only; xterm.js comes from the web workspace's node_modules. The worktree
// is left in place (nothing is deleted automatically); the path and the command to remove it are
// printed.

import { execFileSync } from 'node:child_process';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { createRequire } from 'node:module';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node-pty';
import { resolveOnPath } from '../../evals/harness/reviewer/resolve-bin.ts';
import { createTarget } from './make-target.ts';
import { SINK_HOST, SPIKE_DIR } from './paths.ts';

const PORT = 47120;
const MAX_REPLAY_BYTES = 2 * 1024 * 1024;
const MAX_INPUT_BYTES = 64 * 1024;

// xterm.js is a declared dependency of apps/web (PLAN §3 stack); resolve it from there.
const webRequire = createRequire(
  fileURLToPath(new URL('../../apps/web/package.json', import.meta.url)),
);
const ASSETS: Record<string, { file: string; type: string }> = {
  'xterm.mjs': { file: webRequire.resolve('@xterm/xterm/lib/xterm.mjs'), type: 'text/javascript' },
  'xterm.css': {
    file: path.join(
      path.dirname(webRequire.resolve('@xterm/xterm/package.json')),
      'css',
      'xterm.css',
    ),
    type: 'text/css',
  },
  'addon-fit.mjs': {
    file: webRequire.resolve('@xterm/addon-fit/lib/addon-fit.mjs'),
    type: 'text/javascript',
  },
};

const PAGE = `<!doctype html>
<html><head><meta charset="utf-8"><title>micro-minds 1.5 pty view</title>
<link rel="stylesheet" href="xterm.css">
<style>html,body{margin:0;height:100%;background:#1e1e1e}#t{position:absolute;inset:8px}</style>
<script type="importmap">{"imports":{"@xterm/xterm":"./xterm.mjs","@xterm/addon-fit":"./addon-fit.mjs"}}</script>
</head><body><div id="t"></div>
<script type="module">
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
const term = new Terminal({ cursorBlink: true, allowProposedApi: false });
const fit = new FitAddon();
term.loadAddon(fit);
term.open(document.getElementById('t'));
const post = (p, body) => fetch(p, { method: 'POST', body });
const resize = () => { fit.fit(); post('resize?cols=' + term.cols + '&rows=' + term.rows, ''); };
window.addEventListener('resize', resize);
resize();
term.onData((d) => post('in', d));
const out = new EventSource('out');
out.onmessage = (e) => term.write(Uint8Array.from(atob(e.data), (c) => c.charCodeAt(0)));
out.addEventListener('exit', (e) => { term.write('\\r\\n[process exited: ' + e.data + ']\\r\\n'); out.close(); });
term.focus();
</script></body></html>`;

function sameToken(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

async function readBody(req: IncomingMessage, limit: number): Promise<Buffer | undefined> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
    size += buf.length;
    if (size > limit) return undefined;
    chunks.push(buf);
  }
  return Buffer.concat(chunks);
}

function childEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined) continue;
    if (key === 'CLAUDECODE' || key.startsWith('CLAUDE_CODE_') || key === 'CLAUDE_PROJECT_DIR') {
      continue;
    }
    env[key] = value;
  }
  return env;
}

function binary(useShell: boolean): string {
  if (useShell)
    return process.platform === 'win32'
      ? (process.env.ComSpec ?? 'cmd.exe')
      : (process.env.SHELL ?? '/bin/sh');
  const resolved = resolveOnPath('claude', {
    platform: process.platform,
    pathEnv: process.env.PATH,
    pathExt: process.env.PATHEXT,
    isFile: (p) => existsSync(p) && statSync(p).isFile(),
  });
  if (resolved === undefined || resolved.needsShell) {
    throw new Error('claude.exe (or a non-shim claude binary) not found on PATH');
  }
  return resolved.path;
}

function main(): void {
  const useShell = process.argv.includes('--shell');
  const stamp = Date.now();
  // A fresh scratch repo, and a throwaway worktree of it (PLAN §5.5 runs agents in worktrees).
  const base = path.join(SPIKE_DIR, 'targets', `pty-view-${stamp}`);
  createTarget(base);
  const worktree = path.join(SPIKE_DIR, 'worktrees', `pty-view-${stamp}`);
  execFileSync(
    'git',
    [
      '-c',
      'core.fsmonitor=false',
      'worktree',
      'add',
      '-q',
      '-b',
      `pty-view-${stamp}`,
      '--',
      worktree,
    ],
    { cwd: base, stdio: 'pipe' },
  );

  const pty = spawn(binary(useShell), [], {
    name: 'xterm-256color',
    cols: 100,
    rows: 30,
    cwd: worktree,
    env: childEnv(),
  });
  let replay = Buffer.alloc(0);
  const clients = new Set<ServerResponse>();
  let exitInfo: string | undefined;
  pty.onData((data) => {
    const bytes = Buffer.from(data, 'utf8');
    replay = Buffer.concat([replay, bytes]);
    if (replay.length > MAX_REPLAY_BYTES)
      replay = replay.subarray(replay.length - MAX_REPLAY_BYTES);
    for (const res of clients) res.write(`data: ${bytes.toString('base64')}\n\n`);
  });
  pty.onExit(({ exitCode }) => {
    exitInfo = `code ${exitCode}`;
    for (const res of clients) res.write(`event: exit\ndata: ${exitInfo}\n\n`);
  });

  const token = randomBytes(18).toString('base64url');
  const server = createServer((req, res) => {
    void (async () => {
      const host = req.headers.host;
      const port = (server.address() as AddressInfo).port;
      if (host !== `${SINK_HOST}:${port}` && host !== `localhost:${port}`) {
        res.writeHead(403).end();
        return;
      }
      const url = new URL(req.url ?? '/', `http://${SINK_HOST}:${port}`);
      const [, pathToken = '', name = ''] = url.pathname.split('/');
      if (!sameToken(pathToken, token)) {
        res.writeHead(404).end();
        return;
      }
      if (req.method === 'GET' && name === '') {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(PAGE);
      } else if (req.method === 'GET' && ASSETS[name] !== undefined) {
        const asset = ASSETS[name];
        res.writeHead(200, { 'content-type': asset.type }).end(readFileSync(asset.file));
      } else if (req.method === 'GET' && name === 'out') {
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store' });
        if (replay.length > 0) res.write(`data: ${replay.toString('base64')}\n\n`);
        if (exitInfo !== undefined) res.write(`event: exit\ndata: ${exitInfo}\n\n`);
        clients.add(res);
        req.on('close', () => clients.delete(res));
      } else if (req.method === 'POST' && name === 'in') {
        const body = await readBody(req, MAX_INPUT_BYTES);
        if (body === undefined) {
          res.writeHead(413).end();
          return;
        }
        if (exitInfo === undefined) pty.write(body.toString('utf8'));
        res.writeHead(204).end();
      } else if (req.method === 'POST' && name === 'resize') {
        const cols = Number(url.searchParams.get('cols'));
        const rows = Number(url.searchParams.get('rows'));
        if (
          Number.isInteger(cols) &&
          Number.isInteger(rows) &&
          cols > 1 &&
          rows > 1 &&
          cols < 1000 &&
          rows < 1000
        ) {
          if (exitInfo === undefined) pty.resize(cols, rows);
          res.writeHead(204).end();
        } else {
          res.writeHead(400).end();
        }
      } else {
        res.writeHead(404).end();
      }
    })().catch(() => {
      if (!res.headersSent) res.writeHead(500).end();
    });
  });

  server.listen(PORT, SINK_HOST, () => {
    const port = (server.address() as AddressInfo).port;
    console.log(`Running ${useShell ? 'a shell' : 'claude'} in ${worktree}`);
    console.log(`Open: http://${SINK_HOST}:${port}/${token}/`);
    console.log('Ctrl-C here to stop (it ends the process; the worktree is kept).');
    console.log(`Remove the worktree later with: git -C "${base}" worktree remove "${worktree}"`);
  });

  const stop = () => {
    if (exitInfo === undefined) {
      try {
        if (process.platform === 'win32') {
          execFileSync('taskkill', ['/PID', String(pty.pid), '/T', '/F'], { stdio: 'pipe' });
        } else {
          pty.kill();
        }
      } catch {
        // Already gone.
      }
    }
    for (const res of clients) res.end();
    server.close(() => process.exit(0));
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}

if (import.meta.main) {
  main();
}
