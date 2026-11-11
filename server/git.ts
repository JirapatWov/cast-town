// GitService: read-only summaries for the TV/diff viewer, plus checkpoint/revert snapshots that never touch
// the user's HEAD, branches or index (all snapshot work happens in a throwaway GIT_INDEX_FILE), and jobs' own copies
// of a house (git worktrees): make, summarize, bring into the house, undo, remove.
import {
  chmodSync, closeSync, constants, copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, openSync, readdirSync, readFileSync,
  readlinkSync, renameSync, rmdirSync, rmSync, statSync, symlinkSync, writeFileSync,
} from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import type { BringPlan, DiscardResult, GitFileChange, GitSummary, JobWorktree, LeftoverBranch, Project, UndoneChanges } from '../shared/protocol';
import type { GitService } from './contracts';
import { exec, type ExecResult } from './exec';
import { errorMessage, isInside, log, UserError } from './util';

const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';
const DIFF_LIMIT = 400 * 1024;
const MAX_FILES = 1000;
const MAX_UNTRACKED_DIFFS = 150;
const MAX_UNTRACKED_BYTES = 1024 * 1024;
const RLT_DIR = '.rlt';
/** Pathspec limiting a command to the project folder (cwd) minus RLT's own artifacts. */
const PROJECT_PATHSPEC = ['--', '.', `:(exclude)${RLT_DIR}`];
const RLT_IDENTITY = {
  GIT_AUTHOR_NAME: 'CAST',
  GIT_AUTHOR_EMAIL: 'rlt@localhost',
  GIT_COMMITTER_NAME: 'CAST',
  GIT_COMMITTER_EMAIL: 'rlt@localhost',
};

interface RepoInfo {
  top: string; // work tree root
  prefix: string; // project folder relative to `top`, '' or 'sub/dir/'
  gitDir: string; // absolute
  hasHead: boolean;
}

interface GitOpts {
  env?: Record<string, string | undefined>;
  timeoutMs?: number;
  maxStdoutBytes?: number;
  okCodes?: number[];
  input?: string;
}

/** Base environment: no prompts, no pagers, stable output, and nothing inherited that could redirect git. */
const BASE_ENV: Record<string, string | undefined> = {
  GIT_TERMINAL_PROMPT: '0',
  GIT_PAGER: 'cat',
  LC_ALL: 'C',
  GIT_DIR: undefined,
  GIT_WORK_TREE: undefined,
  GIT_INDEX_FILE: undefined,
};

async function git(cwd: string, args: string[], opts: GitOpts = {}): Promise<ExecResult> {
  const res = await exec(['git', '-c', 'core.quotepath=off', '-c', 'color.ui=false', ...args], {
    cwd,
    env: { ...BASE_ENV, ...opts.env },
    timeoutMs: opts.timeoutMs ?? 20_000,
    maxStdoutBytes: opts.maxStdoutBytes,
    input: opts.input,
  });
  const ok = opts.okCodes ?? [0];
  if (!ok.includes(res.code)) {
    const why = res.timedOut ? 'timed out' : res.stderr.trim() || `exit ${res.code}`;
    const sub = args.find((a, i) => !a.startsWith('-') && args[i - 1] !== '-c') ?? args[0];
    throw new Error(`git ${sub} failed: ${why}`);
  }
  return res;
}

/** Read-only commands must not even refresh the user's index stat cache. */
const READ_ONLY = { GIT_OPTIONAL_LOCKS: '0' };

async function repoInfo(path: string): Promise<RepoInfo | null> {
  if (!existsSync(path)) return null;
  const res = await git(path, ['rev-parse', '--is-inside-work-tree', '--show-toplevel', '--show-prefix', '--absolute-git-dir'], {
    env: READ_ONLY,
    okCodes: [0, 128],
  }).catch(() => null);
  if (!res || res.code !== 0) return null;
  const [inside, top, prefix, gitDir] = res.stdout.split('\n');
  if (inside !== 'true' || !top || !gitDir) return null;
  const head = await git(path, ['rev-parse', '--verify', '-q', 'HEAD^{commit}'], { env: READ_ONLY, okCodes: [0, 1, 128] });
  return { top, prefix: prefix ?? '', gitDir, hasHead: head.code === 0 };
}

/** Serialize mutating operations per repository. */
const locks = new Map<string, Promise<unknown>>();
function withRepoLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const prev = locks.get(key) ?? Promise.resolve();
  const next = prev.catch(() => {}).then(fn);
  locks.set(key, next);
  next.finally(() => {
    if (locks.get(key) === next) locks.delete(key);
  }).catch(() => {});
  return next;
}

function tempIndexPath(info: RepoInfo): string {
  return join(info.gitDir, `rlt-index-${process.pid}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`);
}

function removeTempIndex(path: string): void {
  rmSync(path, { force: true });
  rmSync(`${path}.lock`, { force: true });
}

function safeRefName(runId: string): string {
  const clean = runId.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^[.-]+/, '').replace(/\.+$/, '').replace(/\.\.+/g, '.');
  if (!clean) throw new UserError('Invalid checkpoint id');
  return clean.slice(0, 100);
}

// ───────────────────────── summary ─────────────────────────

interface StatusEntry {
  path: string; // relative to the project folder
  code: string; // XY
}

function parseStatus(z: string, prefix: string): StatusEntry[] {
  const out: StatusEntry[] = [];
  for (const rec of z.split('\0')) {
    if (rec.length < 4) continue;
    const code = rec.slice(0, 2);
    let path = rec.slice(3);
    if (prefix && path.startsWith(prefix)) path = path.slice(prefix.length);
    out.push({ path, code });
  }
  return out;
}

function simpleStatus(code: string): string {
  if (code === '??') return '??';
  if (code.includes('R')) return 'R';
  if (code.includes('D')) return 'D';
  if (code[0] === 'A') return 'A';
  return 'M';
}

function parseNumstat(z: string): Map<string, { add: number; del: number }> {
  const map = new Map<string, { add: number; del: number }>();
  for (const rec of z.split('\0')) {
    const m = /^(\d+|-)\t(\d+|-)\t(.+)$/s.exec(rec);
    if (!m) continue;
    map.set(m[3]!, { add: m[1] === '-' ? 0 : Number(m[1]), del: m[2] === '-' ? 0 : Number(m[2]) });
  }
  return map;
}

/** The blob id git gives a symlink: its target text (SHA-1). */
function linkBlobId(target: string): string {
  const body = Buffer.from(target);
  return createHash('sha1').update(`blob ${body.length}\0`).update(body).digest('hex');
}

function isBinary(buf: Uint8Array): boolean {
  const n = Math.min(buf.length, 8000);
  for (let i = 0; i < n; i++) if (buf[i] === 0) return true;
  return false;
}

function countLines(buf: Uint8Array): number {
  if (buf.length === 0) return 0;
  let n = 0;
  for (let i = 0; i < buf.length; i++) if (buf[i] === 10) n++;
  return buf[buf.length - 1] === 10 ? n : n + 1;
}

/** Appends whole per-file diff sections while they fit in the budget (a lone oversize file is cut at a line). */
class DiffBudget {
  private parts: string[] = [];
  private size = 0;
  get remaining(): number {
    return DIFF_LIMIT - this.size;
  }
  add(text: string): boolean {
    if (!text) return true;
    if (this.remaining <= 0) return false;
    const sections = text.split(/(?=^diff --git )/m);
    for (const s of sections) {
      if (s.length <= this.remaining) {
        this.parts.push(s);
        this.size += s.length;
      } else {
        if (this.size === 0) {
          const cut = s.lastIndexOf('\n', this.remaining);
          const piece = s.slice(0, cut > 0 ? cut + 1 : this.remaining);
          this.parts.push(piece);
          this.size += piece.length;
        }
        this.size = DIFF_LIMIT; // full: refuse anything else so the diff never ends mid-file
        return false;
      }
    }
    return true;
  }
  text(): string {
    return this.parts.join('');
  }
}

async function untrackedDetails(cwd: string, paths: string[], budget: DiffBudget): Promise<Map<string, number>> {
  const additions = new Map<string, number>();
  let diffs = 0;
  for (const rel of paths) {
    const abs = join(cwd, rel);
    let size = 0;
    try {
      const st = lstatSync(abs);
      if (!st.isFile()) {
        additions.set(rel, 0);
        continue;
      }
      size = st.size;
    } catch {
      continue;
    }
    if (size > MAX_UNTRACKED_BYTES) {
      additions.set(rel, 0);
      continue;
    }
    const buf = readFileSync(abs);
    additions.set(rel, isBinary(buf) ? 0 : countLines(buf));
    if (budget.remaining > 0 && diffs < MAX_UNTRACKED_DIFFS) {
      diffs++;
      // exit code 1 means "files differ", which is always the case against /dev/null
      const res = await git(cwd, ['diff', '--no-index', '--no-ext-diff', '--', '/dev/null', rel], {
        env: READ_ONLY,
        okCodes: [0, 1],
        maxStdoutBytes: DIFF_LIMIT + 1024,
      }).catch(() => null);
      if (res) budget.add(res.stdout);
    }
  }
  return additions;
}

async function currentBranch(cwd: string): Promise<string> {
  const sym = await git(cwd, ['symbolic-ref', '--short', '-q', 'HEAD'], { env: READ_ONLY, okCodes: [0, 1, 128] });
  if (sym.code === 0 && sym.stdout.trim()) return sym.stdout.trim();
  const sha = await git(cwd, ['rev-parse', '--short', 'HEAD'], { env: READ_ONLY, okCodes: [0, 128] });
  return sha.code === 0 ? `detached@${sha.stdout.trim()}` : 'HEAD';
}

async function summarize(project: Project): Promise<GitSummary> {
  const base: GitSummary = { projectId: project.id, isGit: false, files: [], diff: '', ts: Date.now() };
  const info = await repoInfo(project.path);
  if (!info) return base;
  const cwd = project.path;
  const against = info.hasHead ? 'HEAD' : EMPTY_TREE;

  const [branch, status, numstat, tracked] = await Promise.all([
    currentBranch(cwd),
    git(cwd, ['status', '--porcelain=v1', '-z', '--untracked-files=all', '--no-renames', ...PROJECT_PATHSPEC], { env: READ_ONLY }),
    git(cwd, ['diff', against, '--numstat', '-z', '--no-renames', '--relative', ...PROJECT_PATHSPEC], { env: READ_ONLY }),
    git(cwd, ['diff', against, '--no-renames', '--relative', '--no-ext-diff', ...PROJECT_PATHSPEC], {
      env: READ_ONLY,
      maxStdoutBytes: DIFF_LIMIT * 2,
    }),
  ]);

  const entries = parseStatus(status.stdout, info.prefix).slice(0, MAX_FILES);
  const counts = parseNumstat(numstat.stdout);
  const budget = new DiffBudget();
  budget.add(tracked.stdout);
  const untracked = entries.filter((e) => e.code === '??').map((e) => e.path);
  const newFileLines = await untrackedDetails(cwd, untracked, budget);

  const files: GitFileChange[] = entries.map((e) => {
    const status = simpleStatus(e.code);
    if (status === '??') return { path: e.path, status, additions: newFileLines.get(e.path) ?? 0, deletions: 0 };
    const c = counts.get(e.path);
    return { path: e.path, status, additions: c?.add ?? 0, deletions: c?.del ?? 0 };
  });
  files.sort((a, b) => a.path.localeCompare(b.path));
  return { ...base, isGit: true, branch, files, diff: budget.text(), ts: Date.now() };
}

// ───────────────────────── checkpoint / revert ─────────────────────────

/** Untracked nested repositories under cwd (ls-files reports them as `dir/`). Snapshots skip them, revert never touches them. */
async function nestedRepos(cwd: string, env: Record<string, string>): Promise<string[]> {
  const res = await git(cwd, ['ls-files', '-z', '--others', '--exclude-standard', `--exclude=${RLT_DIR}/`, '--', '.'], { env, timeoutMs: 60_000 });
  return res.stdout.split('\0').filter((p) => p.endsWith('/')).map((p) => p.slice(0, -1));
}

/** Commit what the files under cwd look like now (tracked + untracked, honoring .gitignore, minus .rlt/ and nested
 *  repositories) on top of HEAD, through a throwaway index; no ref points at it yet. Returns the commit id
 *  (commit: false → only the tree's id). */
async function snapshotCommit(info: RepoInfo, cwd: string, message: string, commit = true): Promise<string> {
  const tmpIndex = tempIndexPath(info);
  const env = { GIT_INDEX_FILE: tmpIndex, ...RLT_IDENTITY };
  try {
    // Seed the temp index from the user's index (fast: valid stat cache) or HEAD; never write the real one.
    const realIndex = (await git(cwd, ['rev-parse', '--git-path', 'index'], { env: READ_ONLY })).stdout.trim();
    const realIndexAbs = isAbsolute(realIndex) ? realIndex : resolve(cwd, realIndex);
    if (existsSync(realIndexAbs)) copyFileSync(realIndexAbs, tmpIndex);
    else if (info.hasHead) await git(cwd, ['read-tree', 'HEAD'], { env });
    // `.rlt/` is kept out via info/exclude (an `:(exclude)` pathspec makes `git add` fail once .rlt/ is ignored).
    await ensureRltExcluded(cwd);
    const skip = (await nestedRepos(cwd, env)).map((p) => `:(exclude,literal)${p}`);
    await git(cwd, ['add', '-A', '--', '.', ...skip], { env, timeoutMs: 120_000 });
    const tree = (await git(cwd, ['write-tree'], { env })).stdout.trim();
    if (!commit) return tree;
    const parents = info.hasHead ? ['-p', 'HEAD'] : [];
    return (await git(cwd, ['commit-tree', tree, ...parents, '-m', message], { env })).stdout.trim();
  } finally {
    removeTempIndex(tmpIndex);
  }
}

/** snapshotCommit() kept under a full ref name (refs/rlt/…), so git never garbage-collects it. */
async function snapshotTo(info: RepoInfo, cwd: string, ref: string, message: string): Promise<string> {
  const commit = await snapshotCommit(info, cwd, message);
  await git(cwd, ['update-ref', '-m', message, ref, commit], { env: RLT_IDENTITY });
  return ref;
}

function snapshot(info: RepoInfo, cwd: string, refName: string, message: string): Promise<string> {
  return snapshotTo(info, cwd, `refs/rlt/checkpoints/${refName}`, message);
}

/** Remove now-empty directories from `dir` upward, stopping at `stop` (exclusive). */
function pruneEmptyDirs(dir: string, stop: string): void {
  let d = dir;
  while (d !== stop && isInside(stop, d)) {
    try {
      if (readdirSync(d).length > 0) return;
      rmdirSync(d);
    } catch {
      return;
    }
    d = dirname(d);
  }
}

async function restore(info: RepoInfo, cwd: string, ref: string): Promise<{ removed: number }> {
  const treeRes = await git(cwd, ['rev-parse', '--verify', '-q', `${ref}^{tree}`], { env: READ_ONLY, okCodes: [0, 1, 128] });
  if (treeRes.code !== 0) throw new UserError(`Checkpoint not found: ${ref}`);
  const tree = treeRes.stdout.trim();
  const tmpIndex = tempIndexPath(info);
  const env = { GIT_INDEX_FILE: tmpIndex };
  try {
    await git(cwd, ['read-tree', tree], { env });
    // Fill the stat cache so checkout-index skips files that already match the checkpoint.
    await git(cwd, ['update-index', '-q', '--refresh'], { env, okCodes: [0, 1], timeoutMs: 60_000 });
    // From a subdirectory, checkout-index -a only writes entries under that directory (the project folder).
    await git(cwd, ['checkout-index', '-a', '-f'], { env, timeoutMs: 120_000 });
    // Files that exist now but not in the checkpoint (and are not ignored) were created after it: remove them.
    const extra = await git(cwd, ['ls-files', '-z', '--others', '--exclude-standard', `--exclude=${RLT_DIR}/`, '--', '.'], { env });
    let removed = 0;
    const root = resolve(cwd);
    for (const rel of extra.stdout.split('\0')) {
      if (!rel || rel.endsWith('/')) continue; // a trailing slash marks a nested repository: never touch it
      const abs = resolve(root, rel);
      if (!isInside(root, abs) || abs === root) continue;
      rmSync(abs, { force: true });
      removed++;
      pruneEmptyDirs(dirname(abs), root);
    }
    return { removed };
  } finally {
    removeTempIndex(tmpIndex);
  }
}

interface TreeEntry {
  mode: string; // '100644', '100755', '120000' (symlink), '160000' (submodule)
  type: string; // 'blob' | 'commit'
  sha: string;
}

/** `<mode> <type> <sha>\t<path>` records of `ls-tree -r` under cwd → path → entry (paths relative to cwd). */
async function entriesAt(cwd: string, ref: string, paths: string[]): Promise<Map<string, TreeEntry>> {
  const out = new Map<string, TreeEntry>();
  for (let i = 0; i < paths.length; i += 200) {
    const chunk = paths.slice(i, i + 200).map((p) => `:(literal)${p}`);
    const res = await git(cwd, ['ls-tree', '-r', '-z', ref, '--', ...chunk], { env: READ_ONLY, timeoutMs: 60_000 });
    for (const rec of res.stdout.split('\0')) {
      const tab = rec.indexOf('\t');
      if (tab < 0) continue;
      const [mode, type, sha] = rec.slice(0, tab).split(' ');
      if (mode && type && sha) out.set(rec.slice(tab + 1), { mode, type, sha });
    }
  }
  return out;
}

/** Blob ids (files and symlinks) at `ref` → path → sha. */
async function blobsAt(cwd: string, ref: string, paths: string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  for (const [p, e] of await entriesAt(cwd, ref, paths)) if (e.type === 'blob') out.set(p, e.sha);
  return out;
}

/** Blob ids the working-tree files (and symlinks) would get if added now (missing files are left out). */
async function workingBlobs(cwd: string, paths: string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const present = paths.filter((p) => {
    try {
      const st = lstatSync(join(cwd, p));
      // hash-object would follow a symlink: git stores the link's target text (SHA-1 repos; others never match)
      if (st.isSymbolicLink()) out.set(p, linkBlobId(readlinkSync(join(cwd, p))));
      return st.isFile();
    } catch {
      return false;
    }
  });
  for (let i = 0; i < present.length; i += 200) {
    const chunk = present.slice(i, i + 200);
    const res = await git(cwd, ['hash-object', '--', ...chunk], { env: READ_ONLY, timeoutMs: 60_000 });
    const shas = res.stdout.split('\n').filter(Boolean);
    chunk.forEach((p, k) => {
      if (shas[k]) out.set(p, shas[k]!);
    });
  }
  return out;
}

/** Scoped undo of one run: files that changed between `from` (its checkpoint) and `to` (its end snapshot) go back to
 *  `from`; files changed again after `to` (someone else's newer work) and files in `keep` are left alone. */
async function undoRange(info: RepoInfo, cwd: string, from: string, to: string, keep: Set<string>, dryRun: boolean): Promise<{ restored: string[]; kept: string[] }> {
  for (const ref of [from, to]) {
    const ok = await git(cwd, ['rev-parse', '--verify', '-q', `${ref}^{commit}`], { env: READ_ONLY, okCodes: [0, 1, 128] });
    if (ok.code !== 0) throw new UserError(`Checkpoint not found: ${ref}`);
  }
  const diff = await git(cwd, ['diff', '--name-only', '-z', '--no-renames', '--relative', from, to, '--', '.', `:(exclude)${RLT_DIR}`], { env: READ_ONLY, timeoutMs: 60_000 });
  const paths = diff.stdout.split('\0').filter(Boolean);
  if (!paths.length) return { restored: [], kept: [] };
  const [atEnd, now, atStart] = await Promise.all([blobsAt(cwd, to, paths), workingBlobs(cwd, paths), blobsAt(cwd, from, paths)]);
  const restored: string[] = [];
  const kept: string[] = [];
  for (const p of paths) {
    // A folder on the way that is a link or a file now: the path isn't the house's any more (never act through it).
    if (keep.has(p) || atEnd.get(p) !== now.get(p) || blockingParent(cwd, p)) kept.push(p);
    else restored.push(p);
  }
  if (dryRun || !restored.length) return { restored, kept };
  const back = restored.filter((p) => atStart.has(p));
  const gone = restored.filter((p) => !atStart.has(p));
  if (back.length) {
    const tmpIndex = tempIndexPath(info);
    const env = { GIT_INDEX_FILE: tmpIndex };
    try {
      await git(cwd, ['read-tree', from], { env });
      for (let i = 0; i < back.length; i += 200) {
        await git(cwd, ['checkout-index', '-f', '--', ...back.slice(i, i + 200)], { env, timeoutMs: 120_000 });
      }
    } finally {
      removeTempIndex(tmpIndex);
    }
  }
  const root = resolve(cwd);
  for (const rel of gone) {
    const abs = resolve(root, rel);
    if (!isInside(root, abs) || abs === root) continue;
    rmSync(abs, { force: true });
    pruneEmptyDirs(dirname(abs), root);
  }
  return { restored, kept };
}

// ───────────────────────── job copies (git worktrees) ─────────────────────────
// A job's own copy is a linked worktree on branch rlt/<project>/<job>, made from a snapshot of the house (uncommitted
// work included). refs/rlt/jobs/<project>/<job>/base is the house's files the copy was last in step with; Bring into
// house merges base → copy into the house's working files (3-way, per file) and never touches the house's HEAD, index
// or branch. Each bring keeps bring-<ts> (the house before), bring-<ts>-after and bring-<ts>-base for its undo.

const LINK_MODE = '120000';
const ANY_EXIT = Array.from({ length: 128 }, (_, i) => i);

function jobRef(projectId: string, jobId: string, name: string): string {
  return `refs/rlt/jobs/${safeRefName(projectId)}/${safeRefName(jobId)}/${name}`;
}

/** Like git(), for output that may be binary or not UTF-8 (file contents). */
async function gitBytes(cwd: string, args: string[]): Promise<Uint8Array> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries({ ...process.env, ...BASE_ENV })) if (v !== undefined) env[k] = v;
  const proc = Bun.spawn(['git', ...args], { cwd, env, stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' });
  const timer = setTimeout(() => proc.kill('SIGKILL'), 60_000);
  try {
    const [out, err, code] = await Promise.all([new Response(proc.stdout).arrayBuffer(), new Response(proc.stderr).text(), proc.exited]);
    if (code !== 0) throw new Error(`git ${args[0]} failed: ${err.trim() || `exit ${code}`}`);
    return new Uint8Array(out);
  } finally {
    clearTimeout(timer);
  }
}

/** A file as the working tree has it (smudge filters and line endings applied) at commit `ref`, path relative to cwd. */
const fileAt = (cwd: string, ref: string, rel: string) => gitBytes(cwd, ['cat-file', '--filters', `${ref}:./${rel}`]);

async function resolveCommit(cwd: string, ref: string): Promise<string | null> {
  const res = await git(cwd, ['rev-parse', '--verify', '-q', `${ref}^{commit}`], { env: READ_ONLY, okCodes: [0, 1, 128] });
  return res.code === 0 ? res.stdout.trim() : null;
}

/** `base`, or `base-2`, `base-3`… — the first branch name not taken yet (a deleted job's branch is kept). */
async function freeBranch(cwd: string, base: string): Promise<string> {
  for (let n = 1; n <= 50; n++) {
    const name = n === 1 ? base : `${base}-${n}`;
    const res = await git(cwd, ['show-ref', '--verify', '--quiet', `refs/heads/${name}`], { env: READ_ONLY, okCodes: [0, 1] });
    if (res.code === 1) return name;
  }
  throw new UserError(`Too many old branches named ${base}-… — delete some first.`);
}

async function createCopy(project: Project, jobId: string, root: string): Promise<JobWorktree> {
  const info = await repoInfo(project.path);
  if (!info) throw new UserError(`${project.name} isn’t a git repository, so a job can’t get its own copy of the files.`);
  if (existsSync(root)) throw new UserError(`Something is already in ${root} — CAST won’t write over it.`);
  return withRepoLock(info.top, async () => {
    const baseRef = jobRef(project.id, jobId, 'base');
    // The house as it is now, uncommitted work included (ignored files such as node_modules or .env are not).
    const commit = await snapshotCommit(info, project.path, `rlt: ${project.name} for job ${jobId}`);
    const branch = await freeBranch(project.path, `rlt/${safeRefName(project.id)}/${safeRefName(jobId)}`);
    await git(project.path, ['update-ref', '-m', 'rlt job copy', baseRef, commit], { env: RLT_IDENTITY });
    try {
      mkdirSync(dirname(root), { recursive: true });
      // No hooks: the house's post-checkout hook has no business in RLT's copy.
      await git(project.path, ['-c', 'core.hooksPath=/dev/null', 'worktree', 'add', '-q', '-b', branch, root, commit], { env: RLT_IDENTITY, timeoutMs: 300_000 });
    } catch (err) {
      await dropCopy(project.path, { root, branch, baseRef });
      throw new UserError(`Could not make the job’s own copy: ${errorMessage(err)}`);
    }
    // A house that is a subfolder of its repo works in the same subfolder of the copy (empty folders aren't in git).
    const path = resolve(root, info.prefix);
    mkdirSync(path, { recursive: true });
    log('git', `${project.id}/${jobId}: own copy at ${root} on ${branch}`);
    return { path, root, branch, baseRef, createdAt: Date.now() };
  });
}

/** Undo a copy nobody worked in yet (a job that could not be created after all): worktree, branch and base go. */
async function dropCopy(cwd: string, wt: Pick<JobWorktree, 'root' | 'branch' | 'baseRef'>): Promise<void> {
  const quiet = { okCodes: [0, 1, 128] };
  await git(cwd, ['worktree', 'remove', '--force', wt.root], quiet).catch(() => null);
  rmSync(wt.root, { recursive: true, force: true });
  // A half-made worktree the first remove refused: with its folder gone, remove just forgets it. Never `worktree
  // prune` — it also drops the admin data (index, HEAD) of the user's own worktrees whose folder is elsewhere for now.
  await git(cwd, ['worktree', 'remove', '--force', wt.root], quiet).catch(() => null);
  await git(cwd, ['branch', '-D', wt.branch], quiet).catch(() => null);
  await git(cwd, ['update-ref', '-d', wt.baseRef], quiet).catch(() => null);
}

/** Folders and files a reinstall or rebuild makes again: losing them is no reason to keep a deleted job's copy. */
const REGENERABLE_DIRS = new Set([
  'node_modules', '.venv', 'venv', '__pycache__', '.pytest_cache', '.mypy_cache', '.ruff_cache', '.tox', '.gradle',
  '.next', '.nuxt', '.svelte-kit', '.turbo', '.parcel-cache', '.cache', 'dist', 'build', 'target', 'coverage',
]);
const REGENERABLE_FILE = /(^|\/)(\.DS_Store|[^/]+\.(log|tsbuildinfo|pyc))$/;

/** What a commit of the copy (cwd: its root) leaves out — ignored files and nested repositories, minus RLT's own
 *  .rlt/ — split into what only exists there (`keep`) and what a reinstall or rebuild makes again. Folders end in '/'. */
async function leftOut(cwd: string): Promise<{ keep: string[]; regenerable: string[] }> {
  const ignored = await git(cwd, ['ls-files', '-z', '--others', '--ignored', '--exclude-standard', '--directory'], { env: READ_ONLY, timeoutMs: 60_000 });
  const nested = (await nestedRepos(cwd, READ_ONLY)).map((p) => `${p}/`);
  const keep: string[] = [...nested];
  const regenerable: string[] = [];
  for (const p of ignored.stdout.split('\0')) {
    if (!p || p === `${RLT_DIR}/` || p.startsWith(`${RLT_DIR}/`)) continue;
    const regen = p.split('/').some((seg) => REGENERABLE_DIRS.has(seg)) || REGENERABLE_FILE.test(p);
    (regen ? regenerable : keep).push(p);
  }
  return { keep, regenerable };
}

/** Commit everything in the copy (not ignored files) onto the branch it has checked out; returns that branch. */
async function commitCopy(copy: RepoInfo, wt: JobWorktree, message: string): Promise<string> {
  const cwd = copy.top;
  const head = await resolveCommit(cwd, 'HEAD');
  const commit = await snapshotCommit(copy, cwd, message);
  const treeOf = async (c: string) => (await git(cwd, ['rev-parse', `${c}^{tree}`], { env: READ_ONLY })).stdout.trim();
  const same = !!head && (await treeOf(commit)) === (await treeOf(head));
  const sym = await git(cwd, ['symbolic-ref', '-q', 'HEAD'], { env: READ_ONLY, okCodes: [0, 1] });
  if (sym.code === 0) {
    const ref = sym.stdout.trim();
    if (!same) await git(cwd, ['update-ref', '-m', message, ref, commit, ...(head ? [head] : [])], { env: RLT_IDENTITY });
    return ref.replace(/^refs\/heads\//, '');
  }
  // Someone detached HEAD in the copy: keep what it has on a branch of its own.
  const branch = await freeBranch(cwd, `${wt.branch}-detached`);
  await git(cwd, ['update-ref', '-m', message, `refs/heads/${branch}`, same ? head! : commit], { env: RLT_IDENTITY });
  return branch;
}

/** Where a deleted job's copy goes when it holds files no commit keeps: beside RLT's worktrees folder,
 *  `<dataDir>/worktrees-kept/<project>/<job>-<ts>` (root is `<dataDir>/worktrees/<project>/<job>`). */
function keptFolder(root: string): string {
  const project = dirname(root);
  return join(dirname(dirname(project)), 'worktrees-kept', basename(project), `${basename(root)}-${Date.now()}`);
}

/** A job with a copy is deleted: its work is committed to its branch (kept), the worktree goes and the base ref moves
 *  to refs/rlt/leftover/<branch> (see the leftover section below). Files
 *  the commit can't hold (ignored ones such as an .env, nested repositories) aren't deleted with it: the folder moves
 *  to keptFolder() as a plain folder (minus caches a reinstall makes again). */
async function removeCopy(project: Project, jobName: string, wt: JobWorktree, onKept?: (dir: string, files: string[]) => void): Promise<string | null> {
  const copy = existsSync(wt.root) ? await repoInfo(wt.root) : null;
  const kept = copy ? await withRepoLock(copy.top, () => commitCopy(copy, wt, `CAST: ${jobName} — job deleted`)) : null;
  const extra = copy ? await leftOut(copy.top) : { keep: [], regenerable: [] };
  const house = await repoInfo(project.path);
  const cwd = house ? project.path : copy?.top;
  if (!cwd) return kept; // neither the house's repository nor the copy is there any more
  let aside: string | null = null;
  if (extra.keep.length) {
    if (!house) throw new Error(`its folder has files that aren’t on ${kept ?? 'its branch'} (${extra.keep.slice(0, 5).join(', ')})`);
    aside = keptFolder(wt.root);
    mkdirSync(dirname(aside), { recursive: true });
    renameSync(wt.root, aside);
    rmSync(join(aside, '.git'), { force: true }); // a plain folder now
    for (const p of extra.regenerable) rmSync(join(aside, p), { recursive: true, force: true });
  }
  // With the folder moved away, remove only makes git forget it. No `worktree prune` anywhere: it would also drop the
  // admin data (index, HEAD) of the user's own worktrees whose folder is elsewhere for now.
  await git(cwd, ['worktree', 'remove', '--force', wt.root], { timeoutMs: 120_000 });
  // The base stays with the branch (refs/rlt/leftover/<branch>): the house's Changes tab lists the branch and brings
  // in exactly what the job changed since it was last in step with the house (finding #75).
  const branch = kept ?? ((await resolveCommit(cwd, `refs/heads/${wt.branch}`)) ? wt.branch : null);
  const base = branch ? await resolveCommit(cwd, wt.baseRef) : null;
  if (branch && base) {
    await git(cwd, ['update-ref', '-m', `rlt: base of ${branch} (job deleted)`, leftoverBase(branch), base], { env: RLT_IDENTITY }).catch((err) => {
      log('git', `could not keep the base of ${branch}: ${errorMessage(err)}`);
    });
  }
  await git(cwd, ['update-ref', '-d', wt.baseRef], { okCodes: [0, 1, 128] });
  if (aside) onKept?.(aside, extra.keep);
  const where = aside ? `; files that aren’t on the branch (${extra.keep.slice(0, 5).join(', ')}${extra.keep.length > 5 ? ', …' : ''}) are kept in ${aside}` : '';
  log('git', `${project.id}: removed the copy ${wt.root}${kept ? ` (its work is on ${kept})` : ''}${where}`);
  return kept;
}

async function summarizeCopy(project: Project, jobId: string, wt: JobWorktree): Promise<GitSummary> {
  const empty: GitSummary = { projectId: project.id, jobId, isGit: false, files: [], diff: '', ts: Date.now() };
  const cwd = wt.path;
  const info = await repoInfo(cwd);
  if (!info) return empty;
  // What the job changed since its base, committed or not (a job may commit on its branch): its files now, as a tree
  // made like Bring's snapshot, against the base — the base also holds files that are untracked in the copy.
  const base = (await resolveCommit(cwd, wt.baseRef)) ?? (info.hasHead ? 'HEAD' : EMPTY_TREE);
  const now = await snapshotCommit(info, cwd, '', false);
  const range = ['--no-renames', '--relative', base, now, ...PROJECT_PATHSPEC];
  const [branch, names, numstat, diff] = await Promise.all([
    currentBranch(cwd),
    git(cwd, ['diff', '--name-status', '-z', ...range], { env: READ_ONLY }),
    git(cwd, ['diff', '--numstat', '-z', ...range], { env: READ_ONLY }),
    git(cwd, ['diff', '--no-ext-diff', ...range], { env: READ_ONLY, maxStdoutBytes: DIFF_LIMIT * 2 }),
  ]);
  const counts = parseNumstat(numstat.stdout);
  const files: GitFileChange[] = [];
  const parts = names.stdout.split('\0');
  for (let i = 0; i + 1 < parts.length && files.length < MAX_FILES; i += 2) {
    const code = parts[i]!.slice(0, 1);
    const path = parts[i + 1]!;
    const c = counts.get(path);
    files.push({ path, status: code === 'D' || code === 'A' ? code : 'M', additions: c?.add ?? 0, deletions: c?.del ?? 0 });
  }
  files.sort((a, b) => a.path.localeCompare(b.path));
  const budget = new DiffBudget();
  budget.add(diff.stdout);
  return { ...empty, isGit: true, branch, files, diff: budget.text(), ts: Date.now() };
}

type HouseFile =
  | { kind: 'missing' }
  | { kind: 'file'; sha: string; exec: boolean }
  | { kind: 'link'; target: string }
  | { kind: 'other' } // a folder, a socket…
  | { kind: 'blocked' }; // a folder on the way is a file or a symlink: RLT never writes through it

/** What the house has at each path now (files by the blob id `git add` would give them). */
async function houseFiles(cwd: string, paths: string[]): Promise<Map<string, HouseFile>> {
  const blobs = await workingBlobs(cwd, paths);
  const out = new Map<string, HouseFile>();
  const dirOk = new Map<string, boolean>();
  const realDir = (rel: string): boolean => {
    if (rel === '.' || rel === '') return true;
    let ok = dirOk.get(rel);
    if (ok === undefined) {
      try {
        const st = lstatSync(join(cwd, rel));
        ok = st.isDirectory() && realDir(dirname(rel));
      } catch {
        ok = realDir(dirname(rel)); // missing: made when written
      }
      dirOk.set(rel, ok);
    }
    return ok;
  };
  for (const p of paths) {
    const abs = join(cwd, p);
    if (!realDir(dirname(p))) {
      out.set(p, { kind: 'blocked' });
      continue;
    }
    let st;
    try {
      st = lstatSync(abs);
    } catch {
      out.set(p, { kind: 'missing' });
      continue;
    }
    if (st.isFile() && blobs.has(p)) out.set(p, { kind: 'file', sha: blobs.get(p)!, exec: (st.mode & 0o111) !== 0 });
    else if (st.isSymbolicLink()) out.set(p, { kind: 'link', target: readlinkSync(abs) });
    else out.set(p, { kind: 'other' });
  }
  return out;
}

/** Paths Bring leaves alone although the house could take them: inside a nested repository (another repo's files, which
 *  the house's snapshots skip) or covered by the house's ignore rules (its private .env, a local build): an ignored
 *  file is in no snapshot, so writing it could never be undone. */
async function offLimits(cwd: string, paths: string[]): Promise<Set<string>> {
  const out = new Set<string>();
  const repoDir = new Map<string, boolean>();
  const isRepo = (rel: string): boolean => {
    let yes = repoDir.get(rel);
    if (yes === undefined) {
      try {
        lstatSync(join(cwd, rel, '.git'));
        yes = true;
      } catch {
        yes = false;
      }
      repoDir.set(rel, yes);
    }
    return yes;
  };
  const rest: string[] = [];
  for (const p of paths) {
    let nested = false;
    for (let d = dirname(p); d !== '.' && d !== '/' && d !== ''; d = dirname(d)) {
      if (isRepo(d)) {
        nested = true;
        break;
      }
    }
    if (nested) out.add(p);
    else rest.push(p);
  }
  if (!rest.length) return out;
  // Tracked files never count as ignored (check-ignore without --no-index), like `git add -A` in a snapshot.
  const check = (list: string[]) => git(cwd, ['check-ignore', '-z', '--stdin'], { env: READ_ONLY, input: `${list.join('\0')}\0`, okCodes: [0, 1, 128], timeoutMs: 60_000 });
  const res = await check(rest);
  if (res.code !== 128) {
    for (const p of res.stdout.split('\0')) if (p) out.add(p);
    return out;
  }
  // git refused one of them (a path in a submodule…): ask per path; one it can't answer for is left alone too.
  for (const p of rest) if ((await check([p])).code !== 1) out.add(p);
  return out;
}

interface BringStep {
  path: string;
  action: 'take' | 'merge' | 'conflict' | 'skip'; // take: the house never changed it, so it gets the job's version
  job?: TreeEntry; // the job's version (absent: the job deleted it)
  modeChanged?: boolean;
  merged?: Uint8Array; // merge / conflict: the result to write
}

/** Per file the job changed between `base` and `job`: what bringing it into the house (cwd) does. Files the house
 *  already has as the job has them are left out. */
async function planBring(cwd: string, base: string, job: string, labels: [string, string, string] = ['house', 'base', 'job']): Promise<BringStep[]> {
  const diff = await git(cwd, ['diff', '--name-only', '-z', '--no-renames', '--relative', base, job, '--', '.', `:(exclude)${RLT_DIR}`], { env: READ_ONLY, timeoutMs: 60_000 });
  const paths = diff.stdout.split('\0').filter(Boolean);
  if (!paths.length) return [];
  const [atBase, atJob, house] = await Promise.all([entriesAt(cwd, base, paths), entriesAt(cwd, job, paths), houseFiles(cwd, paths)]);
  const off = await offLimits(cwd, paths.filter((p) => house.get(p)?.kind !== 'blocked'));
  const linkTarget = async (e: TreeEntry) => Buffer.from(await gitBytes(cwd, ['cat-file', 'blob', e.sha])).toString();
  const same = async (h: HouseFile, e: TreeEntry | undefined) => {
    if (!e) return h.kind === 'missing';
    if (e.mode === LINK_MODE) return h.kind === 'link' && h.target === (await linkTarget(e));
    return e.type === 'blob' && h.kind === 'file' && h.sha === e.sha && h.exec === (e.mode === '100755');
  };
  const steps: BringStep[] = [];
  const tmp = mkdtempSync(join(tmpdir(), 'rlt-bring-'));
  try {
    for (const path of paths) {
      const b = atBase.get(path);
      const j = atJob.get(path);
      const h = house.get(path) ?? { kind: 'missing' };
      const modeChanged = !!b && !!j && b.mode !== j.mode;
      if ((b && b.type !== 'blob') || (j && j.type !== 'blob') || h.kind === 'blocked') {
        steps.push({ path, action: 'skip' }); // a submodule, or a path the house can't take
        continue;
      }
      if (await same(h, j)) continue; // the house has it like this already
      if (off.has(path)) {
        steps.push({ path, action: 'skip' });
        continue;
      }
      if (await same(h, b)) {
        steps.push({ path, action: 'take', job: j, modeChanged });
        continue;
      }
      // Both sides changed it: only a text file both still have can be merged line by line.
      if (!j || h.kind !== 'file' || j.mode === LINK_MODE || b?.mode === LINK_MODE) {
        steps.push({ path, action: 'skip' });
        continue;
      }
      const mine = readFileSync(join(cwd, path));
      const [theirs, ancestor] = await Promise.all([fileAt(cwd, job, path), b ? fileAt(cwd, base, path) : Promise.resolve(new Uint8Array())]);
      if (isBinary(mine) || isBinary(theirs) || isBinary(ancestor)) {
        steps.push({ path, action: 'skip' });
        continue;
      }
      const [hf, bf, jf] = ['house', 'base', 'job'].map((n) => join(tmp, n)) as [string, string, string];
      writeFileSync(hf, mine);
      writeFileSync(bf, ancestor);
      writeFileSync(jf, theirs);
      // exit code = number of conflicts (written with <<<<<<< house / >>>>>>> job markers, or `labels`)
      const res = await git(cwd, ['merge-file', '-q', '-L', labels[0], '-L', labels[1], '-L', labels[2], hf, bf, jf], { okCodes: ANY_EXIT });
      steps.push({ path, action: res.code > 0 ? 'conflict' : 'merge', job: j, modeChanged, merged: readFileSync(hf) });
    }
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
  return steps;
}

function planOf(steps: BringStep[]): BringPlan {
  const pick = (...a: BringStep['action'][]) => steps.filter((s) => a.includes(s.action)).map((s) => s.path);
  return { files: pick('take', 'merge'), conflicts: pick('conflict'), skipped: pick('skip') };
}

/** Make the executable bit match the job's version. */
function applyMode(abs: string, mode: string): void {
  const st = statSync(abs);
  const exec = mode === '100755';
  if (((st.mode & 0o111) !== 0) !== exec) chmodSync(abs, exec ? st.mode | ((st.mode & 0o444) >> 2) : st.mode & ~0o111);
}

/** Write a regular file at `abs` and never through a symlink there: a link (a dangling one too, which existsSync calls
 *  missing) is replaced, and O_NOFOLLOW refuses one that shows up meanwhile. A folder there throws. */
function writeHere(abs: string, bytes: Uint8Array): void {
  try {
    if (!lstatSync(abs).isFile()) rmSync(abs);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }
  const fd = openSync(abs, constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | constants.O_NOFOLLOW, 0o666);
  try {
    writeFileSync(fd, bytes);
  } finally {
    closeSync(fd);
  }
}

/** Write each step into the house; a step that can't be written (a file where the job has a folder…) becomes 'skip'. */
async function writeBring(cwd: string, job: string, steps: BringStep[]): Promise<void> {
  const root = resolve(cwd);
  for (const s of steps) {
    if (s.action === 'skip') continue;
    const abs = resolve(root, s.path);
    try {
      if (!isInside(root, abs) || abs === root) throw new Error('outside the house');
      if (!s.job) {
        rmSync(abs, { force: true });
        pruneEmptyDirs(dirname(abs), root);
        continue;
      }
      if (s.job.mode === LINK_MODE) {
        const target = Buffer.from(await gitBytes(cwd, ['cat-file', 'blob', s.job.sha])).toString();
        rmSync(abs, { force: true });
        mkdirSync(dirname(abs), { recursive: true });
        symlinkSync(target, abs);
        continue;
      }
      const bytes = s.merged ?? (await fileAt(cwd, job, s.path));
      mkdirSync(dirname(abs), { recursive: true });
      writeHere(abs, bytes);
      if (s.action === 'take' || s.modeChanged) applyMode(abs, s.job.mode);
    } catch (err) {
      log('git', `bring: could not write ${s.path}: ${errorMessage(err)}`);
      s.action = 'skip';
    }
  }
}

type IndexEntry = { mode: string; sha: string } | null; // null: nothing at that path

/** What the house has at `paths` now, as index entries whose blobs are written to the object database (files with
 *  their exact bytes, as `git add` would store them; links as their target), so an undo can put them back. */
async function recordHouse(cwd: string, paths: string[]): Promise<Map<string, IndexEntry>> {
  const out = new Map<string, IndexEntry>();
  const files: string[] = [];
  for (const p of paths) {
    const abs = join(cwd, p);
    let st;
    try {
      // Behind a folder that is a link or a file now, the path isn't in the house: never read through the link.
      if (blockingParent(cwd, p)) throw new Error('not in the house');
      st = lstatSync(abs);
    } catch {
      out.set(p, null);
      continue;
    }
    if (st.isSymbolicLink()) {
      const sha = (await git(cwd, ['hash-object', '-w', '--no-filters', '--stdin'], { input: readlinkSync(abs) })).stdout.trim();
      out.set(p, { mode: LINK_MODE, sha });
    } else if (st.isFile()) {
      files.push(p);
      out.set(p, { mode: st.mode & 0o100 ? '100755' : '100644', sha: '' });
    } else {
      out.set(p, null); // a folder: not something a bring writes
    }
  }
  for (let i = 0; i < files.length; i += 200) {
    const chunk = files.slice(i, i + 200);
    const shas = (await git(cwd, ['hash-object', '-w', '--', ...chunk], { timeoutMs: 60_000 })).stdout.split('\n').filter(Boolean);
    if (shas.length !== chunk.length) throw new Error('git hash-object gave too few ids');
    chunk.forEach((p, k) => (out.get(p)!.sha = shas[k]!));
  }
  return out;
}

/** A commit on top of `base` (its tree, with `entries` set or removed; paths relative to cwd); `parents`: other parents
 *  than just `base`. */
async function commitWith(info: RepoInfo, base: string, entries: Map<string, IndexEntry>, message: string, parents: string[] = [base]): Promise<string> {
  const tmpIndex = tempIndexPath(info);
  const env = { GIT_INDEX_FILE: tmpIndex, ...RLT_IDENTITY };
  try {
    await git(info.top, ['read-tree', base], { env });
    const all = [...entries];
    const gone = all.filter(([, e]) => !e).map(([p]) => `${info.prefix}${p}`);
    for (let i = 0; i < gone.length; i += 200) await git(info.top, ['update-index', '--force-remove', '--', ...gone.slice(i, i + 200)], { env });
    const set = all.flatMap(([p, e]) => (e ? ['--cacheinfo', `${e.mode},${e.sha},${info.prefix}${p}`] : []));
    for (let i = 0; i < set.length; i += 400) await git(info.top, ['update-index', '--add', '--replace', ...set.slice(i, i + 400)], { env });
    const tree = (await git(info.top, ['write-tree'], { env })).stdout.trim();
    return (await git(info.top, ['commit-tree', tree, ...parents.flatMap((p) => ['-p', p]), '-m', message], { env })).stdout.trim();
  } finally {
    removeTempIndex(tmpIndex);
  }
}

/** The copy's next base: `job`, except files that were skipped keep their old base, so the next bring offers them again. */
async function nextBase(info: RepoInfo, cwd: string, base: string, job: string, skipped: string[]): Promise<string> {
  if (!skipped.length) return job;
  const atBase = await entriesAt(cwd, base, skipped);
  const tmpIndex = tempIndexPath(info);
  const env = { GIT_INDEX_FILE: tmpIndex, ...RLT_IDENTITY };
  try {
    await git(info.top, ['read-tree', job], { env });
    // Removals first, then the old entries with --replace: a submodule the job turned into a folder (sub → sub/x)
    // is a file/folder clash otherwise.
    for (const rel of skipped) if (!atBase.has(rel)) await git(info.top, ['update-index', '--force-remove', '--', `${info.prefix}${rel}`], { env });
    for (const rel of skipped) {
      const b = atBase.get(rel);
      if (b) await git(info.top, ['update-index', '--add', '--replace', '--cacheinfo', `${b.mode},${b.sha},${info.prefix}${rel}`], { env });
    }
    const tree = (await git(info.top, ['write-tree'], { env })).stdout.trim();
    return (await git(info.top, ['commit-tree', tree, '-p', job, '-m', 'rlt: brought into the house (skipped files kept)'], { env })).stdout.trim();
  } finally {
    removeTempIndex(tmpIndex);
  }
}

async function bringCopy(project: Project, jobId: string, wt: JobWorktree, preview: boolean): Promise<BringResult> {
  const house = await repoInfo(project.path);
  if (!house) throw new UserError(`${project.name} isn’t a git repository any more, so nothing can be brought in.`);
  const copy = await repoInfo(wt.path);
  if (!copy) throw new UserError(`The job’s own copy is missing (${wt.root}).`);
  const work = async (): Promise<BringResult> => {
    const base = await resolveCommit(project.path, wt.baseRef);
    if (!base) throw new UserError(`The job’s copy lost track of where it started (${wt.baseRef} is gone).`);
    const job = await withRepoLock(copy.top, () => snapshotCommit(copy, wt.path, `rlt: job ${jobId} of ${project.name}`));
    const steps = await planBring(project.path, base, job);
    if (preview) return { plan: planOf(steps) };
    const at = Date.now();
    const ref = jobRef(project.id, jobId, `bring-${at}`);
    let files: string[] = [];
    let undoable = false;
    if (steps.some((s) => s.action !== 'skip')) {
      // The house before, so the bring can be undone (no snapshot → no bring), with the exact bytes of every path the
      // bring is about to write.
      const msg = `rlt: ${project.name} before bringing in job ${jobId}`;
      const touched = steps.filter((s) => s.action !== 'skip').map((s) => s.path);
      const before = await commitWith(house, await snapshotCommit(house, project.path, msg), await recordHouse(project.path, touched), msg);
      await git(project.path, ['update-ref', '-m', msg, ref, before], { env: RLT_IDENTITY });
      await writeBring(project.path, job, steps);
      files = steps.filter((s) => s.action !== 'skip').map((s) => s.path);
      // The files are in the house now: from here a failure only costs the undo. "After" is "before" with only the
      // written paths changed, never a new snapshot: a .gitignore the bring changed, or the user's edits meanwhile,
      // must not look like part of the bring to Undo.
      undoable = await recordHouse(project.path, files)
        .then((now) => commitWith(house, before, now, `rlt: ${project.name} after bringing in job ${jobId}`))
        .then((after) => git(project.path, ['update-ref', `${ref}-after`, after], { env: RLT_IDENTITY }))
        .then(() => git(project.path, ['update-ref', `${ref}-base`, base], { env: RLT_IDENTITY }))
        .then(() => true, (err) => (log('git', `bring of ${jobId} can't be undone: ${errorMessage(err)}`), false));
    }
    const skipped = steps.filter((s) => s.action === 'skip').map((s) => s.path);
    const next = await nextBase(house, project.path, base, job, skipped);
    await git(project.path, ['update-ref', '-m', 'rlt: brought into the house', wt.baseRef, next, base], { env: RLT_IDENTITY });
    const plan = planOf(steps);
    log('git', `${project.id}/${jobId}: brought ${plan.files.length} file(s) into the house, ${plan.conflicts.length} with conflicts, ${plan.skipped.length} skipped`);
    return { plan, ...(files.length && undoable ? { lastBring: { ref, files, at } } : {}) };
  };
  return preview ? work() : withRepoLock(house.top, work);
}

/** Put the files of the last bring back as they were (files changed again since are kept), and the base with them. */
async function undoBringCopy(project: Project, wt: JobWorktree, dryRun: boolean): Promise<{ files: string[]; kept: string[] }> {
  const last = wt.lastBring;
  if (!last) throw new UserError('There is no bring to undo.');
  const house = await repoInfo(project.path);
  if (!house) throw new UserError(`${project.name} isn’t a git repository any more, so there is nothing to undo.`);
  if (dryRun) {
    const r = await undoRange(house, project.path, last.ref, `${last.ref}-after`, new Set(), true);
    return { files: r.restored, kept: r.kept };
  }
  return withRepoLock(house.top, async () => {
    await snapshot(house, project.path, `pre-revert-${Date.now()}`, `rlt pre-undo of ${last.ref}`).catch((err) => {
      log('git', `pre-undo snapshot failed (continuing): ${errorMessage(err)}`);
    });
    const r = await undoRange(house, project.path, last.ref, `${last.ref}-after`, new Set(), false);
    const before = await resolveCommit(project.path, `${last.ref}-base`);
    if (before) await git(project.path, ['update-ref', '-m', 'rlt: bring undone', wt.baseRef, before], { env: RLT_IDENTITY });
    log('git', `${project.id}: undid ${last.ref}: ${r.restored.length} file(s) back, ${r.kept.length} kept`);
    return { files: r.restored, kept: r.kept };
  });
}

// ───────────────────────── leftover branches of deleted jobs (finding #75) ─────────────────────────
// Deleting a job with its own copy commits the copy to its branch (rlt/<project>/<job>[-n]), which stays. Its base is
// kept too, as refs/rlt/leftover/<branch>, so the house's Changes tab can list the branch and Bring in exactly what the
// job changed since it was last in step with the house — the same 3-way merge into the working files as a job's
// Bring, never touching HEAD, the index or the house's branch. CAST before this kept no base: then the copy's first
// commit (the house when the copy was made) stands in, and files the house already has as the job left them are
// simply skipped. The last bring of a leftover keeps before / after / base under refs/rlt/leftover-bring/<branch>/.

const leftoverBase = (branch: string) => `refs/rlt/leftover/${branch}`;
const leftoverBring = (branch: string, name: 'before' | 'after' | 'base') => `refs/rlt/leftover-bring/${branch}/${name}`;
/** The subject commitCopy() gives a deleted job's last commit; it names the job. */
const DELETED_SUBJECT = /^CAST: (.+) — job deleted$/;
/** The subject createCopy()'s snapshot (the copy's first commit) has. */
const COPY_SUBJECT = /^rlt: .+ for job [^ ]+$/;

/** Branches some worktree has checked out (the house's, live jobs' copies, the user's own worktrees): refs/heads/…. */
async function checkedOut(cwd: string): Promise<Set<string>> {
  const res = await git(cwd, ['worktree', 'list', '--porcelain', '-z'], { env: READ_ONLY });
  return new Set(res.stdout.split('\0').filter((l) => l.startsWith('branch ')).map((l) => l.slice('branch '.length)));
}

/** Any object a ref points at (a tree too), or null. */
async function resolveRef(cwd: string, ref: string): Promise<string | null> {
  const res = await git(cwd, ['rev-parse', '--verify', '-q', ref], { env: READ_ONLY, okCodes: [0, 1, 128] });
  return res.code === 0 ? res.stdout.trim() : null;
}

/** What a leftover branch is compared with: its kept base (exact), else the copy's first commit, else where it
 *  left the house's history, else nothing (every file is new). */
async function leftoverBaseOf(cwd: string, branch: string, tip: string): Promise<{ base: string; exact: boolean }> {
  const kept = await resolveRef(cwd, leftoverBase(branch));
  if (kept) return { base: kept, exact: true };
  const history = await git(cwd, ['log', '--first-parent', '--max-count=2000', '--format=%H%x00%s', tip], { env: READ_ONLY, timeoutMs: 60_000 });
  let first: string | null = null;
  for (const line of history.stdout.split('\n')) {
    const [sha, subject] = line.split('\0');
    if (sha && subject && COPY_SUBJECT.test(subject)) first = sha; // the oldest one wins
  }
  if (first) return { base: first, exact: false };
  const fork = await git(cwd, ['merge-base', 'HEAD', tip], { env: READ_ONLY, okCodes: [0, 1, 128] });
  return { base: fork.code === 0 ? fork.stdout.trim() : EMPTY_TREE, exact: false };
}

/** A branch name the client sent: one of this house's leftover branches (rlt/<project>/…), as a plain ref name. */
function requireLeftoverName(project: Project, branch: string): void {
  const prefix = `rlt/${safeRefName(project.id)}/`;
  const bad = !branch.startsWith(prefix) || branch.length > 300 || !/^[A-Za-z0-9._/-]+$/.test(branch) || /\.\.|\/\/|\/$|\.lock$|@\{/.test(branch);
  if (bad) throw new UserError(`${branch} isn’t a branch a deleted job of ${project.name} left.`);
}

async function requireLeftover(project: Project, branch: string): Promise<{ house: RepoInfo; tip: string }> {
  requireLeftoverName(project, branch);
  const house = await repoInfo(project.path);
  if (!house) throw new UserError(`${project.name} isn’t a git repository any more.`);
  const tip = await resolveCommit(project.path, `refs/heads/${branch}`);
  if (!tip) throw new UserError(`The branch ${branch} is gone.`);
  if ((await checkedOut(project.path)).has(`refs/heads/${branch}`)) throw new UserError(`${branch} is checked out somewhere — it isn’t a leftover.`);
  return { house, tip };
}

/** Files of the last bring of a leftover, for its Undo (null: none, or undone). */
async function lastLeftoverBring(cwd: string, branch: string): Promise<{ at: number; files: string[] } | null> {
  const after = await resolveCommit(cwd, leftoverBring(branch, 'after'));
  const before = after && (await resolveCommit(cwd, leftoverBring(branch, 'before')));
  if (!after || !before) return null;
  const [names, when] = await Promise.all([
    git(cwd, ['diff', '--name-only', '-z', '--no-renames', '--relative', before, after, ...PROJECT_PATHSPEC], { env: READ_ONLY }),
    git(cwd, ['show', '-s', '--format=%ct', after], { env: READ_ONLY }),
  ]);
  return { at: Number(when.stdout.trim()) * 1000, files: names.stdout.split('\0').filter(Boolean) };
}

async function listLeftovers(project: Project): Promise<LeftoverBranch[]> {
  if (!(await repoInfo(project.path))) return [];
  const prefix = `refs/heads/rlt/${safeRefName(project.id)}/`;
  const [refs, busy] = await Promise.all([
    git(project.path, ['for-each-ref', '--format=%(refname)%00%(objectname)%00%(committerdate:unix)%00%(subject)', prefix], { env: READ_ONLY }),
    checkedOut(project.path),
  ]);
  const out: LeftoverBranch[] = [];
  for (const line of refs.stdout.split('\n')) {
    const [ref, tip, date, subject = ''] = line.split('\0');
    if (!ref || !tip || busy.has(ref)) continue;
    const branch = ref.slice('refs/heads/'.length);
    const { base, exact } = await leftoverBaseOf(project.path, branch, tip);
    const names = await git(project.path, ['diff', '--name-only', '-z', '--no-renames', '--relative', base, tip, ...PROJECT_PATHSPEC], { env: READ_ONLY, timeoutMs: 60_000 });
    const last = await lastLeftoverBring(project.path, branch);
    out.push({
      branch,
      job: DELETED_SUBJECT.exec(subject)?.[1] ?? branch.slice(prefix.length - 'refs/heads/'.length),
      at: Number(date) * 1000 || 0,
      files: names.stdout.split('\0').filter(Boolean).length,
      exact,
      ...(last ? { lastBring: last } : {}),
    });
    if (out.length >= 50) break;
  }
  return out.sort((a, b) => b.at - a.at);
}

/** Merge what a leftover branch changed since its base into the house's working files (preview: only say what). */
async function bringLeftover(project: Project, branch: string, preview: boolean): Promise<{ plan: BringPlan; files: string[] }> {
  const { house, tip } = await requireLeftover(project, branch);
  const work = async () => {
    const { base } = await leftoverBaseOf(project.path, branch, tip);
    const steps = await planBring(project.path, base, tip);
    if (preview) return { plan: planOf(steps), files: [] };
    let files: string[] = [];
    if (steps.some((s) => s.action !== 'skip')) {
      const msg = `rlt: ${project.name} before bringing in ${branch}`;
      const touched = steps.filter((s) => s.action !== 'skip').map((s) => s.path);
      const before = await commitWith(house, await snapshotCommit(house, project.path, msg), await recordHouse(project.path, touched), msg);
      // a new bring replaces the undo of the one before
      for (const n of ['after', 'base'] as const) await git(project.path, ['update-ref', '-d', leftoverBring(branch, n)], { okCodes: [0, 1, 128] });
      await git(project.path, ['update-ref', '-m', msg, leftoverBring(branch, 'before'), before], { env: RLT_IDENTITY });
      await writeBring(project.path, tip, steps);
      files = steps.filter((s) => s.action !== 'skip').map((s) => s.path);
      await recordHouse(project.path, files)
        .then((now) => commitWith(house, before, now, `rlt: ${project.name} after bringing in ${branch}`))
        .then((after) => git(project.path, ['update-ref', leftoverBring(branch, 'after'), after], { env: RLT_IDENTITY }))
        .then(() => git(project.path, ['update-ref', leftoverBring(branch, 'base'), base], { env: RLT_IDENTITY }))
        .catch((err) => log('git', `bring of ${branch} can't be undone: ${errorMessage(err)}`));
    }
    const skipped = steps.filter((s) => s.action === 'skip').map((s) => s.path);
    const next = await nextBase(house, project.path, base, tip, skipped);
    await git(project.path, ['update-ref', '-m', 'rlt: brought into the house', leftoverBase(branch), next], { env: RLT_IDENTITY });
    const plan = planOf(steps);
    log('git', `${project.id}: brought ${plan.files.length} file(s) of ${branch} into the house, ${plan.conflicts.length} with conflicts, ${plan.skipped.length} skipped`);
    return { plan, files };
  };
  return preview ? work() : withRepoLock(house.top, work);
}

/** Put the files of a leftover's last bring back (files changed again since are kept), and its base with them. */
async function undoLeftoverBring(project: Project, branch: string, dryRun: boolean): Promise<{ files: string[]; kept: string[] }> {
  requireLeftoverName(project, branch);
  const house = await repoInfo(project.path);
  if (!house) throw new UserError(`${project.name} isn’t a git repository any more, so there is nothing to undo.`);
  const before = leftoverBring(branch, 'before');
  const after = leftoverBring(branch, 'after');
  if (!(await resolveCommit(project.path, after))) throw new UserError('There is no bring to undo.');
  if (dryRun) {
    const r = await undoRange(house, project.path, before, after, new Set(), true);
    return { files: r.restored, kept: r.kept };
  }
  return withRepoLock(house.top, async () => {
    await snapshot(house, project.path, `pre-revert-${Date.now()}`, `rlt pre-undo of ${branch}`).catch((err) => {
      log('git', `pre-undo snapshot failed (continuing): ${errorMessage(err)}`);
    });
    const r = await undoRange(house, project.path, before, after, new Set(), false);
    const base = await resolveRef(project.path, leftoverBring(branch, 'base'));
    if (base) await git(project.path, ['update-ref', '-m', 'rlt: bring undone', leftoverBase(branch), base], { env: RLT_IDENTITY });
    for (const n of ['before', 'after', 'base'] as const) await git(project.path, ['update-ref', '-d', leftoverBring(branch, n)], { okCodes: [0, 1, 128] });
    log('git', `${project.id}: undid the bring of ${branch}: ${r.restored.length} file(s) back, ${r.kept.length} kept`);
    return { files: r.restored, kept: r.kept };
  });
}

/** Delete a leftover branch and what CAST kept for it (its commits go once git collects them). */
async function deleteLeftover(project: Project, branch: string): Promise<void> {
  const { house } = await requireLeftover(project, branch);
  await withRepoLock(house.top, async () => {
    // `branch -D` refuses a branch checked out anywhere (a check above, again by git itself)
    await git(project.path, ['branch', '-D', branch], { env: RLT_IDENTITY });
    for (const ref of [leftoverBase(branch), ...(['before', 'after', 'base'] as const).map((n) => leftoverBring(branch, n))]) {
      await git(project.path, ['update-ref', '-d', ref], { okCodes: [0, 1, 128] });
    }
  });
  log('git', `${project.id}: deleted the leftover branch ${branch}`);
}

// ───────────────────────── undo changes in the house folder (Changes → Undo changes / Undo all) ─────────────────────────
// Puts files of the house folder back as HEAD has them (a file HEAD doesn't have is deleted) and unstages their staged
// changes. First it keeps what was there as a commit under refs/rlt/discarded/<ms>: its tree is HEAD with those paths as
// the folder had them (exact bytes, links as links, a deleted file absent), its parents are HEAD (an empty commit in a
// repository without commits: the "after" side) and the same over the index (what was staged). Bring back merges
// after → kept into the house's files exactly like Bring in (planBring / writeBring) and stages again what was staged,
// where the index still has what the undo left there. Only paths `git status` lists for the house folder are touched:
// never ignored files, nested repositories, .git, or anything outside the folder; a symlink is put back as a link and
// nothing is ever written through one.

const DISCARDED = 'refs/rlt/discarded/';
const KEEP_DISCARDED = 20;
const UNDONE_ID = /^\d{1,16}$/;
const LITERAL = { GIT_LITERAL_PATHSPECS: '1' };

/** Index entries (stage 0) of paths relative to cwd; a path with merge-conflict stages is 'conflict'. */
async function indexEntries(cwd: string, paths: string[]): Promise<Map<string, IndexEntry | 'conflict'>> {
  const out = new Map<string, IndexEntry | 'conflict'>();
  for (let i = 0; i < paths.length; i += 200) {
    const res = await git(cwd, ['ls-files', '-s', '-z', '--', ...paths.slice(i, i + 200)], { env: { ...READ_ONLY, ...LITERAL }, timeoutMs: 60_000 });
    for (const rec of res.stdout.split('\0')) {
      const tab = rec.indexOf('\t');
      if (tab < 0) continue;
      const [mode, sha, stage] = rec.slice(0, tab).split(' ');
      const path = rec.slice(tab + 1);
      if (!mode || !sha) continue;
      if (stage !== '0') out.set(path, 'conflict');
      else if (out.get(path) !== 'conflict') out.set(path, { mode, sha });
    }
  }
  return out;
}

const sameEntry = (a: { mode: string; sha: string } | null | undefined, b: { mode: string; sha: string } | null | undefined) =>
  (!a && !b) || (!!a && !!b && a.mode === b.mode && a.sha === b.sha);

/** A path from the client that can't be a file of the folder (status never lists such paths; this is the second lock). */
function unsafePath(p: string): boolean {
  return !p || p.startsWith('/') || p.includes('\0') || p.endsWith('/') || p.split('/').some((seg) => seg === '' || seg === '.' || seg === '..' || seg.toLowerCase() === '.git');
}

/** The first folder on the way to `rel` (inside root) that is a file or a symlink now, or null. */
function blockingParent(root: string, rel: string): string | null {
  const parts = rel.split('/');
  let cur = '';
  for (let i = 0; i < parts.length - 1; i++) {
    cur = cur ? `${cur}/${parts[i]}` : parts[i]!;
    try {
      if (!lstatSync(join(root, cur)).isDirectory()) return cur;
    } catch {
      return null; // missing: checkout makes it
    }
  }
  return null;
}

interface DiscardPlan {
  restore: string[]; // HEAD has it: back to HEAD's version
  remove: string[]; // HEAD doesn't: deleted
  unstage: string[]; // its staged entry differs from HEAD's
  skipped: { path: string; why: string }[];
  head: string | null; // HEAD's commit
}

async function planDiscard(info: RepoInfo, cwd: string, wanted: string[]): Promise<DiscardPlan> {
  const status = await git(cwd, ['status', '--porcelain=v1', '-z', '--untracked-files=all', '--no-renames', ...PROJECT_PATHSPEC], { env: READ_ONLY, timeoutMs: 60_000 });
  const listed = new Set(parseStatus(status.stdout, info.prefix).map((e) => e.path));
  const plan: DiscardPlan = { restore: [], remove: [], unstage: [], skipped: [], head: info.hasHead ? await resolveCommit(cwd, 'HEAD') : null };
  const asked: string[] = [];
  for (const p of new Set(wanted)) {
    if (p.endsWith('/') && listed.has(p)) plan.skipped.push({ path: p, why: 'is another git repository inside this one — CAST leaves it alone' });
    else if (unsafePath(p) || p === RLT_DIR || p.startsWith(`${RLT_DIR}/`)) plan.skipped.push({ path: p, why: 'isn’t a file of this house' });
    else if (!listed.has(p)) plan.skipped.push({ path: p, why: 'has no changes now' });
    else asked.push(p);
  }
  if (!asked.length) return plan;
  const [atHead, staged] = await Promise.all([plan.head ? entriesAt(cwd, plan.head, asked) : Promise.resolve(new Map<string, TreeEntry>()), indexEntries(cwd, asked)]);
  const root = resolve(cwd);
  const removing = new Set<string>();
  const restoring: string[] = [];
  for (const p of asked) {
    const h = atHead.get(p);
    const s = staged.get(p);
    if (s === 'conflict') plan.skipped.push({ path: p, why: 'has a merge conflict in git — sort it out in git first' });
    else if ((h && h.type !== 'blob') || s?.mode === '160000') plan.skipped.push({ path: p, why: 'is a submodule — CAST leaves it alone' });
    else if (h) restoring.push(p);
    else {
      let dir = false;
      try {
        dir = lstatSync(join(root, p)).isDirectory();
      } catch {
        /* gone already: only its staged entry goes */
      }
      if (dir) plan.skipped.push({ path: p, why: 'is a folder — CAST only deletes files' });
      else removing.add(p);
    }
  }
  for (const p of restoring) {
    // A folder on the way that is a link or a file now: git would replace it with a folder, so only when it goes too.
    const blocker = blockingParent(root, p);
    if (blocker && !removing.has(blocker)) {
      plan.skipped.push({ path: p, why: `the folder ${blocker} is a link or a file now — undo ${blocker} too` });
      continue;
    }
    plan.restore.push(p);
  }
  plan.remove = [...removing];
  const touched = [...plan.restore, ...plan.remove];
  plan.unstage = touched.filter((p) => {
    const s = staged.get(p);
    const h = atHead.get(p);
    return !sameEntry(s === 'conflict' ? null : s, h ? { mode: h.mode, sha: h.sha } : null);
  });
  return plan;
}

/** An empty commit (the "after" side of an undo in a repository with no commits yet). */
async function emptyCommit(info: RepoInfo): Promise<string> {
  const tmpIndex = tempIndexPath(info);
  try {
    const env = { GIT_INDEX_FILE: tmpIndex, ...RLT_IDENTITY };
    const tree = (await git(info.top, ['write-tree'], { env })).stdout.trim();
    return (await git(info.top, ['commit-tree', tree, '-m', 'rlt: nothing yet'], { env })).stdout.trim();
  } finally {
    removeTempIndex(tmpIndex);
  }
}

/** Keep what the folder and the index have at `paths` (see the section comment). Returns the ref and its id. */
async function keepDiscarded(info: RepoInfo, cwd: string, project: Project, head: string | null, paths: string[]): Promise<{ ref: string; id: string; at: number }> {
  const base = head ?? (await emptyCommit(info));
  const staged = await indexEntries(cwd, paths);
  const indexState = new Map<string, IndexEntry>(paths.map((p) => {
    const s = staged.get(p);
    return [p, s && s !== 'conflict' ? s : null];
  }));
  const index = await commitWith(info, base, indexState, `rlt: staged before undoing ${paths.length} file(s) in ${project.name}`);
  return keepUndone(info, cwd, project, base, index, paths);
}

/** The kept commit itself: `after` (what the undo leaves at `paths`) with the folder's files as they are now, parents
 *  [after, index]; under refs/rlt/discarded/<ms>, the oldest beyond KEEP_DISCARDED dropped. */
async function keepUndone(info: RepoInfo, cwd: string, project: Project, after: string, index: string, paths: string[]): Promise<{ ref: string; id: string; at: number }> {
  const n = paths.length;
  const kept = await commitWith(info, after, await recordHouse(cwd, paths), `CAST: undid changes to ${n} file${n === 1 ? '' : 's'} in ${project.name}`, [after, index]);
  let at = Date.now();
  while (await resolveRef(cwd, `${DISCARDED}${at}`)) at++;
  const ref = `${DISCARDED}${at}`;
  await git(cwd, ['update-ref', '-m', 'rlt: undo changes', ref, kept, ''], { env: RLT_IDENTITY });
  // Keep the last KEEP_DISCARDED (ids are times: the biggest are the newest).
  const all = (await git(cwd, ['for-each-ref', '--format=%(refname)', DISCARDED], { env: READ_ONLY })).stdout.split('\n').filter((r) => UNDONE_ID.test(r.slice(DISCARDED.length)));
  all.sort((a, b) => Number(b.slice(DISCARDED.length)) - Number(a.slice(DISCARDED.length)));
  for (const old of all.slice(KEEP_DISCARDED)) await git(cwd, ['update-ref', '-d', old], { okCodes: [0, 1, 128] });
  return { ref, id: String(at), at };
}

async function discardChanges(project: Project, paths: string[], preview: boolean): Promise<DiscardResult> {
  const info = await repoInfo(project.path);
  if (!info) throw new UserError(`${project.name} isn’t a git repository, so CAST can’t undo changes in it.`);
  const cwd = project.path;
  const work = async (): Promise<DiscardResult> => {
    const plan = await planDiscard(info, cwd, paths);
    const files = [...plan.restore, ...plan.remove].sort((a, b) => a.localeCompare(b));
    if (preview || !files.length) return { files, skipped: plan.skipped };
    // 1. Keep what is there. 2. Unstage (git refuses when the index is locked: then nothing has changed yet).
    // 3. Delete what HEAD doesn't have. 4. Write HEAD's version of the rest (git never writes through a link).
    const saved = await keepDiscarded(info, cwd, project, plan.head, files);
    if (plan.unstage.length) {
      const input = `${plan.unstage.join('\0')}\0`;
      const args = plan.head
        ? ['reset', '-q', plan.head, '--pathspec-from-file=-', '--pathspec-file-nul']
        : ['rm', '--cached', '-q', '-f', '--ignore-unmatch', '--pathspec-from-file=-', '--pathspec-file-nul'];
      await git(cwd, args, { env: LITERAL, input, okCodes: [0, 1], timeoutMs: 60_000 }).catch((err) => {
        throw new UserError(`Couldn’t unstage the files, so nothing was changed: ${errorMessage(err)}`);
      });
    }
    const root = resolve(cwd);
    const done: string[] = [];
    const skipped = [...plan.skipped];
    for (const rel of plan.remove) {
      const abs = resolve(root, rel);
      try {
        if (!isInside(root, abs) || abs === root) throw new Error('outside the house');
        rmSync(abs, { force: true }); // a link goes as a link: rmSync never follows it
        pruneEmptyDirs(dirname(abs), root);
        done.push(rel);
      } catch (err) {
        skipped.push({ path: rel, why: `couldn’t be deleted: ${errorMessage(err)}` });
      }
    }
    const restore: string[] = [];
    for (const rel of plan.restore) {
      const abs = resolve(root, rel);
      try {
        if (!isInside(root, abs) || abs === root) throw new Error('outside the house');
        if (blockingParent(root, rel)) throw new Error('a folder on the way is a link or a file');
        // A folder where HEAD has a file: only an empty one goes (its files were deleted above, or it had none).
        if (lstatSync(abs, { throwIfNoEntry: false })?.isDirectory()) rmdirSync(abs);
        restore.push(rel);
      } catch (err) {
        skipped.push({ path: rel, why: (err as NodeJS.ErrnoException).code === 'ENOTEMPTY' ? 'is a folder with other files in it now' : `couldn’t be put back: ${errorMessage(err)}` });
      }
    }
    if (restore.length) {
      const tmpIndex = tempIndexPath(info);
      const env = { GIT_INDEX_FILE: tmpIndex };
      try {
        await git(cwd, ['read-tree', plan.head!], { env });
        for (let i = 0; i < restore.length; i += 200) await git(cwd, ['checkout-index', '-f', '--', ...restore.slice(i, i + 200)], { env, timeoutMs: 120_000 });
      } finally {
        removeTempIndex(tmpIndex);
      }
      done.push(...restore);
    }
    done.sort((a, b) => a.localeCompare(b));
    log('git', `${project.id}: undid changes to ${done.length} file(s) (kept as ${saved.ref})${skipped.length ? `, ${skipped.length} left alone` : ''}`);
    return { files: done, skipped, saved: { id: saved.id, at: saved.at, files } };
  };
  return preview ? work() : withRepoLock(info.top, work);
}

// ── one chat turn (turn-changes.ts): the folder before and after it, under refs/rlt/turns/<id>-from / -to ──

const TURNS = 'refs/rlt/turns/';
const KEEP_TURN_REFS = 100; // 50 turns

/** Snapshot the folder (tracked + untracked, not ignored; HEAD, index and branch untouched) into `ref` (refs/rlt/turns/…);
 *  null when it isn't a git folder. */
async function snapshotFolder(path: string, ref: string, message: string): Promise<string | null> {
  if (!ref.startsWith(TURNS)) throw new Error(`not a turn ref: ${ref}`);
  const info = await repoInfo(path);
  if (!info) return null;
  return withRepoLock(info.top, () => snapshotTo(info, path, ref, message));
}

/** Files of the folder that differ between two snapshots (relative to it, minus .rlt/). */
async function changedBetween(path: string, from: string, to: string): Promise<string[]> {
  const res = await git(path, ['diff', '--name-only', '-z', '--no-renames', '--relative', from, to, ...PROJECT_PATHSPEC], { env: READ_ONLY, timeoutMs: 60_000 });
  return res.stdout.split('\0').filter(Boolean).sort((a, b) => a.localeCompare(b));
}

/** Drop turn snapshots: these refs, then all but the newest KEEP_TURN_REFS (ids start with the time). */
async function dropTurns(path: string, refs: string[] = []): Promise<void> {
  if (!(await repoInfo(path))) return;
  for (const r of refs) if (r.startsWith(TURNS)) await git(path, ['update-ref', '-d', r], { okCodes: [0, 1, 128] });
  const all = (await git(path, ['for-each-ref', '--format=%(refname)', TURNS], { env: READ_ONLY })).stdout.split('\n').filter(Boolean);
  const time = (r: string) => Number(/^(\d+)/.exec(r.slice(TURNS.length))?.[1] ?? 0);
  all.sort((a, b) => time(b) - time(a) || b.localeCompare(a));
  for (const old of all.slice(KEEP_TURN_REFS)) await git(path, ['update-ref', '-d', old], { okCodes: [0, 1, 128] });
}

/** Undo one turn: the files it changed (from → to) go back to `from`, but only when none was changed again since
 *  (else nothing happens: `kept` names them). What is replaced is kept first like Undo changes (Bring back). */
async function undoTurn(project: Project, from: string, to: string, preview: boolean): Promise<{ files: string[]; kept: string[]; saved?: UndoneChanges }> {
  if (!from.startsWith(TURNS) || !to.startsWith(TURNS)) throw new UserError('That isn’t a turn CAST kept.');
  const info = await repoInfo(project.path);
  if (!info) throw new UserError(`${project.name} isn’t a git repository any more, so the turn can’t be undone.`);
  const cwd = project.path;
  const work = async () => {
    if (!(await resolveCommit(cwd, from)) || !(await resolveCommit(cwd, to))) throw new UserError('That turn is too old — CAST keeps the last 50. Undo its files in the Changes tab instead.');
    const dry = await undoRange(info, cwd, from, to, new Set(), true);
    if (preview || dry.kept.length || !dry.restored.length) return { files: dry.restored, kept: dry.kept };
    // What the undo leaves: HEAD with those paths as they were before the turn; nothing staged changes.
    const head = info.hasHead ? await resolveCommit(cwd, 'HEAD') : null;
    const base = head ?? (await emptyCommit(info));
    const before = await entriesAt(cwd, from, dry.restored);
    const after = await commitWith(info, base, new Map(dry.restored.map((p) => {
      const e = before.get(p);
      return [p, e && e.type === 'blob' ? { mode: e.mode, sha: e.sha } : null];
    })), `rlt: ${project.name} with a turn undone`);
    const index = await commitWith(info, after, new Map(), 'rlt: nothing staged changes', [after]);
    const saved = await keepUndone(info, cwd, project, after, index, dry.restored);
    const r = await undoRange(info, cwd, from, to, new Set(), false);
    log('git', `${project.id}: undid a turn (${from}): ${r.restored.length} file(s) back, ${r.kept.length} kept (kept as ${saved.ref})`);
    return { files: r.restored, kept: r.kept, saved: { id: saved.id, at: saved.at, files: dry.restored } };
  };
  return preview ? work() : withRepoLock(info.top, work);
}

/** The two parents of a kept undo: what the undo left (after) and what was staged before it (index). */
async function undoneParents(cwd: string, kept: string): Promise<{ after: string; index: string } | null> {
  const res = await git(cwd, ['rev-list', '--parents', '-n', '1', kept], { env: READ_ONLY, okCodes: [0, 128] });
  const [, after, index] = res.stdout.trim().split(' ');
  return after && index ? { after, index } : null;
}

async function undoneFiles(cwd: string, kept: string, p: { after: string; index: string }): Promise<string[]> {
  const names = async (to: string) => (await git(cwd, ['diff', '--name-only', '-z', '--no-renames', '--relative', p.after, to, ...PROJECT_PATHSPEC], { env: READ_ONLY, timeoutMs: 60_000 })).stdout.split('\0').filter(Boolean);
  const [worktree, staged] = await Promise.all([names(kept), names(p.index)]);
  return [...new Set([...worktree, ...staged])].sort((a, b) => a.localeCompare(b));
}

async function listUndone(project: Project): Promise<UndoneChanges[]> {
  if (!(await repoInfo(project.path))) return [];
  const cwd = project.path;
  const refs = await git(cwd, ['for-each-ref', '--format=%(refname)%00%(objectname)', DISCARDED], { env: READ_ONLY });
  const out: UndoneChanges[] = [];
  for (const line of refs.stdout.split('\n')) {
    const [ref, kept] = line.split('\0');
    const id = ref?.slice(DISCARDED.length) ?? '';
    if (!kept || !UNDONE_ID.test(id)) continue;
    const parents = await undoneParents(cwd, kept);
    if (!parents) continue;
    // A repository can hold more than one house (subfolders): show only what was undone in this one.
    const files = await undoneFiles(cwd, kept, parents);
    if (files.length) out.push({ id, at: Number(id), files });
  }
  return out.sort((a, b) => b.at - a.at);
}

/** Bring back what an undo kept: its files merge into the house's (like Bring in); staged entries come back where the
 *  index still has what the undo left. A bring back that wrote every file forgets the undo. */
async function bringBackUndone(project: Project, id: string, preview: boolean): Promise<{ plan: BringPlan }> {
  if (!UNDONE_ID.test(id)) throw new UserError('That isn’t an undo CAST kept.');
  const info = await repoInfo(project.path);
  if (!info) throw new UserError(`${project.name} isn’t a git repository any more, so there is nothing to bring back.`);
  const cwd = project.path;
  const ref = `${DISCARDED}${id}`;
  const work = async () => {
    const kept = await resolveCommit(cwd, ref);
    const parents = kept && (await undoneParents(cwd, kept));
    if (!kept || !parents) throw new UserError(`That undo is no longer kept — CAST keeps the last ${KEEP_DISCARDED}.`);
    const steps = await planBring(cwd, parents.after, kept, ['now', 'undone', 'brought back']);
    if (preview) {
      // Say what the second pass below will take: a skipped path where the house has a folder whose files all go.
      const going = new Set(steps.filter((s) => s.action === 'take' && !s.job).map((s) => s.path));
      for (const s of steps) if (s.action === 'skip' && folderEmptiedBy(cwd, s.path, going)) s.action = 'take';
      return { plan: planOf(steps) };
    }
    const writes = steps.filter((s) => s.action !== 'skip').map((s) => s.path);
    if (steps.some((s) => s.action === 'merge' || s.action === 'conflict')) {
      // Files changed again since the undo get merged: keep them as they are now first.
      const msg = `rlt: ${project.name} before bringing back ${id}`;
      const before = await commitWith(info, parents.after, await recordHouse(cwd, writes), msg);
      await git(cwd, ['update-ref', '-m', msg, `refs/rlt/checkpoints/pre-bring-back-${id}-${Date.now()}`, before], { env: RLT_IDENTITY });
    }
    await writeBring(cwd, kept, steps);
    // A link or file the undo turned into a folder (lib → lib/a.txt) waits for that folder's files to go: once the
    // first pass deleted them, it can be taken. Only paths the first pass skipped are looked at again.
    const waiting = new Set(steps.filter((s) => s.action === 'skip').map((s) => s.path));
    if (waiting.size) {
      const again = (await planBring(cwd, parents.after, kept, ['now', 'undone', 'brought back'])).filter((s) => waiting.has(s.path) && s.action === 'take');
      await writeBring(cwd, kept, again);
      for (const s of again) if (s.action === 'take') Object.assign(steps.find((x) => x.path === s.path)!, { action: 'take' });
    }
    await restage(info, cwd, parents);
    const plan = planOf(steps);
    if (!plan.skipped.length && !plan.conflicts.length) await git(cwd, ['update-ref', '-d', ref, kept], { okCodes: [0, 1, 128] });
    log('git', `${project.id}: brought back ${plan.files.length} file(s) of ${ref}, ${plan.conflicts.length} with conflicts, ${plan.skipped.length} left alone`);
    return { plan };
  };
  return preview ? work() : withRepoLock(info.top, work);
}

/** `rel` is a real folder (not a link) and every file in it is in `going`: deleting them leaves it empty. */
function folderEmptiedBy(cwd: string, rel: string, going: Set<string>): boolean {
  let seen = 0;
  const walk = (d: string): boolean => {
    for (const e of readdirSync(join(cwd, d), { withFileTypes: true })) {
      if (++seen > 1000) return false;
      const p = `${d}/${e.name}`;
      if (e.isDirectory() ? !walk(p) : !going.has(p)) return false;
    }
    return true;
  };
  try {
    return lstatSync(join(cwd, rel)).isDirectory() && !blockingParent(cwd, rel) && walk(rel);
  } catch {
    return false;
  }
}

/** Stage again what was staged before the undo, for paths whose index entry is still what the undo left there. */
async function restage(info: RepoInfo, cwd: string, p: { after: string; index: string }): Promise<void> {
  const names = (await git(cwd, ['diff', '--name-only', '-z', '--no-renames', '--relative', p.after, p.index, ...PROJECT_PATHSPEC], { env: READ_ONLY })).stdout.split('\0').filter(Boolean);
  if (!names.length) return;
  const [after, wanted, now] = await Promise.all([entriesAt(cwd, p.after, names), entriesAt(cwd, p.index, names), indexEntries(cwd, names)]);
  for (const rel of names) {
    const cur = now.get(rel);
    if (cur === 'conflict' || !sameEntry(cur, after.get(rel))) continue; // changed in the index since: leave it
    const want = wanted.get(rel);
    const full = `${info.prefix}${rel}`;
    await (want
      ? git(info.top, ['update-index', '--add', '--cacheinfo', `${want.mode},${want.sha},${full}`])
      : git(info.top, ['update-index', '--force-remove', '--', full])
    ).catch((err) => log('git', `couldn’t stage ${rel} again: ${errorMessage(err)}`));
  }
}

// ───────────────────────── repo setup helpers ─────────────────────────

/** Make sure `.rlt/` (run artifacts) is listed in the repo's info/exclude so it never shows up in diffs. */
async function ensureRltExcluded(path: string): Promise<void> {
  const info = await repoInfo(path);
  if (!info) return;
  const rel = (await git(path, ['rev-parse', '--git-path', 'info/exclude'], { env: READ_ONLY })).stdout.trim();
  const file = isAbsolute(rel) ? rel : resolve(path, rel);
  const current = existsSync(file) ? readFileSync(file, 'utf8') : '';
  if (current.split('\n').some((l) => l.trim() === `${RLT_DIR}/` || l.trim() === `/${RLT_DIR}/`)) return;
  const sep = current && !current.endsWith('\n') ? '\n' : '';
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `${current}${sep}# CAST run artifacts\n${RLT_DIR}/\n`);
}

async function hasIdentity(path: string): Promise<boolean> {
  const res = await git(path, ['config', 'user.email'], { okCodes: [0, 1] });
  return res.code === 0 && res.stdout.trim() !== '';
}

/** `git init -b main` + exclude .rlt/ + initial commit of everything in the folder. */
async function initRepo(path: string, message: string): Promise<void> {
  if (!(await repoInfo(path))) await git(path, ['init', '-q', '-b', 'main']);
  await ensureRltExcluded(path);
  const env = (await hasIdentity(path)) ? {} : RLT_IDENTITY;
  await git(path, ['add', '-A'], { timeoutMs: 60_000 });
  await git(path, ['-c', 'commit.gpgsign=false', 'commit', '-q', '--no-verify', '--allow-empty', '-m', message], { env });
}

/** What a first commit of someone's own folder leaves out (written to .git/info/exclude, never to their files):
 *  dependency folders that would make it huge, and secrets that must not end up in a history they may push later. */
/** What Set up git leaves out of its first commit; the UI's SET_UP_GIT_TEXT names these (tests/onboard checks it). */
export const SETUP_EXCLUDES = ['node_modules/', '.venv/', 'venv/', '__pycache__/', '.DS_Store', '*.log', '.env', '.env.*'];

/** Turn an existing folder that is not in any repository into one (Place project → Initialize git, Changes → Set up
 *  git): `git init -b main`, the excludes above, and a first commit of what is there — the baseline every later change
 *  is shown and undone against. Only the .git folder is added; if any step fails it is removed again (we made it). */
async function setUpGit(path: string): Promise<void> {
  if (await repoInfo(path)) throw new UserError('This folder is already in a git repository.');
  const dotGit = join(path, '.git');
  if (existsSync(dotGit)) throw new UserError('This folder has a .git entry that git can’t read — fix it by hand first.');
  try {
    await git(path, ['init', '-q', '-b', 'main']);
    const exclude = join(dotGit, 'info', 'exclude');
    const current = existsSync(exclude) ? readFileSync(exclude, 'utf8') : '';
    mkdirSync(dirname(exclude), { recursive: true });
    writeFileSync(exclude, `${current}${current && !current.endsWith('\n') ? '\n' : ''}# Left out by CAST when it set up git here\n${SETUP_EXCLUDES.join('\n')}\n# CAST run artifacts\n${RLT_DIR}/\n`);
    const env = (await hasIdentity(path)) ? {} : RLT_IDENTITY;
    await git(path, ['add', '-A'], { timeoutMs: 120_000 });
    await git(path, ['-c', 'commit.gpgsign=false', 'commit', '-q', '--no-verify', '--allow-empty', '-m', 'Starting point (set up by CAST)'], { env, timeoutMs: 60_000 });
  } catch (err) {
    rmSync(dotGit, { recursive: true, force: true });
    throw err instanceof UserError ? err : new UserError(`Couldn’t set up git: ${errorMessage(err)}`);
  }
}

export interface BringResult {
  plan: BringPlan;
  /** Set when the bring changed house files (what Undo last bring puts back). */
  lastBring?: NonNullable<JobWorktree['lastBring']>;
}

export interface CoreGitService extends GitService {
  initRepo(path: string, message: string): Promise<void>;
  /** Make an existing folder that is in no repository a git repo with a first commit (UserError when it can't). */
  setUpGit(path: string): Promise<void>;
  ensureRltExcluded(path: string): Promise<void>;
  /** A job's own copy of the house's files at `root` (uncommitted work included). UserError when it can't be made. */
  createJobCopy(project: Project, jobId: string, root: string): Promise<JobWorktree>;
  /** Commit what the copy has to its branch (kept), remove the worktree and its base ref (a copy holding files no
   *  commit keeps — ignored ones, nested repos — moves to <dataDir>/worktrees-kept as a plain folder). Returns the
   *  branch that keeps the work (null: the copy was gone). discard: a copy nobody used — its branch goes too. */
  removeJobCopy(project: Project, jobName: string, wt: JobWorktree, opts?: { discard?: boolean; onKept?: (dir: string, files: string[]) => void }): Promise<string | null>;
  /** Merge what the copy changed since its base into the house's working files (preview: only say what). */
  bringJobChanges(project: Project, jobId: string, wt: JobWorktree, preview: boolean): Promise<BringResult>;
  /** Put the files of the copy's last bring back (files changed again since are kept); dryRun: only say which. */
  undoBring(project: Project, wt: JobWorktree, dryRun?: boolean): Promise<{ files: string[]; kept: string[] }>;
  /** Branches deleted jobs left in the house's repository (finding #75), newest first. */
  listLeftovers(project: Project): Promise<LeftoverBranch[]>;
  /** Merge what a leftover branch changed into the house's files (preview: only say what); `files`: those written. */
  bringLeftover(project: Project, branch: string, preview: boolean): Promise<{ plan: BringPlan; files: string[] }>;
  /** Put the files of a leftover's last bring back; dryRun: only say which. */
  undoLeftoverBring(project: Project, branch: string, dryRun?: boolean): Promise<{ files: string[]; kept: string[] }>;
  deleteLeftover(project: Project, branch: string): Promise<void>;
  /** Changes → Undo changes: put house-folder files back as HEAD has them (new ones deleted, staged changes unstaged),
   *  keeping what was there under refs/rlt/discarded/<ms> (the last 20); preview: only say what. */
  discardChanges(project: Project, paths: string[], preview?: boolean): Promise<DiscardResult>;
  /** What Undo changes kept for this house folder, newest first. */
  listUndone(project: Project): Promise<UndoneChanges[]>;
  /** Merge what an undo kept back into the house's files (preview: only say what). */
  bringBackUndone(project: Project, id: string, preview?: boolean): Promise<{ plan: BringPlan }>;
  snapshotFolder(path: string, ref: string, message: string): Promise<string | null>;
  changedBetween(path: string, from: string, to: string): Promise<string[]>;
  dropTurns(path: string, refs?: string[]): Promise<void>;
  undoTurn(project: Project, from: string, to: string, preview?: boolean): Promise<{ files: string[]; kept: string[]; saved?: UndoneChanges }>;
  /** Forget RLT's own copies (under opts.worktreesDir) whose folders are gone (a house leaves the town; its jobs'
   *  copies stay on disk). Never a plain `worktree prune`, which would drop the user's own moved worktrees too. */
  pruneWorktrees(path: string): Promise<void>;
}

/** Linked worktrees git lists as prunable (their folder is gone), from `worktree list --porcelain -z`. */
async function missingWorktrees(cwd: string): Promise<string[]> {
  const res = await git(cwd, ['worktree', 'list', '--porcelain', '-z'], { env: READ_ONLY });
  const out: string[] = [];
  let path: string | null = null;
  for (const line of res.stdout.split('\0')) {
    if (line.startsWith('worktree ')) path = line.slice('worktree '.length);
    else if (path && (line === 'prunable' || line.startsWith('prunable '))) out.push(path);
    else if (!line) path = null;
  }
  return out;
}

export function createGitService(opts: { worktreesDir?: string } = {}): CoreGitService {
  return {
    async isGit(path) {
      return (await repoInfo(path)) !== null;
    },

    summary(project, job) {
      return job?.worktree ? summarizeCopy(project, job.id, job.worktree) : summarize(project);
    },

    async checkpoint(project, runId) {
      const info = await repoInfo(project.path);
      if (!info) return null;
      return withRepoLock(info.top, () =>
        snapshot(info, project.path, safeRefName(runId), `rlt checkpoint run=${runId}`),
      );
    },

    async revert(project, ref) {
      const info = await repoInfo(project.path);
      if (!info) throw new UserError(`${project.name} is not a git repository, so there is nothing to revert to.`);
      await withRepoLock(info.top, async () => {
        // Snapshot first so the revert itself can be undone.
        const undo = await snapshot(info, project.path, `pre-revert-${Date.now()}`, `rlt pre-revert of ${ref}`).catch((err) => {
          log('git', `pre-revert snapshot failed (continuing): ${errorMessage(err)}`);
          return null;
        });
        const { removed } = await restore(info, project.path, ref);
        log('git', `reverted ${project.id} to ${ref} (removed ${removed} new file(s); undo: ${undo ?? 'n/a'})`);
      });
    },

    async undoRun(project, from, to, opts = {}) {
      const info = await repoInfo(project.path);
      if (!info) throw new UserError(`${project.name} is not a git repository, so there is nothing to revert to.`);
      const keep = new Set(opts.keep ?? []);
      if (opts.dryRun) return undoRange(info, project.path, from, to, keep, true);
      return withRepoLock(info.top, async () => {
        const undo = await snapshot(info, project.path, `pre-revert-${Date.now()}`, `rlt pre-revert of ${from}`).catch((err) => {
          log('git', `pre-revert snapshot failed (continuing): ${errorMessage(err)}`);
          return null;
        });
        const r = await undoRange(info, project.path, from, to, keep, false);
        log('git', `undid ${project.id} ${from}..${to}: ${r.restored.length} file(s) restored, ${r.kept.length} kept (undo: ${undo ?? 'n/a'})`);
        return r;
      });
    },

    initRepo,
    ensureRltExcluded,
    setUpGit,
    createJobCopy: createCopy,

    async removeJobCopy(project, jobName, wt, opts = {}) {
      if (!opts.discard) return removeCopy(project, jobName, wt, opts.onKept);
      await dropCopy(project.path, wt);
      return null;
    },

    bringJobChanges: bringCopy,
    undoBring: (project, wt, dryRun = false) => undoBringCopy(project, wt, dryRun),
    listLeftovers,
    bringLeftover,
    undoLeftoverBring: (project, branch, dryRun = false) => undoLeftoverBring(project, branch, dryRun),
    deleteLeftover,
    discardChanges: (project, paths, preview = false) => discardChanges(project, paths, preview),
    listUndone,
    bringBackUndone: (project, id, preview = false) => bringBackUndone(project, id, preview),
    snapshotFolder,
    changedBetween,
    dropTurns,
    undoTurn: (project, from, to, preview = false) => undoTurn(project, from, to, preview),

    async pruneWorktrees(path) {
      const under = opts.worktreesDir && resolve(opts.worktreesDir);
      if (!under || !(await repoInfo(path))) return;
      for (const wt of await missingWorktrees(path).catch(() => [])) {
        if (isInside(under, resolve(wt)) && resolve(wt) !== under) await git(path, ['worktree', 'remove', '--force', wt], { okCodes: [0, 128] }).catch(() => null);
      }
    },
  };
}
