// The provider seam (D10, PLAN §5): everything provider-specific sits behind a ProviderAdapter in
// src/providers/<name>/. The rest of the server sees AgentEvents and ToolCategories only.
import type { AgentEvent, Provider, ToolCategory } from '@micro-minds/shared';

/** What a spawn needs to know to inject hooks for one session (PLAN §5.2). */
export interface LaunchContext {
  /** Our session id (a ULID). */
  sessionId: string;
  /** The loopback server base URL, e.g. `http://127.0.0.1:4317`. */
  serverUrl: string;
  /** The session's hook token: it goes into the PTY env only, never into args or files. */
  hookToken: string;
  /** Absolute directory for per-session files (`$MICROMINDS_HOME/sessions/<id>`), never the worktree. */
  sessionDir: string;
  worktreePath: string;
  /**
   * One argv element, as is (no quoting). The spawn uses no shell. A `.cmd` shim (`resolveBinary`
   * kind `cmd`) only runs through cmd.exe, which re-parses the line (twice for a shim forwarding
   * `%*`), so no escaping keeps any argument safe and whole: the spawn (task 2.6) runs the shim's
   * real target instead, or refuses to start and says why.
   */
  firstPrompt?: string;
}

/** How to start the CLI for one session. */
export interface LaunchSpec {
  args: string[];
  env: Record<string, string>;
  /** Written by the caller into `sessionDir` under `name` (a plain file name). */
  files: Array<{ name: string; content: string }>;
}

/** Everything an adapter may stamp on an event: ids and time come from the server. */
export interface NormalizeContext {
  sessionId: string;
  /** ms epoch, when the server received the payload. */
  receivedAt: number;
  /** A fresh ULID per call. */
  newId: () => string;
}

export interface ProviderAdapter {
  readonly id: Provider;
  /** A bare command name (`claude`): no path, no extension. The registry resolves it. */
  readonly binary: { readonly command: string; readonly versionArgs: readonly string[] };
  /** How events reach the server; `none` means terminal-only (PLAN §5.4). */
  readonly hooks: 'http' | 'relay' | 'none';
  /** The provider's tool names and their categories; unmapped tools are `other`. */
  readonly toolCategories: Readonly<Record<string, ToolCategory>>;
  launch(ctx: LaunchContext): LaunchSpec;
  /**
   * Raw hook payload → events. Facts only (hard rule 6): kind, tool category, errorClass. An
   * unrecognized payload becomes kind `unknown` (hard rule 7). Never throws.
   */
  normalize(raw: unknown, ctx: NormalizeContext): AgentEvent[];
}
