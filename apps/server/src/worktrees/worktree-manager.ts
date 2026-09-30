// WorktreeManager (PLAN §5.5 steps 2 and 6, D5, D12/ADR 0012): one git worktree per session at
// `<home>/worktrees/<repo-slug>/<sessionId>` on branch `micro-minds/<sessionId>`.
//
// Removal is the dangerous part (hard rule 11, threat model "Worktree manager"). A path is only
// ours when it is spelled `<root>/<slug>/<ULID>`, is not a link, resolves to that same place
// after real-path resolution (so no link anywhere on the way points outside the root), and is
// registered in the repo's `git worktree list`. It is then removed with `git worktree remove`,
// never a recursive delete, and a dirty tree needs the caller's explicit confirmation. Removal
// keeps the branch. Every git command goes through the hardened runner in git.ts.
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { ULID_PATTERN } from '@micro-minds/shared';
import { runGit } from './git.ts';

export const WORKTREE_ERROR_CODES = [
  'invalid_session_id',
  'not_a_repo',
  'outside_root',
  'not_registered',
  'missing',
  'exists',
  'dirty',
  'locked',
  'git_failed',
  'io_failed',
] as const;

export type WorktreeErrorCode = (typeof WORKTREE_ERROR_CODES)[number];

export class WorktreeError extends Error {
  readonly code: WorktreeErrorCode;

  constructor(code: WorktreeErrorCode, message: string) {
    super(message);
    this.name = 'WorktreeError';
    this.code = code;
  }
}

export interface WorktreeManagerConfig {
  /** `$MICROMINDS_HOME`, already resolved by the caller's config. */
  home: string;
}

export interface CreatedWorktree {
  path: string;
  branch: string;
}

export interface ListedWorktree {
  path: string;
  /** Short branch name, or null when the worktree's HEAD is detached. */
  branch: string | null;
  sessionId: string;
}

export interface WorktreeManager {
  create(input: { repoPath: string; sessionId: string }): Promise<CreatedWorktree>;
  list(repoPath: string): Promise<ListedWorktree[]>;
  isDirty(worktreePath: string): Promise<boolean>;
  remove(input: { repoPath: string; worktreePath: string; confirm?: boolean }): Promise<void>;
}

export const BRANCH_PREFIX = 'micro-minds/';

/** Slug rules: lowercase letters, digits and `-`; a name part, then a hash of the repo's path. */
const SLUG = /^[a-z0-9][a-z0-9-]*$/;
const SLUG_NAME_MAX = 40;
const SLUG_HASH_LENGTH = 8;

const isWindows = process.platform === 'win32';

/** A comparison key for a path: normalized, and case-folded on Windows. */
function pathKey(p: string): string {
  const normalized = path.normalize(p);
  return isWindows ? normalized.toLowerCase() : normalized;
}

/**
 * The repo slug: its directory name folded to `[a-z0-9-]` and shortened (Windows path limits,
 * ADR 0012), then a hash of its real top-level path, so two repos with the same name differ.
 */
export function repoSlug(realTopLevel: string): string {
  const name = path
    .basename(realTopLevel)
    .normalize('NFKD')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, SLUG_NAME_MAX)
    .replace(/-+$/, '');
  const hash = createHash('sha256')
    .update(pathKey(realTopLevel))
    .digest('hex')
    .slice(0, SLUG_HASH_LENGTH);
  return name === '' ? `repo-${hash}` : `${name}-${hash}`;
}

async function realPath(p: string): Promise<string | undefined> {
  try {
    return await fs.realpath(p);
  } catch {
    return undefined;
  }
}

async function isLink(p: string): Promise<boolean> {
  try {
    // Node reports Windows junctions as symbolic links too.
    return (await fs.lstat(p)).isSymbolicLink();
  } catch {
    return false;
  }
}

async function exists(p: string): Promise<boolean> {
  try {
    await fs.lstat(p);
    return true;
  } catch {
    return false;
  }
}

/** Every symlink or junction under `dir`, found without following any of them. */
async function linksUnder(dir: string): Promise<string[]> {
  const links: string[] = [];
  const pending = [dir];
  for (let current = pending.pop(); current !== undefined; current = pending.pop()) {
    for (const entry of await fs.readdir(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      // Dirents report Windows junctions as symbolic links too.
      if (entry.isSymbolicLink()) links.push(full);
      else if (entry.isDirectory()) pending.push(full);
    }
  }
  return links;
}

async function isDirectory(p: string): Promise<boolean> {
  try {
    return (await fs.stat(p)).isDirectory();
  } catch {
    return false;
  }
}

interface UnlinkedLink {
  link: string;
  target: string;
  isDir: boolean;
}

/** Recreates unlinked links after a failed removal; returns the ones it couldn't recreate. */
async function restoreLinks(unlinked: readonly UnlinkedLink[]): Promise<string[]> {
  const failed: string[] = [];
  for (const { link, target, isDir } of unlinked) {
    try {
      // A junction needs no privilege on Windows; the type is ignored elsewhere.
      await fs.symlink(target, link, isDir ? 'junction' : 'file');
    } catch {
      failed.push(link);
    }
  }
  return failed;
}

interface RegisteredWorktree {
  path: string;
  branch: string | null;
  locked: boolean;
}

/** Parses `git worktree list --porcelain -z`: NUL-separated fields, an empty field between entries. */
function parseWorktreeList(stdout: string): RegisteredWorktree[] {
  const entries: RegisteredWorktree[] = [];
  let current: RegisteredWorktree | undefined;
  for (const field of stdout.split('\0')) {
    if (field.startsWith('worktree ')) {
      current = {
        path: path.resolve(field.slice('worktree '.length)),
        branch: null,
        locked: false,
      };
      entries.push(current);
    } else if ((field === 'locked' || field.startsWith('locked ')) && current !== undefined) {
      current.locked = true;
    } else if (field.startsWith('branch ') && current !== undefined) {
      const ref = field.slice('branch '.length);
      current.branch = ref.startsWith('refs/heads/') ? ref.slice('refs/heads/'.length) : ref;
    }
  }
  return entries;
}

export function createWorktreeManager(config: WorktreeManagerConfig): WorktreeManager {
  const root = path.resolve(config.home, 'worktrees');

  /**
   * `[slug, sessionId]` when `p` is spelled `<root>/<slug>/<ULID>`, or the same under the real
   * root: git records worktree paths with links resolved, so a home reached through a symlink or
   * junction (or macOS `/var`) shows up in `git worktree list` under its real path.
   */
  async function segmentsOf(p: string): Promise<[string, string] | undefined> {
    const lexical = ownedSegments(p, root);
    if (lexical !== undefined) return lexical;
    const realRoot = await realPath(root);
    return realRoot === undefined ? undefined : ownedSegments(p, realRoot);
  }

  /** `[slug, sessionId]` when `p` is spelled `<base>/<slug>/<ULID>`, otherwise undefined. */
  function ownedSegments(p: string, base: string): [string, string] | undefined {
    const rel = path.relative(base, path.resolve(p));
    if (rel === '' || path.isAbsolute(rel)) return undefined;
    const parts = rel.split(path.sep);
    if (parts.length !== 2) return undefined;
    const [slug = '', id = ''] = parts;
    // Windows paths are case-insensitive, so a differently cased spelling is still ours.
    const slugKey = isWindows ? slug.toLowerCase() : slug;
    const idKey = isWindows ? id.toUpperCase() : id;
    if (!SLUG.test(slugKey) || !ULID_PATTERN.test(idKey)) return undefined;
    return [slug, id];
  }

  /** The repo's real top-level directory; `repoPath` must be that directory itself. */
  async function topLevel(repoPath: string): Promise<string> {
    const notARepo = new WorktreeError('not_a_repo', `Not a git repository: ${repoPath}`);
    if (repoPath === '') throw notARepo;
    const real = await realPath(path.resolve(repoPath));
    if (real === undefined || !(await fs.stat(real)).isDirectory()) throw notARepo;
    const result = await runGit(real, ['rev-parse', '--show-toplevel']);
    if (!result.ok) throw notARepo;
    const top = await realPath(path.resolve(result.stdout.trim()));
    if (top === undefined || pathKey(top) !== pathKey(real)) throw notARepo;
    return top;
  }

  /**
   * The real path of a worktree directory we own: spelled `<root>/<slug>/<ULID>`, not a link,
   * and resolving to exactly that place under the real root (no link on the way).
   */
  async function ownedWorktree(worktreePath: string): Promise<{ real: string; sessionId: string }> {
    const outside = new WorktreeError(
      'outside_root',
      `Not a micro-minds worktree path under ${root}: ${worktreePath}`,
    );
    if (worktreePath === '') throw outside;
    const segments = await segmentsOf(worktreePath);
    if (segments === undefined) throw outside;
    const lexical = path.resolve(worktreePath);
    if (await isLink(lexical)) throw outside;
    const real = await realPath(lexical);
    const realRoot = await realPath(root);
    if (real === undefined || realRoot === undefined) {
      throw new WorktreeError('missing', `Worktree does not exist: ${worktreePath}`);
    }
    if (pathKey(real) !== pathKey(path.join(realRoot, ...segments))) throw outside;
    return { real, sessionId: segments[1] };
  }

  async function registered(top: string): Promise<RegisteredWorktree[]> {
    const result = await runGit(top, ['worktree', 'list', '--porcelain', '-z']);
    if (!result.ok) {
      throw new WorktreeError('git_failed', `git worktree list failed: ${result.stderr}`);
    }
    return parseWorktreeList(result.stdout);
  }

  /** Unlinks the links under a worktree that git doesn't track, returning how to recreate them. */
  async function unlinkUntrackedLinks(realWorktree: string): Promise<UnlinkedLink[]> {
    const links = await linksUnder(realWorktree);
    if (links.length === 0) return [];
    const files = await runGit(realWorktree, ['ls-files', '-z', '--cached']);
    if (!files.ok) throw new WorktreeError('git_failed', `git ls-files failed: ${files.stderr}`);
    const tracked = new Set(files.stdout.split('\0'));
    const untracked = links.filter(
      (link) => !tracked.has(path.relative(realWorktree, link).split(path.sep).join('/')),
    );
    const recorded: UnlinkedLink[] = [];
    for (const link of untracked) {
      recorded.push({ link, target: await fs.readlink(link), isDir: await isDirectory(link) });
    }
    const unlinked: UnlinkedLink[] = [];
    try {
      for (const entry of recorded) {
        await fs.unlink(entry.link);
        unlinked.push(entry);
      }
    } catch (error: unknown) {
      await restoreLinks(unlinked);
      throw error;
    }
    return unlinked;
  }

  async function dirty(realWorktree: string): Promise<boolean> {
    const top = await runGit(realWorktree, ['rev-parse', '--show-toplevel']);
    const topReal = top.ok ? await realPath(path.resolve(top.stdout.trim())) : undefined;
    if (topReal === undefined || pathKey(topReal) !== pathKey(realWorktree)) {
      throw new WorktreeError('not_registered', `Not a git worktree: ${realWorktree}`);
    }
    // `--untracked-files=all` overrides a repo's `status.showUntrackedFiles=no`.
    const status = await runGit(realWorktree, [
      'status',
      '--porcelain=v1',
      '-z',
      '--untracked-files=all',
      '--ignore-submodules=none',
    ]);
    if (!status.ok) throw new WorktreeError('git_failed', `git status failed: ${status.stderr}`);
    return status.stdout !== '';
  }

  const manager: WorktreeManager = {
    async create({ repoPath, sessionId }) {
      if (!ULID_PATTERN.test(sessionId)) {
        throw new WorktreeError('invalid_session_id', 'The session id is not a ULID');
      }
      const top = await topLevel(repoPath);
      const slugDir = path.join(root, repoSlug(top));
      const target = path.join(slugDir, sessionId);
      if (ownedSegments(target, root) === undefined) {
        throw new WorktreeError('outside_root', `Refusing a worktree path outside ${root}`);
      }
      await fs.mkdir(slugDir, { recursive: true });
      const realRoot = await realPath(root);
      const realSlugDir = await realPath(slugDir);
      if (
        (await isLink(slugDir)) ||
        realRoot === undefined ||
        realSlugDir === undefined ||
        pathKey(realSlugDir) !== pathKey(path.join(realRoot, path.basename(slugDir)))
      ) {
        throw new WorktreeError('outside_root', `${slugDir} does not resolve under ${root}`);
      }
      if (await exists(target)) {
        throw new WorktreeError('exists', `The worktree directory already exists: ${target}`);
      }
      const branch = `${BRANCH_PREFIX}${sessionId}`;
      const result = await runGit(top, ['worktree', 'add', '-b', branch, '--', target]);
      if (!result.ok) {
        throw new WorktreeError('git_failed', `git worktree add failed: ${result.stderr}`);
      }
      return { path: target, branch };
    },

    async list(repoPath) {
      const top = await topLevel(repoPath);
      const out: ListedWorktree[] = [];
      for (const entry of await registered(top)) {
        const segments = await segmentsOf(entry.path);
        if (segments === undefined) continue;
        // The same spelling `create` returns: under the configured root, not git's real path.
        out.push({
          path: path.join(root, ...segments),
          branch: entry.branch,
          sessionId: segments[1],
        });
      }
      return out;
    },

    async isDirty(worktreePath) {
      const owned = await ownedWorktree(worktreePath);
      return dirty(owned.real);
    },

    async remove({ repoPath, worktreePath, confirm }) {
      const top = await topLevel(repoPath);
      const owned = await ownedWorktree(worktreePath);
      let entry: RegisteredWorktree | undefined;
      for (const candidate of await registered(top)) {
        const real = (await realPath(candidate.path)) ?? candidate.path;
        if (pathKey(real) === pathKey(owned.real)) entry = candidate;
      }
      if (entry === undefined) {
        throw new WorktreeError('not_registered', `Not a registered worktree of ${top}`);
      }
      if (entry.locked) {
        throw new WorktreeError('locked', 'The worktree is locked (git worktree unlock first)');
      }
      const isDirtyNow = await dirty(owned.real);
      if (isDirtyNow && confirm !== true) {
        throw new WorktreeError('dirty', 'The worktree has uncommitted or untracked changes');
      }
      // Git for Windows' `worktree remove` descends into junctions and deletes their targets'
      // contents, so untracked links (junctions are never tracked) are unlinked first: the link
      // itself, never what it points to, never recursively. Tracked symlinks stay, so the tree's
      // status doesn't change and git keeps its own check.
      const unlinked = await unlinkUntrackedLinks(owned.real);
      // --force only for a dirty tree the caller confirmed. Otherwise git itself refuses a tree
      // that became dirty after our check.
      const force = isDirtyNow ? ['--force'] : [];
      const result = await runGit(top, ['worktree', 'remove', ...force, '--', owned.real]);
      if (!result.ok) {
        const notRestored = await restoreLinks(unlinked);
        const detail =
          notRestored.length > 0 ? `; links not restored: ${notRestored.join(', ')}` : '';
        throw new WorktreeError(
          'git_failed',
          `git worktree remove failed: ${result.stderr}${detail}`,
        );
      }
    },
  };

  // Every rejection is a WorktreeError, filesystem failures (a race with a deletion) included.
  return {
    create: (input) => typed(manager.create(input)),
    list: (repoPath) => typed(manager.list(repoPath)),
    isDirty: (worktreePath) => typed(manager.isDirty(worktreePath)),
    remove: (input) => typed(manager.remove(input)),
  };
}

async function typed<T>(pending: Promise<T>): Promise<T> {
  try {
    return await pending;
  } catch (error: unknown) {
    if (error instanceof WorktreeError) throw error;
    throw new WorktreeError('io_failed', error instanceof Error ? error.message : String(error));
  }
}
