// PLAN task 0.3: proves node-pty installs and spawns through the platform PTY
// (ConPTY on Windows) on every OS in the CI matrix.
import { spawn } from 'node-pty';
import { describe, expect, it } from 'vitest';

const MARKER = 'micro-minds-pty-ok';

function shellCommand(): { file: string; args: string[] } {
  return process.platform === 'win32'
    ? { file: 'cmd.exe', args: ['/d', '/s', '/c', `echo ${MARKER}`] }
    : { file: '/bin/sh', args: ['-c', `echo ${MARKER}`] };
}

describe('node-pty smoke test', () => {
  it('spawns a shell in a PTY, captures output and reports a clean exit', async () => {
    const { file, args } = shellCommand();
    const term = spawn(file, args, {
      name: 'xterm-256color',
      cols: 80,
      rows: 24,
      cwd: process.cwd(),
      env: process.env,
    });

    let output = '';
    term.onData((data) => {
      output += data;
    });

    const exitCode = await new Promise<number>((resolve) => {
      term.onExit(({ exitCode: code }) => resolve(code));
    });

    expect(exitCode).toBe(0);
    expect(output).toContain(MARKER);
  }, 15_000);
});
