// Paths people write (chat replies, tool cards) → a file of a person's folder the viewer can show, or why not.
// Pure (no DOM, no store): callers pass the folders to resolve against (personRoots builds them from the store).
import type { AgentInfo, Job, Project } from '../../../shared/protocol';
import type { FolderRef } from '../net/files';
import { isKnownFileName } from './file-kinds';
import { fuzzy } from './fuzzy';

/** A folder and the absolute path it is on the machine. */
export interface RootChoice {
  root: string; // absolute, no trailing '/'
  folder: FolderRef;
}

/** A file (or a folder: dir) inside a person's folder; path is '/'-separated and relative ('' = the folder itself). */
export interface FileRef {
  folder: FolderRef;
  path: string;
  dir?: boolean;
}

export type Resolved = ({ ok: true } & FileRef) | { ok: false; why: string };

export const OUTSIDE_WHY = 'Outside this house — CAST can only open files inside the house’s folder.';
export const HIDDEN_WHY = 'A hidden file (a name starting with “.”) — CAST doesn’t open those.';
export const NO_FOLDER_WHY = 'CAST doesn’t know this person’s folder right now.';

const trimSlash = (p: string) => (p.length > 1 ? p.replace(/\/+$/, '') : p);

/** The folders a person's paths can point into, its own first: its job's own copy (when it has one), then the house. */
export function rootsFor(project: Pick<Project, 'id' | 'path'> | undefined, job?: Pick<Job, 'id' | 'worktree'>): RootChoice[] {
  if (!project?.path) return [];
  const roots: RootChoice[] = [];
  if (job?.worktree?.path) roots.push({ root: trimSlash(job.worktree.path), folder: { projectId: project.id, jobId: job.id } });
  roots.push({ root: trimSlash(project.path), folder: { projectId: project.id } });
  return roots;
}

/** rootsFor a person, looked up the way the store does (AgentInfo.projectId / jobId). */
export function personRoots(
  agent: Pick<AgentInfo, 'projectId' | 'jobId'> | undefined,
  project: (id: string) => Project | undefined,
  job: (projectId: string, jobId: string) => Job | undefined,
): RootChoice[] {
  if (!agent) return [];
  return rootsFor(project(agent.projectId), agent.jobId ? job(agent.projectId, agent.jobId) : undefined);
}

/** The path inside a link target or code span, or null when it isn't a local path at all (a web link, an anchor,
 *  mailto:, data:…). Drops file://, ?query, #fragment, a :line[:col] suffix and URL escapes. */
export function cleanPath(raw: string): string | null {
  let s = raw.trim();
  if (/^<.*>$/.test(s) || /^(['"`]).*\1$/.test(s)) s = s.slice(1, -1).trim();
  if (!s) return null;
  s = s.replace(/:\d+(?::\d+)?(?:-\d+)?$/, ''); // src/app.ts:42:7, notes.md:10-20
  if (/^file:\/\//i.test(s)) s = s.replace(/^file:\/\/(localhost)?/i, '');
  else if (/^[a-z][a-z0-9+.-]*:/i.test(s)) return null; // a scheme (http:, mailto:, javascript:, C:)
  if (s.startsWith('#') || s.startsWith('//') || s.startsWith('?')) return null;
  s = s.replace(/[?#].*$/, '');
  if (/%[0-9a-f]{2}/i.test(s)) {
    try {
      s = decodeURIComponent(s);
    } catch {
      /* keep it as written */
    }
  }
  if (!s || s.includes('\0')) return null;
  return s;
}

/** Collapse '.', '..' and doubled slashes of an absolute path; null when '..' climbs above '/'. */
export function normalizeAbs(path: string): string | null {
  const out: string[] = [];
  for (const seg of path.split('/')) {
    if (!seg || seg === '.') continue;
    if (seg === '..') {
      if (!out.length) return null;
      out.pop();
    } else out.push(seg);
  }
  return `/${out.join('/')}`;
}

/** Where a path a person wrote points. baseDir: the folder a relative path is relative to, inside the first root
 *  (a Markdown file's own folder in the viewer); '' = the person's folder. null → not a local path (see cleanPath). */
export function resolvePath(raw: string, roots: RootChoice[], baseDir = ''): Resolved | null {
  const p = cleanPath(raw);
  if (p === null) return null;
  if (!roots.length) return { ok: false, why: NO_FOLDER_WHY };
  if (p === '~' || p.startsWith('~/') || p.startsWith('~')) return { ok: false, why: OUTSIDE_WHY };
  const dir = /\/$/.test(p);
  const abs = normalizeAbs(p.startsWith('/') ? p : `${roots[0].root}/${baseDir ? `${baseDir}/` : ''}${p}`);
  if (abs === null) return { ok: false, why: OUTSIDE_WHY };
  let hit: RootChoice | undefined;
  for (const r of roots) {
    if ((abs === r.root || abs.startsWith(r.root === '/' ? '/' : `${r.root}/`)) && (!hit || r.root.length > hit.root.length)) hit = r;
  }
  if (!hit) return { ok: false, why: OUTSIDE_WHY };
  const rel = abs === hit.root ? '' : abs.slice(hit.root === '/' ? 1 : hit.root.length + 1);
  if (rel.split('/').some((seg) => seg.startsWith('.'))) return { ok: false, why: HIDDEN_WHY };
  return { ok: true, folder: hit.folder, path: rel, ...(dir || rel === '' ? { dir: true } : {}) };
}

const NOT_IN_PATHS = /[\s()[\]{}<>|;'"=*?$!,&`^\\#]/;

/** An inline code span that is most likely a file path: no spaces or shell/code punctuation, and a known extension or
 *  file name (src/app.ts, covers/a.png, ./index.html:12, /tmp/x.png), or a folder with a trailing slash (covers/). */
export function looksLikeFilePath(text: string): boolean {
  let s = text.trim();
  if (s.length < 3 || s.length > 300) return false;
  if (/^file:\/\//i.test(s)) s = s.replace(/^file:\/\/(localhost)?/i, '');
  else if (/^[a-z][a-z0-9+.-]*:/i.test(s)) return false;
  if (NOT_IN_PATHS.test(s) || s.startsWith('-') || s.startsWith('//')) return false;
  s = s.replace(/:\d+(?::\d+)?(?:-\d+)?$/, '');
  if (s.includes(':')) return false;
  if (s.endsWith('/')) {
    const segs = s.split('/').filter(Boolean);
    return segs.length > 0 && s.length > 2 && segs.every((x) => /^[\w@+.~-]+$/.test(x) && x !== '..' && x !== '.') && !/^\.+\/$/.test(s);
  }
  return isKnownFileName(s);
}

export interface PathMatch {
  path: string;
  indices: number[]; // matched characters of path
  score: number;
}

/** Paths matching a typed query, best first: a match in the file name beats one spread over its folders. */
export function matchPaths(query: string, paths: string[], limit = 100): PathMatch[] {
  const q = query.trim();
  if (!q) return paths.slice(0, limit).map((path) => ({ path, indices: [], score: 0 }));
  const out: PathMatch[] = [];
  for (const path of paths) {
    const cut = path.lastIndexOf('/') + 1;
    const inName = q.includes('/') ? null : fuzzy(q, path.slice(cut));
    const inPath = fuzzy(q, path);
    if (!inName && !inPath) continue;
    const depth = path.split('/').length - 1; // a shallower file first, all else equal
    if (inName && (!inPath || inName.score + 150 >= inPath.score)) out.push({ path, indices: inName.indices.map((i) => i + cut), score: inName.score + 150 - depth * 3 });
    else out.push({ path, indices: inPath!.indices, score: inPath!.score - depth * 3 });
  }
  out.sort((a, b) => b.score - a.score || a.path.length - b.path.length);
  return out.slice(0, limit);
}
