// What the server actually executes for a resolved provider binary (threat model, "Injection via
// repo path, name or first prompt"). A native executable runs as is. A `.cmd`/`.bat` shim would
// only run through cmd.exe, which re-parses every argument (the prompt, the settings path), so
// we never run one: we read npm's cmd-shim and run its real target instead (`node <script>` or
// the `.exe` it forwards to). A shim in any other shape is refused with the reason.
import fs from 'node:fs';
import path from 'node:path';
import { type BinaryLookup, type BinaryResolution, resolveCommand } from '../providers/registry.ts';

export type LaunchTarget =
  | { ok: true; file: string; prefixArgs: string[] }
  | { ok: false; reason: string };

/** npm's cmd-shim for a node script: `"%_prog%"  "%dp0%\<script>" %*`. */
const NODE_SCRIPT_SHIM = /"%_prog%"\s+"%dp0%\\([^"%\r\n]+)"\s+%\*/i;
/** npm's cmd-shim for a native executable: a line `"%dp0%\<file>.exe"   %*`. */
const NATIVE_SHIM = /^"%dp0%\\([^"%\r\n]+\.exe)"\s+%\*\s*$/im;

const SHIM_MAX_BYTES = 64 * 1024;

type Resolved = Extract<BinaryResolution, { ok: true }>;

export function launchTarget(
  resolved: Resolved,
  lookup: BinaryLookup,
  readText: (file: string) => string = readShim,
): LaunchTarget {
  if (resolved.kind !== 'cmd') return { ok: true, file: resolved.path, prefixArgs: [] };
  const refuse = (why: string): LaunchTarget => ({
    ok: false,
    reason: `${resolved.path} is a .cmd/.bat shim, which only runs through cmd.exe (it would re-parse our arguments); ${why}`,
  });
  let text: string;
  try {
    text = readText(resolved.path);
  } catch {
    return refuse('it could not be read to find its real target');
  }
  const dir = path.win32.dirname(resolved.path);
  const script = NODE_SCRIPT_SHIM.exec(text)?.[1];
  if (script !== undefined) {
    const scriptPath = path.win32.join(dir, script);
    if (!lookup.isFile(scriptPath)) return refuse(`its script ${scriptPath} does not exist`);
    const bundledNode = path.win32.join(dir, 'node.exe');
    if (lookup.isFile(bundledNode))
      return { ok: true, file: bundledNode, prefixArgs: [scriptPath] };
    const node = resolveCommand('node', lookup);
    if (!node.ok || node.kind !== 'exe') return refuse('node.exe was not found on PATH to run it');
    return { ok: true, file: node.path, prefixArgs: [scriptPath] };
  }
  const exe = NATIVE_SHIM.exec(text)?.[1];
  if (exe !== undefined) {
    const exePath = path.win32.join(dir, exe);
    if (!lookup.isFile(exePath)) return refuse(`its target ${exePath} does not exist`);
    return { ok: true, file: exePath, prefixArgs: [] };
  }
  return refuse('its real target could not be determined (not an npm cmd-shim)');
}

function readShim(file: string): string {
  const handle = fs.openSync(file, 'r');
  try {
    const buffer = Buffer.alloc(SHIM_MAX_BYTES);
    const read = fs.readSync(handle, buffer, 0, SHIM_MAX_BYTES, 0);
    return buffer.subarray(0, read).toString('utf8');
  } finally {
    fs.closeSync(handle);
  }
}
