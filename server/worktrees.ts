// A job's own copy of the house's files (Job.worktree): a git worktree under <dataDir>/worktrees/<project>/<job> on
// its own branch, made from a snapshot of the house (uncommitted work included). Everything that works "in the job's
// folder" asks jobDir() for it; the git side (create / summary / bring / undo / remove) lives in git.ts.
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Job, JobWorktree, Project } from '../shared/protocol';
import { errorMessage, log } from './util';

/** The folder a job's people work in: its own copy, or the house folder. */
export function jobDir(project: Pick<Project, 'path'>, job: Pick<Job, 'worktree'> | null | undefined): string {
  return job?.worktree?.path ?? project.path;
}

/** Where a job's copy lives (outside the project, so the house's git status and watchers never see it). */
export function worktreeRootFor(dataDir: string, projectId: string, jobId: string): string {
  return join(dataDir, 'worktrees', projectId, jobId);
}

/** undo.json key of a run that worked in a job's copy which is gone: its checkpoints are of that copy, so reverting it
 *  in the house would put the copy's files there (workflow-engine refuses). Value: the branch that keeps the work. */
export const COPY_RUN_MARK = 'copyOf';

/** A copy is about to be removed: its workflow runs (<copy>/.rlt/runs/<id>) move to the house's .rlt/runs, so the
 *  job's run history stays, marked with COPY_RUN_MARK. Returns how many moved. */
export function moveRunsHome(project: Pick<Project, 'id' | 'path'>, wt: JobWorktree): number {
  const from = join(wt.path, '.rlt', 'runs');
  let ids: string[];
  try {
    ids = readdirSync(from);
  } catch {
    return 0; // no runs
  }
  const to = join(project.path, '.rlt', 'runs');
  let moved = 0;
  for (const id of ids) {
    const src = join(from, id);
    const dst = join(to, id);
    if (existsSync(dst)) continue;
    try {
      const file = join(src, 'undo.json');
      let rec: Record<string, unknown> = {};
      try {
        rec = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
      } catch {
        /* the run ended before its undo record was written */
      }
      writeFileSync(file, `${JSON.stringify({ ...rec, [COPY_RUN_MARK]: wt.branch }, null, 2)}\n`);
      mkdirSync(to, { recursive: true });
      try {
        renameSync(src, dst);
      } catch {
        cpSync(src, dst, { recursive: true }); // another filesystem
        rmSync(src, { recursive: true, force: true });
      }
      moved++;
    } catch (err) {
      log('jobs', `${project.id}: could not keep run ${id} of ${wt.branch}: ${errorMessage(err)}`);
    }
  }
  return moved;
}
