// Routes validated client messages: the core handles project/city/git/fs messages itself and forwards
// everything else to the agent system. Every reqId message gets exactly one reply (ack or fs_list).
import type { ClientMsg, ServerMsg } from '../shared/protocol';
import type { AgentSystem, ClientConn } from './contracts';
import type { CoreCityStore } from './city-store';
import type { FileViewer } from './files';
import type { FsBrowser } from './fs-browse';
import type { CoreGitService } from './git';
import type { JobService } from './jobs';
import type { ProjectService } from './projects';
import { errorMessage, log, UserError } from './util';
import { parseClientMsg } from './validate';

export interface DispatchDeps {
  city: CoreCityStore;
  git: CoreGitService;
  fs: FsBrowser;
  projects: ProjectService;
  jobs: JobService;
  agents: AgentSystem;
  /** The built-in viewer's files (files_key / list_files / find_files); absent → those messages are refused. */
  files?: FileViewer;
}

type CoreMsg = Extract<
  ClientMsg,
  {
    t:
      | 'place_project' | 'create_project' | 'move_project' | 'remove_project' | 'set_project' | 'get_git' | 'fs_list' | 'init_git'
      | 'create_job' | 'update_job' | 'delete_job' | 'add_floor' | 'remove_floor' | 'bring_job_changes'
      | 'list_leftovers' | 'leftover_branch' | 'discard_changes' | 'list_undone' | 'bring_back_undone'
      | 'files_key' | 'list_files' | 'find_files';
  }
>;

const CORE_TYPES = new Set<ClientMsg['t']>([
  'place_project', 'create_project', 'move_project', 'remove_project', 'set_project', 'get_git', 'fs_list', 'init_git',
  'create_job', 'update_job', 'delete_job', 'add_floor', 'remove_floor', 'bring_job_changes',
  'list_leftovers', 'leftover_branch', 'discard_changes', 'list_undone', 'bring_back_undone',
  'files_key', 'list_files', 'find_files',
]);

const reqIdOf = (msg: ClientMsg): string | undefined => ('reqId' in msg ? msg.reqId : undefined);

function ack(conn: ClientConn, reqId: string, ok: boolean, extra: { error?: string; data?: unknown } = {}): void {
  conn.send({ t: 'ack', reqId, ok, ...extra });
}

function friendly(err: unknown): string {
  if (!(err instanceof UserError)) log('ws', 'handler error:', err);
  return errorMessage(err);
}

export function createDispatcher(d: DispatchDeps): (raw: string, conn: ClientConn) => Promise<void> {
  const files = (): FileViewer => {
    if (!d.files) throw new UserError('The file viewer is not available on this server');
    return d.files;
  };

  async function handleCore(msg: CoreMsg, conn: ClientConn): Promise<void> {
    switch (msg.t) {
      case 'files_key':
        ack(conn, msg.reqId, true, { data: files().mintKey(msg.projectId, msg.jobId) });
        return;
      case 'list_files':
        ack(conn, msg.reqId, true, { data: files().list(msg.projectId, msg.jobId, msg.dir) });
        return;
      case 'find_files':
        ack(conn, msg.reqId, true, { data: await files().find(msg.projectId, msg.jobId, msg.query) });
        return;
      case 'fs_list':
        conn.send({ t: 'fs_list', reqId: msg.reqId, ...d.fs.list(msg.path) });
        return;
      case 'get_git':
        conn.send({ t: 'git', summary: await d.jobs.gitSummary(msg.projectId, msg.jobId) });
        return;
      case 'place_project': {
        const { gitError, ...project } = await d.projects.place(msg);
        ack(conn, msg.reqId, true, { data: { project, ...(gitError ? { gitError } : {}) } });
        return;
      }
      case 'init_git': {
        const project = await d.projects.initGit(msg.projectId);
        ack(conn, msg.reqId, true, { data: { project } });
        conn.send({ t: 'git', summary: await d.jobs.gitSummary(msg.projectId) });
        return;
      }
      case 'create_project': {
        const project = await d.projects.create(msg);
        ack(conn, msg.reqId, true, { data: { project } });
        return;
      }
      case 'move_project': {
        const project = await d.projects.move(msg.projectId, msg.lotId);
        ack(conn, msg.reqId, true, { data: { project } });
        return;
      }
      case 'remove_project': {
        const project = d.city.project(msg.projectId);
        await d.projects.remove(msg.projectId, { deleteHistory: msg.deleteHistory === true });
        ack(conn, msg.reqId, true);
        // Its jobs' own copies stay on disk (like the folder); git only forgets copies whose folder is gone.
        if (project) void d.git.pruneWorktrees(project.path);
        return;
      }
      case 'set_project': {
        const project = await d.projects.update(msg.projectId, msg.patch);
        ack(conn, msg.reqId, true, { data: { project } });
        return;
      }
      case 'create_job': {
        const { reqId: _r, t: _t, ...input } = msg;
        const job = await d.jobs.create(input);
        ack(conn, msg.reqId, true, { data: { job } });
        return;
      }
      case 'update_job': {
        const job = await d.jobs.update(msg.projectId, msg.jobId, msg.patch);
        ack(conn, msg.reqId, true, { data: { job } });
        return;
      }
      case 'delete_job':
        await d.jobs.remove(msg.projectId, msg.jobId);
        ack(conn, msg.reqId, true);
        return;
      case 'add_floor': {
        const project = await d.jobs.addFloor(msg.projectId);
        ack(conn, msg.reqId, true, { data: { project } });
        return;
      }
      case 'remove_floor': {
        const project = await d.jobs.removeFloor(msg.projectId);
        ack(conn, msg.reqId, true, { data: { project } });
        return;
      }
      case 'bring_job_changes': {
        const data = await d.jobs.bring(msg.projectId, msg.jobId, { preview: msg.preview, undo: msg.undo });
        ack(conn, msg.reqId, true, { data });
        return;
      }
      case 'list_leftovers':
        ack(conn, msg.reqId, true, { data: { branches: await d.jobs.leftovers(msg.projectId) } });
        return;
      case 'leftover_branch': {
        const data = await d.jobs.leftover(msg.projectId, msg.branch, msg.action, { preview: msg.preview });
        ack(conn, msg.reqId, true, { data });
        return;
      }
      case 'discard_changes':
        ack(conn, msg.reqId, true, { data: await d.jobs.discard(msg.projectId, msg.paths, { preview: msg.preview }) });
        return;
      case 'list_undone':
        ack(conn, msg.reqId, true, { data: { undone: await d.jobs.undone(msg.projectId) } });
        return;
      case 'bring_back_undone':
        ack(conn, msg.reqId, true, { data: await d.jobs.bringBack(msg.projectId, msg.id, { preview: msg.preview }) });
        return;
    }
  }

  /** Forward to the agent system; if it did not ack a reqId message itself, ack on its behalf. */
  async function forward(msg: ClientMsg, conn: ClientConn): Promise<void> {
    const reqId = reqIdOf(msg);
    let acked = false;
    const tracked: ClientConn = {
      id: conn.id,
      user: conn.user,
      send(out: ServerMsg) {
        if (reqId && out.t === 'ack' && out.reqId === reqId) acked = true;
        conn.send(out);
      },
    };
    try {
      await d.agents.handle(msg, tracked);
      if (reqId && !acked) ack(conn, reqId, true);
    } catch (err) {
      const message = friendly(err);
      if (reqId && !acked) ack(conn, reqId, false, { error: message });
      else if (!reqId) conn.send({ t: 'toast', level: 'error', text: message });
    }
  }

  return async function dispatch(raw: string, conn: ClientConn): Promise<void> {
    const parsed = parseClientMsg(raw);
    if (!parsed.ok) {
      if (parsed.reqId) ack(conn, parsed.reqId, false, { error: parsed.error });
      else conn.send({ t: 'error', message: parsed.error });
      return;
    }
    const msg = parsed.msg;
    if (!CORE_TYPES.has(msg.t)) return forward(msg, conn);
    try {
      await handleCore(msg as CoreMsg, conn);
    } catch (err) {
      const message = friendly(err);
      const reqId = reqIdOf(msg);
      if (msg.t === 'fs_list') conn.send({ t: 'fs_list', reqId: msg.reqId, path: msg.path, parent: null, entries: [], error: message });
      else if (reqId) ack(conn, reqId, false, { error: message });
      else conn.send({ t: 'error', message });
    }
  };
}
