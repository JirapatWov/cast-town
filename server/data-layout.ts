// Where per-person state lives under <dataDir>. The 'main' job keeps the pre-jobs layout so existing omp
// sessions stay where they were:
//   main job:   sessions/<project>/<role>/            transcripts/<project>/<role>/
//   other jobs: sessions/<project>/jobs/<job>/<role>/  transcripts/<project>/jobs/<job>/<role>/
import { existsSync } from 'node:fs';
import { join } from 'node:path';

export const MAIN_JOB_ID = 'main';

function segments(projectId: string, jobId: string): string[] {
  return jobId === MAIN_JOB_ID ? [projectId] : [projectId, 'jobs', jobId];
}

/** omp --session-dir of one person. */
export function sessionDirFor(dataDir: string, projectId: string, jobId: string, roleId: string): string {
  return join(dataDir, 'sessions', ...segments(projectId, jobId), roleId);
}

/** RLT's own chat history (thread index + one transcript per thread) of one person. */
export function transcriptDirFor(dataDir: string, projectId: string, jobId: string, roleId: string): string {
  return join(dataDir, 'transcripts', ...segments(projectId, jobId), roleId);
}

/** True when a (possibly deleted) job left sessions, transcripts or its own copy of the files (worktrees/, see
 *  worktrees.ts) on disk — its id must not be reused. */
export function jobLeftData(dataDir: string, projectId: string, jobId: string): boolean {
  if (jobId === MAIN_JOB_ID) return false;
  return (
    existsSync(join(dataDir, 'sessions', projectId, 'jobs', jobId)) ||
    existsSync(join(dataDir, 'transcripts', projectId, 'jobs', jobId)) ||
    existsSync(join(dataDir, 'worktrees', projectId, jobId))
  );
}

/** True when a (possibly removed) project left sessions, transcripts or jobs' copies on disk — a new project must not
 *  get its id (its people would pick up the old chats, and omp would resume them in the old folder). */
export function projectLeftData(dataDir: string, projectId: string): boolean {
  return ['sessions', 'transcripts', 'worktrees'].some((d) => existsSync(join(dataDir, d, projectId)));
}

/** Agent id of a resident/team member. 'main' keeps the legacy `${projectId}:${roleId}`. Clients never parse these. */
export function agentIdFor(projectId: string, jobId: string, roleId: string): string {
  return jobId === MAIN_JOB_ID ? `${projectId}:${roleId}` : `${projectId}:${jobId}:${roleId}`;
}
