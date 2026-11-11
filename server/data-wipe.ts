// Deleting what CAST keeps about you: one house's history (removing a house with "also delete its chats"), stray chat
// pictures nothing refers to any more, and "Delete all CAST data" (Settings → Your data).
//
// What CAST writes, and where (README "Your data" lists the same):
//   <dataDir>/            town (city.json, jobs.json, workflows.json), chats (transcripts/), omp sessions (sessions/),
//                         chat pictures (uploads/), jobs' own copies of files (worktrees/), pairing token, devices.json,
//                         other cities you added (cities.json), the Web Push key and the devices that turned
//                         notifications on (push.json), and a leftover omp-demo-agent/ (only the scripted test model,
//                         CAST_MOCK_LLM, writes it)
//   <house>/.rlt/         run notes of team workflows (git-excluded)
//   <house repo> refs/rlt/ checkpoints of runs (for Undo) and the base of jobs' own copies
// Never touched here: the files of your projects, your git branches, and omp's own accounts folder (~/.omp/agent —
// sign out of AI accounts in Models & providers).
import { existsSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { exec } from './exec';
import { uploadsDir, UPLOAD_ID } from './uploads';
import { errorMessage, log } from './util';

/** Typed into the confirmation box of "Delete all CAST data"; the server checks it too. */
export const WIPE_CONFIRM_TEXT = 'delete everything';

/** Kept by a full wipe: the owner's settings, and the files the running server itself writes to (deleting an open log
 *  would only hide it). */
const KEEP_NAMES = new Set(['config.json', 'server.pid']);
const KEEP_PATTERN = /\.log$/;

/** A chat picture younger than this is kept even when no chat names it: it may sit in an unsent draft. */
export const UPLOAD_GRACE_MS = 6 * 60 * 60 * 1000;

export interface WipeResult {
  removed: string[];
  kept: string[];
  failed: string[];
}

/** Empty the data folder except KEEP_*; the folder itself stays. */
export function wipeDataDir(dataDir: string): WipeResult {
  const out: WipeResult = { removed: [], kept: [], failed: [] };
  let names: string[] = [];
  try {
    names = readdirSync(dataDir);
  } catch {
    return out;
  }
  for (const name of names) {
    if (KEEP_NAMES.has(name) || KEEP_PATTERN.test(name)) {
      out.kept.push(name);
      continue;
    }
    try {
      rmSync(join(dataDir, name), { recursive: true, force: true });
      out.removed.push(name);
    } catch (err) {
      log('wipe', `could not delete ${join(dataDir, name)}: ${errorMessage(err)}`);
      out.failed.push(name);
    }
  }
  return out;
}

async function git(cwd: string, args: string[]) {
  return exec(['git', ...args], { cwd, timeoutMs: 30_000, env: { GIT_TERMINAL_PROMPT: '0' } });
}

/** CAST's own records inside a house folder: .rlt/ (run notes) and, in a git repo, refs/rlt/<scope>… (run
 *  checkpoints; `all` also drops the bases of jobs' copies). Branches and the project's files are left alone. */
export async function removeHouseArtifacts(house: { path: string; isGit: boolean }, scope: 'runs' | 'all' = 'runs'): Promise<void> {
  if (!existsSync(house.path)) return;
  try {
    rmSync(join(house.path, '.rlt'), { recursive: true, force: true });
  } catch (err) {
    log('wipe', `could not delete ${join(house.path, '.rlt')}: ${errorMessage(err)}`);
  }
  if (!house.isGit) return;
  const prefix = scope === 'all' ? 'refs/rlt/' : 'refs/rlt/checkpoints/';
  const refs = await git(house.path, ['for-each-ref', '--format=%(refname)', prefix]).catch(() => null);
  for (const ref of (refs?.code === 0 ? refs.stdout : '').split('\n').map((r) => r.trim()).filter((r) => r.startsWith(prefix))) {
    await git(house.path, ['update-ref', '-d', ref]).catch(() => null);
  }
  if (scope === 'all') await git(house.path, ['worktree', 'prune']).catch(() => null);
}

/** One house's chats and omp sessions (every job's) in the data folder. Jobs' own copies of files (worktrees/) stay:
 *  they are project files, not history. */
export function removeHouseHistory(dataDir: string, projectId: string): string[] {
  const removed: string[] = [];
  for (const d of ['transcripts', 'sessions']) {
    const dir = join(dataDir, d, projectId);
    if (!existsSync(dir)) continue;
    try {
      rmSync(dir, { recursive: true, force: true });
      removed.push(dir);
    } catch (err) {
      log('wipe', `could not delete ${dir}: ${errorMessage(err)}`);
    }
  }
  return removed;
}

/** Every upload id named in the chats still on disk. */
function referencedUploads(dataDir: string): Set<string> {
  const seen = new Set<string>();
  const re = /[0-9a-f]{64}\.(?:png|jpg|gif|webp)/g;
  const walk = (dir: string, depth: number) => {
    if (depth > 8) return;
    let entries: import('node:fs').Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const p = join(dir, e.name);
      if (e.isDirectory()) walk(p, depth + 1);
      else if (e.isFile() && e.name.endsWith('.json')) {
        try {
          for (const m of readFileSync(p, 'utf8').matchAll(re)) seen.add(m[0]);
        } catch {
          /* unreadable: its pictures simply stay referenced-unknown → kept below only if young */
        }
      }
    }
  };
  walk(join(dataDir, 'transcripts'), 0);
  return seen;
}

/** Delete chat pictures no chat refers to any more (after a chat or a house's history was deleted). Pictures younger
 *  than UPLOAD_GRACE_MS stay: they may be attached to a message not sent yet. Returns how many were deleted. */
export function pruneUploads(dataDir: string, now = Date.now()): number {
  const dir = uploadsDir(dataDir);
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return 0;
  }
  const used = referencedUploads(dataDir);
  let n = 0;
  for (const name of names) {
    if (!UPLOAD_ID.test(name) || used.has(name)) continue;
    const file = join(dir, name);
    try {
      if (now - statSync(file).mtimeMs < UPLOAD_GRACE_MS) continue;
      rmSync(file, { force: true });
      n++;
    } catch {
      /* gone already */
    }
  }
  return n;
}
