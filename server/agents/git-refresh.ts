// Debounced "something may have changed files" → git summary → broadcast `git` (the living-room TV, the Changes tab).
// One summary per folder: the house (key `<projectId>`) and each job's own copy (key `<projectId>:<jobId>`).
import type { CityStore, GitService, Hub, JobStore } from '../contracts';
import { errorText, KeyedDebouncer, log } from './util';

export class GitRefresher {
  #debounce = new KeyedDebouncer(800);
  #running = new Set<string>();
  #again = new Set<string>();

  constructor(
    private readonly hub: Hub,
    private readonly city: CityStore,
    private readonly git: GitService,
    /** Without it only house folders are refreshed. */
    private readonly jobs?: Pick<JobStore, 'get' | 'list'>,
  ) {}

  /** Schedule a refresh of the folder this job works in (coalesces bursts of edits); no job → the house folder and
   *  every job copy of it (whoever changed files is not known). */
  poke(projectId: string, jobId?: string): void {
    for (const key of this.#keys(projectId, jobId)) this.#debounce.schedule(key, () => void this.#refresh(key));
  }

  async refreshNow(projectId: string, jobId?: string): Promise<void> {
    await Promise.all(this.#keys(projectId, jobId).map((key) => this.#refresh(key)));
  }

  #keys(projectId: string, jobId?: string): string[] {
    const copies = this.jobs?.list(projectId).filter((j) => j.worktree).map((j) => j.id) ?? [];
    if (jobId === undefined) return [projectId, ...copies.map((id) => `${projectId}:${id}`)];
    return copies.includes(jobId) ? [`${projectId}:${jobId}`] : [projectId];
  }

  async #refresh(key: string): Promise<void> {
    if (this.#running.has(key)) {
      this.#again.add(key);
      return;
    }
    const [projectId = '', jobId] = key.split(':');
    const project = this.city.project(projectId);
    if (!project) return;
    const job = jobId ? this.jobs?.get(projectId, jobId) : undefined;
    if (jobId && !job?.worktree) return; // the job (or its copy) is gone
    this.#running.add(key);
    try {
      const summary = await this.git.summary(project, job);
      this.hub.broadcast({ t: 'git', summary });
    } catch (err) {
      log('git', `summary failed for ${key}: ${errorText(err)}`);
    } finally {
      this.#running.delete(key);
      if (this.#again.delete(key)) this.#debounce.schedule(key, () => void this.#refresh(key));
    }
  }

  dispose(): void {
    this.#debounce.cancelAll();
  }
}
