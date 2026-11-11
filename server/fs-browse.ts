// Folder browser for the place-project dialog. Every path is resolved with realpath and must stay inside one
// of the allowed roots (CAST_FS_ROOTS), so neither `../` nor symlinks can escape.
import { existsSync, readdirSync, realpathSync, statSync, type Dirent } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import type { FsEntry } from '../shared/protocol';
import { errorMessage, isInside, UserError } from './util';

const MAX_ENTRIES = 1000;

export interface FsListing {
  path: string;
  parent: string | null;
  entries: FsEntry[];
  error?: string;
  /** The listed folder is inside a git repository (it or a folder above it has .git). */
  isGit?: boolean;
}

/** `dir` or one of the folders above it holds a .git entry — the same answer `git rev-parse` gives in the cases the
 *  picker cares about, without running git for every folder the user opens. */
export function insideGitRepo(dir: string): boolean {
  for (let d = dir; ; d = dirname(d)) {
    if (existsSync(join(d, '.git'))) return true;
    if (dirname(d) === d) return false;
  }
}

export interface FsBrowser {
  readonly roots: string[];
  /** Resolve a user-supplied directory path to its realpath; throws UserError when it is missing or outside the roots. */
  resolveDir(path: string): string;
  list(path: string): FsListing;
}

function realpathOrNull(p: string): string | null {
  try {
    return realpathSync(p);
  } catch {
    return null;
  }
}

function friendlyFsError(err: unknown): string {
  const code = (err as NodeJS.ErrnoException)?.code;
  if (code === 'EACCES' || code === 'EPERM') return 'Permission denied';
  if (code === 'ENOENT') return 'Folder not found';
  if (code === 'ENOTDIR') return 'Not a folder';
  return errorMessage(err);
}

export function createFsBrowser(rootPaths: string[]): FsBrowser {
  // Canonicalize roots once; drop roots that do not exist. None left is not fatal (the server still runs — the
  // startup log says so): the picker then explains instead of the server refusing to start.
  const roots = rootPaths.map((r) => realpathOrNull(resolve(r))).filter((r): r is string => r !== null);
  const noRoots = `None of the folders CAST may browse exist (${rootPaths.join(', ')}). Set CAST_FS_ROOTS to folders on this machine and restart CAST.`;

  const allowed = (real: string) => roots.some((r) => isInside(r, real));
  const isRoot = (real: string) => roots.includes(real);

  function resolveDir(input: string): string {
    if (roots.length === 0) throw new UserError(noRoots);
    const raw = (input ?? '').trim();
    const wanted = !raw || raw === '~' ? roots[0]! : isAbsolute(raw) ? resolve(raw) : resolve(roots[0]!, raw);
    const real = realpathOrNull(wanted);
    if (!real) throw new UserError('Folder not found');
    if (!allowed(real)) throw new UserError(`That folder is outside the places CAST may browse (${roots.join(', ')})`);
    let st;
    try {
      st = statSync(real);
    } catch (err) {
      throw new UserError(friendlyFsError(err));
    }
    if (!st.isDirectory()) throw new UserError('Not a folder');
    return real;
  }

  /** Classify a directory entry; symlinks are followed but only kept when their target stays inside the roots. */
  function toEntry(dir: string, d: Dirent): FsEntry | null {
    if (d.name.startsWith('.')) return null;
    const full = join(dir, d.name);
    let isDir = d.isDirectory();
    if (d.isSymbolicLink()) {
      const target = realpathOrNull(full);
      if (!target || !allowed(target)) return null;
      try {
        isDir = statSync(target).isDirectory();
      } catch {
        return null;
      }
    } else if (!d.isFile() && !isDir) {
      return null; // sockets, fifos, devices
    }
    const entry: FsEntry = { name: d.name, isDir };
    if (isDir && existsSync(join(full, '.git'))) entry.isGit = true;
    return entry;
  }

  function list(input: string): FsListing {
    let dir: string;
    try {
      dir = resolveDir(input);
    } catch (err) {
      return { path: String(input ?? ''), parent: null, entries: [], error: errorMessage(err) };
    }
    const parentReal = dirname(dir);
    const parent = isRoot(dir) || !allowed(parentReal) ? null : parentReal;
    let dirents: Dirent[];
    try {
      dirents = readdirSync(dir, { withFileTypes: true });
    } catch (err) {
      return { path: dir, parent, entries: [], error: friendlyFsError(err) };
    }
    const entries = dirents
      .map((d) => toEntry(dir, d))
      .filter((e): e is FsEntry => e !== null)
      .sort((a, b) => (a.isDir !== b.isDir ? (a.isDir ? -1 : 1) : a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' })));
    return { path: dir, parent, entries: entries.slice(0, MAX_ENTRIES), isGit: insideGitRepo(dir) };
  }

  return { roots, resolveDir, list };
}
