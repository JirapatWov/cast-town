// POST FOLDER_UPLOAD_PATH?projectId=&jobId=&dir=&name=[&replace=1]: one file (the raw body) into a folder the Files
// viewer shows. Signed in and same-origin (index.ts runs auth.check with the Origin check first) — never under
// FILES_PATH, whose key a page running in the viewer can read from its own URL. The folder rules are the viewer's own
// (files.ts upload). Afterwards the house's Changes tab is refreshed and, once uploads stop for a moment, one activity
// entry says how many files went where ("3 files uploaded to notes/docs").
import { FOLDER_UPLOAD_PATH, type GitSummary, type ServerMsg } from '../shared/protocol';
import type { CityStore, JobStore } from './contracts';
import { UploadRefused, type FileViewer } from './files';
import { log } from './util';

/** Uploads to one folder this close together are one activity entry. */
const NOTE_QUIET_MS = 2500;

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' } });

export interface FolderUploadRoute {
  matches(url: URL): boolean;
  handle(req: Request, url: URL): Promise<Response>;
}

export interface FolderUploadDeps {
  files: Pick<FileViewer, 'upload'>;
  city: Pick<CityStore, 'project'>;
  jobs: Pick<JobStore, 'get'>;
  /** Broadcast to every page (a toast becomes an activity entry: activity-log.ts recordToasts). */
  broadcast(msg: ServerMsg): void;
  /** The folder's git summary, for the Changes tab (JobService.gitSummary). */
  gitSummary(projectId: string, jobId?: string): Promise<GitSummary>;
  quietMs?: number;
}

export function createFolderUpload(d: FolderUploadDeps): FolderUploadRoute {
  const quiet = d.quietMs ?? NOTE_QUIET_MS;
  /** Per folder: files uploaded since its last note, and the timer that writes it. */
  const pending = new Map<string, { projectId: string; jobId?: string; dir: string; count: number; timer: ReturnType<typeof setTimeout> }>();

  function settle(key: string) {
    const p = pending.get(key);
    if (!p) return;
    pending.delete(key);
    const project = d.city.project(p.projectId);
    if (!project) return;
    const job = p.jobId ? d.jobs.get(p.projectId, p.jobId) : undefined;
    const where = `${project.name}${job?.worktree ? ` (${job.name}’s copy)` : ''}${p.dir ? `/${p.dir}` : ''}`;
    d.broadcast({ t: 'toast', level: 'success', text: `${p.count} file${p.count === 1 ? '' : 's'} uploaded to ${where}`, projectId: p.projectId });
  }

  function noted(projectId: string, jobId: string | undefined, dir: string) {
    const key = JSON.stringify([projectId, jobId ?? '', dir]);
    const p = pending.get(key);
    if (p) {
      clearTimeout(p.timer);
      p.count++;
      p.timer = setTimeout(() => settle(key), quiet);
    } else pending.set(key, { projectId, jobId, dir, count: 1, timer: setTimeout(() => settle(key), quiet) });
    // The Changes tab (and the TV) of a git house shows the new file now, not with the next agent turn.
    d.gitSummary(projectId, jobId)
      .then((summary) => d.broadcast({ t: 'git', summary }))
      .catch((err) => log('files', `git summary after an upload failed: ${(err as Error).message}`));
  }

  return {
    matches: (url) => url.pathname === FOLDER_UPLOAD_PATH,
    async handle(req, url) {
      if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405);
      const q = url.searchParams;
      const projectId = q.get('projectId') ?? '';
      const jobId = q.get('jobId') || undefined;
      const name = q.get('name') ?? '';
      if (!projectId) return json({ error: 'Which house?' }, 400);
      try {
        const up = await d.files.upload(req, projectId, jobId, q.get('dir') ?? '', name, q.get('replace') === '1');
        noted(projectId, jobId, up.dir);
        return json({ ...up.entry, dir: up.dir, replaced: up.replaced });
      } catch (err) {
        if (err instanceof UploadRefused) return json({ error: err.message, ...(err.code ? { code: err.code } : {}) }, err.status);
        log('files', 'folder upload failed:', err);
        return json({ error: 'CAST couldn’t save the file — try again.' }, 500);
      }
    },
  };
}
