// Task 2.5: WorktreeManager (PLAN §5.5 steps 2 and 6, D5, D12, ADR 0012, hard rules 10 and 11).
// Every test runs against temporary git repos under a fresh temp root, with `home` (the
// `$MICROMINDS_HOME` value) passed in as config. No provider CLI runs; no real home is touched.
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  branchExists,
  entriesUnder,
  git,
  type HostileVariant,
  initRepo,
  isInside,
  isRegistered,
  linkDir,
  makeBystander,
  makeHostile,
  makeTempRoot,
  microMindsBranches,
  rawGit,
  removeTempRoot,
  samePath,
  sessionId,
} from './worktree-manager.test-helpers.ts';
import type { WorktreeManager } from './worktree-manager.ts';
import { createWorktreeManager, WorktreeError } from './worktree-manager.ts';

const GIT_TIMEOUT = 60_000;

/** Codes that mean "this path is not one of ours" (C5, C9, C10). */
const REFUSED_PATH_CODES = ['outside_root', 'not_registered'];

let tmp: string;
let home: string;
let worktreesRoot: string;
let manager: WorktreeManager;

beforeEach(() => {
  tmp = makeTempRoot();
  home = path.join(tmp, 'home');
  worktreesRoot = path.join(home, 'worktrees');
  manager = createWorktreeManager({ home });
});

afterEach(() => {
  vi.unstubAllEnvs();
  removeTempRoot(tmp);
});

async function rejection(promise: Promise<unknown>): Promise<WorktreeError> {
  try {
    await promise;
  } catch (error: unknown) {
    expect(error).toBeInstanceOf(WorktreeError);
    if (error instanceof WorktreeError) return error;
  }
  throw new Error('expected the promise to reject with a WorktreeError');
}

async function expectRefusedPath(promise: Promise<unknown>): Promise<void> {
  const error = await rejection(promise);
  expect(REFUSED_PATH_CODES).toContain(error.code);
}

/** The repo slug a created worktree landed under (`<root>/<slug>/<sessionId>`). */
function slugOf(worktreePath: string): string {
  return path.basename(path.dirname(worktreePath));
}

describe('WorktreeManager', { timeout: GIT_TIMEOUT }, () => {
  describe('create (C1)', () => {
    it('creates <home>/worktrees/<repo-slug>/<sessionId> on a new branch micro-minds/<sessionId>', async () => {
      const repo = initRepo(path.join(tmp, 'repos', 'app'));
      const id = sessionId(1);

      const created = await manager.create({ repoPath: repo, sessionId: id });

      expect(created.branch).toBe(`micro-minds/${id}`);
      expect(path.isAbsolute(created.path)).toBe(true);
      expect(path.basename(created.path)).toBe(id);
      expect(samePath(path.dirname(path.dirname(created.path)), worktreesRoot)).toBe(true);
      expect(fs.readFileSync(path.join(created.path, 'README.md'), 'utf8')).toBe('hello\n');
      expect(isRegistered(repo, created.path)).toBe(true);
      expect(branchExists(repo, `micro-minds/${id}`)).toBe(true);
      expect(git(created.path, ['rev-parse', '--abbrev-ref', 'HEAD'])).toBe(`micro-minds/${id}`);
    });

    it('uses the home from its config and never reads MICROMINDS_HOME from the environment', async () => {
      const envHome = path.join(tmp, 'env-home');
      vi.stubEnv('MICROMINDS_HOME', envHome);
      const repo = initRepo(path.join(tmp, 'repos', 'app'));

      const created = await manager.create({ repoPath: repo, sessionId: sessionId(1) });

      expect(isInside(worktreesRoot, created.path)).toBe(true);
      expect(fs.existsSync(envHome)).toBe(false);
    });
  });

  describe('create refusals (C2, C3)', () => {
    it.each([
      { name: 'an existing directory that is not a git repository', make: true },
      { name: 'a path that does not exist', make: false },
    ])('refuses $name with not_a_repo and creates nothing', async ({ make }) => {
      const notRepo = path.join(tmp, 'plain-dir');
      if (make) fs.mkdirSync(notRepo);

      const error = await rejection(manager.create({ repoPath: notRepo, sessionId: sessionId(1) }));

      expect(error.code).toBe('not_a_repo');
      expect(error.message).not.toBe('');
      expect(entriesUnder(worktreesRoot)).toEqual([]);
    });

    it.each([
      { name: 'dot-dot', id: '..' },
      { name: 'a forward slash', id: 'a/b' },
      { name: 'a backslash', id: 'a\\b' },
      { name: 'the empty string', id: '' },
      { name: 'a traversal to a ULID', id: `../${sessionId(1)}` },
      { name: 'too short to be a ULID', id: sessionId(1).slice(1) },
      { name: 'too long to be a ULID', id: `${sessionId(1)}0` },
    ])('refuses a session id that is $name before running git', async ({ id }) => {
      const repo = initRepo(path.join(tmp, 'repos', 'app'));

      const error = await rejection(manager.create({ repoPath: repo, sessionId: id }));

      expect(error.code).toBe('invalid_session_id');
      expect(entriesUnder(worktreesRoot)).toEqual([]);
      expect(microMindsBranches(repo)).toEqual([]);
    });

    it('checks the session id before touching the repo (a bad id wins over a bad repo)', async () => {
      const error = await rejection(
        manager.create({ repoPath: path.join(tmp, 'nowhere'), sessionId: '..' }),
      );
      expect(error.code).toBe('invalid_session_id');
    });
  });

  describe('repo slug (C4)', () => {
    const SLUG = /^[a-z0-9][a-z0-9-]*$/;
    const MAX_SLUG = 64;

    it.each([
      { name: 'a plain name', dir: 'app' },
      { name: 'upper case', dir: 'MyApp' },
      { name: 'spaces', dir: 'my cool repo' },
      { name: 'dots', dir: 'my.repo.v2' },
      { name: 'a leading dot', dir: '.hidden' },
      { name: 'a leading dash', dir: '-dash-first' },
      { name: 'non-ASCII characters', dir: 'répo-日本語' },
      { name: 'only non-ASCII characters', dir: '日本語' },
      { name: 'only punctuation', dir: '___' },
      { name: 'a very long name', dir: `long-${'x'.repeat(120)}` },
    ])('gives a valid, short slug for $name', async ({ dir }) => {
      const repo = initRepo(path.join(tmp, 'repos', dir));

      const created = await manager.create({ repoPath: repo, sessionId: sessionId(1) });
      const slug = slugOf(created.path);

      expect(slug).toMatch(SLUG);
      expect(slug.length).toBeLessThanOrEqual(MAX_SLUG);
    });

    it('gives the same slug however the repo path is spelled', async () => {
      const repo = initRepo(path.join(tmp, 'repos', 'app'));
      const spellings = [
        repo,
        path.relative(process.cwd(), repo),
        `${repo}${path.sep}`,
        path.join(repo, 'sub', '..'),
      ];

      const slugs: string[] = [];
      for (const [i, repoPath] of spellings.entries()) {
        const created = await manager.create({ repoPath, sessionId: sessionId(i + 1) });
        slugs.push(slugOf(created.path));
      }

      expect(new Set(slugs).size).toBe(1);
    });

    it('gives different slugs to two repos with the same directory name', async () => {
      const a = initRepo(path.join(tmp, 'one', 'app'));
      const b = initRepo(path.join(tmp, 'two', 'app'));

      const wa = await manager.create({ repoPath: a, sessionId: sessionId(1) });
      const wb = await manager.create({ repoPath: b, sessionId: sessionId(2) });

      expect(slugOf(wa.path)).not.toBe(slugOf(wb.path));
    });
  });

  describe('paths stay under <home>/worktrees (C5)', () => {
    it('every created and listed path resolves under the root', async () => {
      const repo = initRepo(path.join(tmp, 'repos', 'app'));
      const created = await manager.create({ repoPath: repo, sessionId: sessionId(1) });
      const listed = await manager.list(repo);

      for (const p of [created.path, ...listed.map((w) => w.path)]) {
        expect(isInside(worktreesRoot, path.resolve(p))).toBe(true);
      }
    });

    it.each([
      { name: 'the worktrees root itself', at: () => worktreesRoot },
      { name: 'home itself', at: () => home },
      { name: 'a directory outside home', at: () => path.join(tmp, 'outside') },
      { name: 'a path that climbs out with ..', at: () => path.join(worktreesRoot, '..', 'x') },
      {
        name: 'a sibling whose name only starts like the root',
        at: () => `${worktreesRoot}-evil`,
      },
    ])('the dirty check refuses $name', async ({ at }) => {
      const target = at();
      fs.mkdirSync(target, { recursive: true });

      await expectRefusedPath(manager.isDirty(target));
    });
  });

  describe('list (C6)', () => {
    it("returns only the repo's worktrees under the root, with path, branch and session id", async () => {
      const repo = initRepo(path.join(tmp, 'repos', 'app'));
      const other = initRepo(path.join(tmp, 'repos', 'other'));
      const w1 = await manager.create({ repoPath: repo, sessionId: sessionId(1) });
      const w2 = await manager.create({ repoPath: repo, sessionId: sessionId(2) });
      await manager.create({ repoPath: other, sessionId: sessionId(3) });
      const elsewhere = path.join(tmp, 'elsewhere-wt');
      git(repo, ['worktree', 'add', '-b', 'side', '--', elsewhere]);

      const listed = await manager.list(repo);

      expect(listed).toHaveLength(2);
      const byId = new Map(listed.map((w) => [w.sessionId, w]));
      for (const [id, created] of [
        [sessionId(1), w1],
        [sessionId(2), w2],
      ] as const) {
        const entry = byId.get(id);
        expect(entry?.branch).toBe(`micro-minds/${id}`);
        expect(entry !== undefined && samePath(entry.path, created.path)).toBe(true);
      }
      expect(listed.some((w) => samePath(w.path, repo))).toBe(false);
      expect(listed.some((w) => samePath(w.path, elsewhere))).toBe(false);
    });

    it('returns an empty list for a repo with no managed worktrees', async () => {
      const repo = initRepo(path.join(tmp, 'repos', 'app'));
      await expect(manager.list(repo)).resolves.toEqual([]);
    });
  });

  describe('dirty check (C7)', () => {
    it.each([
      { name: 'clean', dirty: false, change: (_wt: string) => {} },
      {
        name: 'a modified tracked file',
        dirty: true,
        change: (wt: string) => fs.writeFileSync(path.join(wt, 'README.md'), 'changed\n'),
      },
      {
        name: 'a staged new file',
        dirty: true,
        change: (wt: string) => {
          fs.writeFileSync(path.join(wt, 'staged.txt'), 'x\n');
          git(wt, ['add', '--', 'staged.txt']);
        },
      },
      {
        name: 'an untracked file',
        dirty: true,
        change: (wt: string) => fs.writeFileSync(path.join(wt, 'new.txt'), 'x\n'),
      },
    ])('reports $name as dirty=$dirty', async ({ dirty, change }) => {
      const repo = initRepo(path.join(tmp, 'repos', 'app'));
      const created = await manager.create({ repoPath: repo, sessionId: sessionId(1) });
      change(created.path);

      await expect(manager.isDirty(created.path)).resolves.toBe(dirty);
    });
  });

  describe('remove (C8)', () => {
    it('removes a clean worktree without confirmation and keeps its branch', async () => {
      const repo = initRepo(path.join(tmp, 'repos', 'app'));
      const id = sessionId(1);
      const created = await manager.create({ repoPath: repo, sessionId: id });

      await manager.remove({ repoPath: repo, worktreePath: created.path });

      expect(isRegistered(repo, created.path)).toBe(false);
      expect(fs.existsSync(created.path)).toBe(false);
      expect(branchExists(repo, `micro-minds/${id}`)).toBe(true);
    });

    it('refuses a dirty worktree without confirmation and leaves it intact', async () => {
      const repo = initRepo(path.join(tmp, 'repos', 'app'));
      const created = await manager.create({ repoPath: repo, sessionId: sessionId(1) });
      const work = path.join(created.path, 'work.txt');
      fs.writeFileSync(work, 'unsaved\n');

      const error = await rejection(manager.remove({ repoPath: repo, worktreePath: created.path }));

      expect(error.code).toBe('dirty');
      expect(isRegistered(repo, created.path)).toBe(true);
      expect(fs.readFileSync(work, 'utf8')).toBe('unsaved\n');
    });

    it.each([
      { name: 'an untracked file', staged: false },
      { name: 'a staged file', staged: true },
    ])(
      'removes a dirty worktree ($name) with confirmation and keeps its branch',
      async ({ staged }) => {
        const repo = initRepo(path.join(tmp, 'repos', 'app'));
        const id = sessionId(1);
        const created = await manager.create({ repoPath: repo, sessionId: id });
        fs.writeFileSync(path.join(created.path, 'work.txt'), 'unsaved\n');
        if (staged) git(created.path, ['add', '--', 'work.txt']);

        await manager.remove({ repoPath: repo, worktreePath: created.path, confirm: true });

        expect(isRegistered(repo, created.path)).toBe(false);
        expect(fs.existsSync(created.path)).toBe(false);
        expect(branchExists(repo, `micro-minds/${id}`)).toBe(true);
      },
    );

    it('keeps commits made on the branch after removal', async () => {
      const repo = initRepo(path.join(tmp, 'repos', 'app'));
      const id = sessionId(1);
      const created = await manager.create({ repoPath: repo, sessionId: id });
      fs.writeFileSync(path.join(created.path, 'feature.txt'), 'done\n');
      git(created.path, ['add', '--', 'feature.txt']);
      git(created.path, ['commit', '--quiet', '-m', 'feature']);
      const head = git(created.path, ['rev-parse', 'HEAD']);

      await manager.remove({ repoPath: repo, worktreePath: created.path });

      expect(git(repo, ['rev-parse', `refs/heads/micro-minds/${id}`])).toBe(head);
    });
  });

  describe('remove refuses paths that are not our registered worktrees (C9)', () => {
    it('refuses an ordinary directory under the root and deletes nothing', async () => {
      const repo = initRepo(path.join(tmp, 'repos', 'app'));
      const created = await manager.create({ repoPath: repo, sessionId: sessionId(1) });
      const impostor = makeBystander(path.join(path.dirname(created.path), sessionId(2)));

      await expectRefusedPath(
        manager.remove({ repoPath: repo, worktreePath: impostor.dir, confirm: true }),
      );

      expect(fs.readFileSync(impostor.file, 'utf8')).toBe('precious\n');
    });

    it('refuses a registered worktree of the repo that lies outside the root, and keeps it', async () => {
      const repo = initRepo(path.join(tmp, 'repos', 'app'));
      const outside = path.join(tmp, 'outside-wt');
      git(repo, ['worktree', 'add', '-b', 'side', '--', outside]);

      await expectRefusedPath(
        manager.remove({ repoPath: repo, worktreePath: outside, confirm: true }),
      );

      expect(isRegistered(repo, outside)).toBe(true);
      expect(fs.existsSync(path.join(outside, 'README.md'))).toBe(true);
    });

    it("refuses the repo's main worktree", async () => {
      const repo = initRepo(path.join(tmp, 'repos', 'app'));

      await expectRefusedPath(
        manager.remove({ repoPath: repo, worktreePath: repo, confirm: true }),
      );

      expect(fs.existsSync(path.join(repo, 'README.md'))).toBe(true);
    });

    it("refuses another repo's worktree under the root, and keeps it", async () => {
      const repo = initRepo(path.join(tmp, 'repos', 'app'));
      const other = initRepo(path.join(tmp, 'repos', 'other'));
      const theirs = await manager.create({ repoPath: other, sessionId: sessionId(1) });

      await expectRefusedPath(
        manager.remove({ repoPath: repo, worktreePath: theirs.path, confirm: true }),
      );

      expect(isRegistered(other, theirs.path)).toBe(true);
      expect(fs.existsSync(path.join(theirs.path, 'README.md'))).toBe(true);
    });
  });

  describe('remove never follows symlinks or junctions (C10)', () => {
    it('refuses a link under the root that points to a registered worktree outside it', async () => {
      const repo = initRepo(path.join(tmp, 'repos', 'app'));
      const created = await manager.create({ repoPath: repo, sessionId: sessionId(1) });
      const outside = path.join(tmp, 'outside-wt');
      git(repo, ['worktree', 'add', '-b', 'side', '--', outside]);
      const keep = path.join(outside, 'keep-me.txt');
      fs.writeFileSync(keep, 'precious\n');
      const link = path.join(path.dirname(created.path), sessionId(2));
      linkDir(outside, link);

      await expectRefusedPath(
        manager.remove({ repoPath: repo, worktreePath: link, confirm: true }),
      );

      expect(fs.readFileSync(keep, 'utf8')).toBe('precious\n');
      expect(isRegistered(repo, outside)).toBe(true);
    });

    it('refuses a link under the root that points to a plain directory outside it', async () => {
      const repo = initRepo(path.join(tmp, 'repos', 'app'));
      const created = await manager.create({ repoPath: repo, sessionId: sessionId(1) });
      const target = makeBystander(path.join(tmp, 'outside-plain'));
      const link = path.join(path.dirname(created.path), sessionId(2));
      linkDir(target.dir, link);

      await expectRefusedPath(
        manager.remove({ repoPath: repo, worktreePath: link, confirm: true }),
      );

      expect(fs.readFileSync(target.file, 'utf8')).toBe('precious\n');
    });

    it('removes a worktree containing a link to outside without touching the target', async () => {
      const repo = initRepo(path.join(tmp, 'repos', 'app'));
      const created = await manager.create({ repoPath: repo, sessionId: sessionId(1) });
      const target = makeBystander(path.join(tmp, 'outside-plain'));
      linkDir(target.dir, path.join(created.path, 'escape'));

      await manager.remove({ repoPath: repo, worktreePath: created.path, confirm: true });

      expect(isRegistered(repo, created.path)).toBe(false);
      expect(fs.existsSync(created.path)).toBe(false);
      expect(fs.readFileSync(target.file, 'utf8')).toBe('precious\n');
    });
  });

  describe('git hardening against a hostile repo (C11)', () => {
    const variants: HostileVariant[] = ['repo-hooks-dir', 'core-hooksPath'];

    it.each(variants)(
      'control: plain git in a hostile repo (%s) does run the planted commands',
      (variant) => {
        const repo = initRepo(path.join(tmp, 'repos', 'app'));
        const marker = path.join(tmp, 'marker.txt');
        makeHostile(repo, marker, variant);

        rawGit(repo, ['worktree', 'add', '-b', 'control', '--', path.join(tmp, 'control-wt')]);
        rawGit(repo, ['status', '--porcelain']);

        const fired = fs.readFileSync(marker, 'utf8');
        expect(fired).toContain('post-checkout');
        expect(fired).toContain('fsmonitor');
      },
    );

    it.each(variants)(
      'create, list, dirty check and remove run no fsmonitor command and no hook (%s)',
      async (variant) => {
        const repo = initRepo(path.join(tmp, 'repos', 'app'));
        const marker = path.join(tmp, 'marker.txt');
        makeHostile(repo, marker, variant);
        const id = sessionId(1);

        const created = await manager.create({ repoPath: repo, sessionId: id });
        expect(fs.existsSync(marker)).toBe(false);

        const listed = await manager.list(repo);
        expect(listed.map((w) => w.sessionId)).toEqual([id]);
        expect(fs.existsSync(marker)).toBe(false);

        await expect(manager.isDirty(created.path)).resolves.toBe(false);
        fs.writeFileSync(path.join(created.path, 'README.md'), 'changed\n');
        await expect(manager.isDirty(created.path)).resolves.toBe(true);
        expect(fs.existsSync(marker)).toBe(false);

        await manager.remove({ repoPath: repo, worktreePath: created.path, confirm: true });
        expect(isRegistered(repo, created.path)).toBe(false);
        expect(fs.existsSync(marker)).toBe(false);
      },
    );
  });

  describe('argv only, paths after -- (C12)', () => {
    // Characters a shell or git's option parser would act on. Windows forbids `"` in file names.
    const nasty =
      process.platform === 'win32'
        ? `-x 'q' $HOME; & (a) %PATH%`
        : `-x 'q' "d" $HOME; & (a) \`id\``;

    it('works with a repo path and a home path full of shell and option characters', async () => {
      const weirdHome = path.join(tmp, `home ${nasty}`);
      const weirdManager = createWorktreeManager({ home: weirdHome });
      const repo = initRepo(path.join(tmp, `-repo ${nasty}`));
      const id = sessionId(1);

      const created = await weirdManager.create({ repoPath: repo, sessionId: id });
      expect(isInside(path.join(weirdHome, 'worktrees'), created.path)).toBe(true);
      expect(isRegistered(repo, created.path)).toBe(true);

      const listed = await weirdManager.list(repo);
      expect(listed.map((w) => w.sessionId)).toEqual([id]);

      fs.writeFileSync(path.join(created.path, 'new.txt'), 'x\n');
      await expect(weirdManager.isDirty(created.path)).resolves.toBe(true);

      await weirdManager.remove({ repoPath: repo, worktreePath: created.path, confirm: true });
      expect(isRegistered(repo, created.path)).toBe(false);
      expect(branchExists(repo, `micro-minds/${id}`)).toBe(true);
    });
  });

  describe('native paths (C13)', () => {
    it('returns absolute, normalized paths from create and list', async () => {
      const repo = initRepo(path.join(tmp, 'repos', 'app'));
      const created = await manager.create({ repoPath: repo, sessionId: sessionId(1) });
      const listed = await manager.list(repo);

      for (const p of [created.path, ...listed.map((w) => w.path)]) {
        expect(path.isAbsolute(p)).toBe(true);
        expect(p).toBe(path.normalize(p));
        if (process.platform === 'win32') expect(p).not.toContain('/');
      }
    });

    it('accepts a worktree path spelled with forward slashes and a trailing separator', async () => {
      const repo = initRepo(path.join(tmp, 'repos', 'app'));
      const created = await manager.create({ repoPath: repo, sessionId: sessionId(1) });
      const spelled = `${created.path.split(path.sep).join('/')}/`;

      await expect(manager.isDirty(spelled)).resolves.toBe(false);
      await manager.remove({ repoPath: repo, worktreePath: spelled });

      expect(isRegistered(repo, created.path)).toBe(false);
    });

    it.runIf(process.platform === 'win32')(
      '(Windows only) drive-letter and case differences do not make a worktree look unregistered',
      async () => {
        // Upper-case the whole path, then lower-case the drive letter (C:/Temp/x → c:/TEMP/X).
        const flip = (p: string): string =>
          p.toUpperCase().replace(/^([A-Z]):/, (_m, d: string) => `${d.toLowerCase()}:`);
        const repo = initRepo(path.join(tmp, 'repos', 'app'));
        const flippedManager = createWorktreeManager({ home: flip(home) });
        const created = await manager.create({ repoPath: repo, sessionId: sessionId(1) });

        const listed = await flippedManager.list(flip(repo));
        expect(listed.map((w) => w.sessionId)).toEqual([sessionId(1)]);

        await expect(flippedManager.isDirty(flip(created.path))).resolves.toBe(false);
        await flippedManager.remove({ repoPath: flip(repo), worktreePath: flip(created.path) });
        expect(isRegistered(repo, created.path)).toBe(false);
      },
    );
  });

  describe('failures (C14)', () => {
    it('never throws synchronously; bad input becomes a rejected promise', async () => {
      const calls: Array<() => Promise<unknown>> = [
        () => manager.create({ repoPath: '', sessionId: '' }),
        () => manager.list(''),
        () => manager.isDirty(''),
        () => manager.remove({ repoPath: '', worktreePath: '' }),
        () => manager.list(path.join(tmp, 'missing')),
        () => manager.isDirty(path.join(worktreesRoot, 'nope', sessionId(1))),
      ];
      for (const call of calls) {
        let pending: Promise<unknown> | undefined;
        expect(() => {
          pending = call();
        }).not.toThrow();
        expect(pending).toBeInstanceOf(Promise);
        if (pending !== undefined) await rejection(pending);
      }
    });

    it('rejects when git fails (the branch already exists) and leaves that branch alone', async () => {
      const repo = initRepo(path.join(tmp, 'repos', 'app'));
      const id = sessionId(1);
      git(repo, ['branch', `micro-minds/${id}`]);
      const before = git(repo, ['rev-parse', `refs/heads/micro-minds/${id}`]);

      await rejection(manager.create({ repoPath: repo, sessionId: id }));

      expect(git(repo, ['rev-parse', `refs/heads/micro-minds/${id}`])).toBe(before);
      expect(entriesUnder(worktreesRoot).filter((e) => e.endsWith(id))).toEqual([]);
    });

    it('rejects a second create for the same session and keeps the first worktree', async () => {
      const repo = initRepo(path.join(tmp, 'repos', 'app'));
      const id = sessionId(1);
      const first = await manager.create({ repoPath: repo, sessionId: id });
      const work = path.join(first.path, 'work.txt');
      fs.writeFileSync(work, 'unsaved\n');

      await rejection(manager.create({ repoPath: repo, sessionId: id }));

      expect(isRegistered(repo, first.path)).toBe(true);
      expect(fs.readFileSync(work, 'utf8')).toBe('unsaved\n');
    });

    it('rejects when the target directory already exists and leaves its contents alone', async () => {
      const repo = initRepo(path.join(tmp, 'repos', 'app'));
      const first = await manager.create({ repoPath: repo, sessionId: sessionId(1) });
      const squatter = makeBystander(path.join(path.dirname(first.path), sessionId(2)));

      await rejection(manager.create({ repoPath: repo, sessionId: sessionId(2) }));

      expect(fs.readFileSync(squatter.file, 'utf8')).toBe('precious\n');
      expect(branchExists(repo, `micro-minds/${sessionId(2)}`)).toBe(false);
    });

    it('rejects the dirty check and removal of a worktree deleted out from under us', async () => {
      const repo = initRepo(path.join(tmp, 'repos', 'app'));
      const id = sessionId(1);
      const created = await manager.create({ repoPath: repo, sessionId: id });
      fs.rmSync(created.path, { recursive: true, force: true });

      await rejection(manager.isDirty(created.path));
      await rejection(
        manager.remove({ repoPath: repo, worktreePath: created.path, confirm: true }),
      );

      expect(branchExists(repo, `micro-minds/${id}`)).toBe(true);
      expect(fs.existsSync(path.join(repo, 'README.md'))).toBe(true);
    });

    it('rejects list for a repo deleted out from under us', async () => {
      const repo = initRepo(path.join(tmp, 'repos', 'app'));
      const created = await manager.create({ repoPath: repo, sessionId: sessionId(1) });
      fs.rmSync(repo, { recursive: true, force: true, maxRetries: 5 });

      await rejection(manager.list(repo));

      expect(fs.existsSync(path.join(created.path, 'README.md'))).toBe(true);
    });
  });
});
