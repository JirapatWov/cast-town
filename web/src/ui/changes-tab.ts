// Changes tab: what changed in the project folder (git status + numstat), with a jump to the TV diff. It follows the
// current job: a job with its own copy of the files (Job.worktree) shows what it changed there since its base, with
// Bring into house… (preview → confirm) and Undo last bring. The house folder has Undo changes per file and Undo all
// (undo-changes.ts: back to the last commit, Bring back), and lists what deleted jobs left on their branches
// (leftovers.ts).
import type { BringPlan, GitFileChange, Job, ServerMsg } from '../../../shared/protocol';
import type { FolderRef } from '../net/files';
import { gitKey } from '../net/reducer';
import './css/viewer.css';
import { h, memo, setChildren } from './dom';
import { openFile, openFolder } from './file-viewer';
import { SET_UP_GIT_TEXT, splitPath, timeAgo } from './format';
import { icon } from './icons';
import { MAIN_JOB } from './jobs';
import { createLeftovers } from './leftovers';
import { isRunActive, runsOf } from './runs';
import type { Shell } from './shell';
import { createUndoChanges, undoBlocked } from './undo-changes';
import { emptyState } from './widgets';

const STATUS: Record<string, { label: string; cls: string }> = {
  M: { label: 'M', cls: 'st-mod' },
  A: { label: 'A', cls: 'st-add' },
  '??': { label: 'N', cls: 'st-add' },
  D: { label: 'D', cls: 'st-del' },
  R: { label: 'R', cls: 'st-ren' },
};

export function statusBadge(code: string): HTMLElement {
  const key = code.trim().startsWith('R') ? 'R' : code.trim() || 'M';
  const s = STATUS[key] ?? STATUS[key[0]] ?? STATUS.M;
  const title = { M: 'Modified', A: 'Added', '??': 'New file', D: 'Deleted', R: 'Renamed' }[key] ?? code;
  return h('span', { class: ['st-badge', s.cls], title }, s.label);
}

/** Five little blocks, like GitHub's diffstat. */
export function diffBlocks(f: GitFileChange): HTMLElement {
  const total = f.additions + f.deletions;
  const filled = total === 0 ? 0 : Math.max(1, Math.min(5, Math.round(Math.log2(total + 1))));
  const add = total ? Math.round((f.additions / total) * filled) : 0;
  return h(
    'span',
    { class: 'blocks', 'aria-hidden': 'true' },
    Array.from({ length: 5 }, (_, i) => h('span', { class: i < add ? 'b-add' : i < filled ? 'b-del' : '' })),
  );
}

/** Whose changes the Changes tab, the TV overlay and the badges show for a house: the job the panels act on when it
 *  has its own copy of the files (key "projectId:jobId" in state.git), else the house folder. */
export function gitTarget(shell: Shell, projectId: string): { key: string; job?: Job } {
  const job = shell.jobs.active(projectId);
  return job?.worktree ? { key: gitKey(projectId, job.id), job } : { key: gitKey(projectId) };
}

/** The folder gitTarget shows, for the file viewer (its paths are relative to the same folder). */
export function viewerFolder(shell: Shell, projectId: string): FolderRef {
  const job = gitTarget(shell, projectId).job;
  return job ? { projectId, jobId: job.id } : { projectId };
}

/** Ask for a fresh summary of what gitTarget points at (the reply arrives as a 'git' message). */
export function requestGit(shell: Shell, projectId: string) {
  const job = gitTarget(shell, projectId).job;
  shell.store.send(job ? { t: 'get_git', projectId, jobId: job.id } : { t: 'get_git', projectId });
}

/** Who Bring into house / Undo waits for — the server refuses the same cases: someone busy or a team running in
 *  the job itself or in any job working in the house folder — or null when it can run. */
function bringBlocked(shell: Shell, job: Job): string | null {
  const { store } = shell;
  const watched = store.jobsOf(job.projectId).filter((j) => j.id === job.id || !j.worktree);
  for (const j of watched) {
    if (runsOf(store.state, job.projectId).some((r) => isRunActive(r) && (r.jobId ?? MAIN_JOB) === j.id)) return `the team in “${j.name}”`;
    const busy = store.agentsOfJob(job.projectId, j.id).find((a) => a.status === 'busy');
    if (busy) return `${busy.name} in “${j.name}”`;
  }
  return null;
}

const files = (n: number) => `${n} ${n === 1 ? 'file' : 'files'}`;

function fileList(paths: string[]): HTMLElement {
  return h('ul', { class: 'revert-files' }, paths.slice(0, 10).map((f) => h('li', null, h('code', null, f))), paths.length > 10 ? h('li', { class: 'muted' }, `and ${paths.length - 10} more`) : null);
}

export function createChangesTab(shell: Shell) {
  const { store } = shell;
  let projectId: string | null = null;
  let shownKey = ''; // gitTarget key on screen
  let requested = 0;
  let working = false; // a bring / undo is on its way
  let slow: string | null = null; // …and taking a while (a big repo): what it is still doing
  let settingUp: string | null = null; // the house whose git is being set up right now

  const el = h('div', { class: 'tab-changes' });
  const foot = h('div', { class: 'changes-foot' });
  const leftovers = createLeftovers(shell);
  const undos = createUndoChanges(shell, { changed: () => refresh() });
  const footChanged = memo();

  function refresh() {
    if (!projectId) return;
    requested = Date.now();
    requestGit(shell, projectId);
  }
  /** After a bring / undo both sides moved: the house's files and the copy's base. */
  function refreshBoth(job: Job) {
    store.send({ t: 'get_git', projectId: job.projectId });
    store.send({ t: 'get_git', projectId: job.projectId, jobId: job.id });
    requested = Date.now();
  }

  /** RequestOptions.onSlow for a bring / undo: the foot says what is still going on instead of a bare spinner. */
  const stillWorking = (what: string) => ({
    onSlow: () => {
      slow = what;
      renderFoot(true);
    },
  });

  async function bring(job: Job) {
    if (working) return;
    working = true;
    renderFoot(true);
    try {
      let plan: BringPlan;
      try {
        plan = (await store.request<{ plan: BringPlan }>(
          { t: 'bring_job_changes', reqId: '', projectId: job.projectId, jobId: job.id, preview: true },
          stillWorking(`Still comparing “${job.name}”’s copy with the house — big projects take a while…`),
        )).plan;
      } catch (err) {
        shell.toast('error', `Could not bring the changes in: ${(err as Error).message}`);
        return;
      }
      slow = null;
      renderFoot(true);
      const n = plan.files.length + plan.conflicts.length;
      if (!n) {
        shell.toast('info', plan.skipped.length
          ? `Nothing can be brought in: ${plan.skipped.length === 1 ? 'the only file' : `all ${plan.skipped.length} files`} “${job.name}” changed ${plan.skipped.length === 1 ? 'is a binary file' : 'are binary files'} the house changed too.`
          : `Nothing to bring: “${job.name}” hasn’t changed any files since it was last in step with the house.`);
        return;
      }
      const ok = await shell.confirm({
        title: `Bring “${job.name}” into the house?`,
        body: h(
          'div',
          null,
          plan.files.length
            ? [h('p', null, `${plan.files.length === 1 ? 'This file merges' : `These ${plan.files.length} files merge`} cleanly into the house’s files (files the job created or deleted included):`), fileList(plan.files)]
            : null,
          plan.conflicts.length
            ? [
                h('p', { class: 'revert-warn' }, icon('alert', 14), ` Changed on both sides — ${plan.conflicts.length === 1 ? 'it gets' : 'they get'} <<<<<<< house / >>>>>>> job markers to sort out by hand:`),
                fileList(plan.conflicts),
              ]
            : null,
          plan.skipped.length
            ? [h('p', null, `Left as the house has ${plan.skipped.length === 1 ? 'it' : 'them'} — binary, changed on both sides:`), fileList(plan.skipped)]
            : null,
          h('p', { class: 'muted' }, 'Only the house’s files change: your commits, branches and staged changes are not touched. Undo last bring puts them back.'),
        ),
        confirmLabel: n === 1 ? 'Bring 1 file in' : `Bring ${n} files in`,
        icon: 'home',
      });
      if (!ok) return;
      try {
        const data = await store.request<{ plan?: BringPlan } | undefined>(
          { t: 'bring_job_changes', reqId: '', projectId: job.projectId, jobId: job.id },
          stillWorking(`Still bringing “${job.name}”’s changes into the house…`),
        );
        const done = data?.plan ?? plan;
        const brought = done.files.length + done.conflicts.length;
        if (done.conflicts.length)
          shell.toast('warn', `Brought ${files(brought)} from “${job.name}” into the house — ${done.conflicts.length} with conflict markers to sort out.`, { projectId: job.projectId });
        else shell.toast('success', `Brought ${files(brought)} from “${job.name}” into the house.`, { projectId: job.projectId });
      } catch (err) {
        shell.toast('error', `Could not bring the changes in: ${(err as Error).message}`);
      }
      refreshBoth(job);
    } finally {
      working = false;
      slow = null;
      renderFoot(true);
    }
  }

  async function undoBring(job: Job) {
    const last = job.worktree?.lastBring;
    if (!last || working) return;
    const ok = await shell.confirm({
      title: 'Undo the last bring?',
      body: h(
        'div',
        null,
        h('p', null, `${last.files.length === 1 ? 'This file goes' : `These ${last.files.length} files go`} back to how ${last.files.length === 1 ? 'it was' : 'they were'} in the house before “${job.name}”’s changes came in (${timeAgo(last.at)}):`),
        fileList(last.files),
        h('p', { class: 'muted' }, `Files changed again since then are kept as they are. “${job.name}”’s own copy is not touched.`),
      ),
      confirmLabel: 'Undo bring',
      tone: 'danger',
    });
    if (!ok) return;
    working = true;
    renderFoot(true);
    try {
      const data = await store.request<{ files?: string[]; kept?: string[] } | undefined>(
        { t: 'bring_job_changes', reqId: '', projectId: job.projectId, jobId: job.id, undo: true },
        stillWorking('Still putting the house’s files back…'),
      );
      const back = data?.files?.length ?? 0;
      const kept = data?.kept?.length ?? 0;
      shell.toast(
        'success',
        `Undid the bring: ${back ? `${files(back)} back as ${back === 1 ? 'it was' : 'they were'}` : 'nothing to put back'}${kept ? `, ${kept} changed since and kept` : ''}.`,
        { projectId: job.projectId },
      );
    } catch (err) {
      shell.toast('error', `Could not undo the bring: ${(err as Error).message}`);
    } finally {
      working = false;
      slow = null;
      refreshBoth(job);
      renderFoot(true);
    }
  }

  /** The bottom bar. A job copy: Bring into house… / Watch on TV, why it has to wait, and Undo last bring. */
  function renderFoot(force = false) {
    const project = store.project(projectId);
    const { job } = projectId ? gitTarget(shell, projectId) : { job: undefined };
    const n = projectId ? (store.state.git[shownKey]?.files.length ?? 0) : 0;
    const blocked = job ? bringBlocked(shell, job) : projectId ? undoBlocked(shell, projectId) : null;
    const last = job?.worktree?.lastBring;
    if (!footChanged([project?.id, job?.id, n, blocked, last?.at, last?.files.length, working, slow]) && !force) return;
    if (!project) return setChildren(foot);
    const tv = (cls: string) => h('button', { type: 'button', class: ['btn', cls], onclick: () => shell.openDiff(project.id) }, icon('tv', 16), 'Watch on TV');
    if (!job) {
      // The house folder: Undo all puts every file listed back (the server refuses while someone works there).
      const list = store.state.git[shownKey]?.files.filter((f) => !f.path.endsWith('/')) ?? [];
      return setChildren(foot,
        list.length
          ? h(
              'div',
              { class: 'changes-actions' },
              tv('btn-primary'),
              h(
                'button',
                { type: 'button', class: 'btn btn-soft', disabled: !!blocked, title: blocked ? `Waits until ${blocked} is done` : 'Put every file back as the last commit has it — new files are deleted. Bring back undoes it.', onclick: () => void undos.undo(project.id, list) },
                icon('revert', 16),
                'Undo all…',
              ),
            )
          : tv('btn-primary btn-block'),
        blocked && list.length ? h('p', { class: 'changes-note is-wait' }, icon('clock', 13), h('span', null, `Undo waits until ${blocked} is done.`)) : null,
      );
    }
    const undo = last
      ? h(
          'p',
          { class: 'changes-note' },
          `Last brought in ${timeAgo(last.at)} (${files(last.files.length)}). `,
          h('button', { type: 'button', class: 'link-btn', disabled: working || !!blocked, onclick: () => void undoBring(job) }, 'Undo last bring'),
        )
      : null;
    setChildren(foot,
      n
        ? h(
            'div',
            { class: 'changes-actions' },
            h(
              'button',
              { type: 'button', class: 'btn btn-primary', disabled: working || !!blocked, title: blocked ? `Waits until ${blocked} is done` : 'Merge what this job changed into the house’s files', onclick: () => void bring(job) },
              working ? h('span', { class: 'spinner spinner-sm' }) : icon('home', 16),
              'Bring into house…',
            ),
            tv('btn-soft'),
          )
        : null,
      working && slow ? h('p', { class: 'changes-note is-wait', role: 'status' }, h('span', { class: 'spinner spinner-sm' }), h('span', null, slow)) : null,
      blocked && (n || last) ? h('p', { class: 'changes-note is-wait' }, icon('clock', 13), h('span', null, `${n ? 'Bring into house' : 'Undo'} waits until ${blocked} is done.`)) : null,
      undo,
    );
  }

  /** git init + a first commit of what is there (server: init_git). Nothing in the folder changes but a new .git. */
  function setUpGitButton(pid: string): HTMLElement {
    const busy = settingUp === pid;
    return h(
      'button',
      {
        type: 'button',
        class: 'btn btn-primary btn-sm',
        disabled: busy,
        title: SET_UP_GIT_TEXT,
        onclick: async () => {
          settingUp = pid;
          render();
          try {
            const res = await store.request<{ project?: { name: string; approvalMode: string } }>({ t: 'init_git', reqId: '', projectId: pid });
            const name = res?.project?.name ?? store.project(pid)?.name ?? 'this house';
            const asking = (res?.project?.approvalMode ?? store.project(pid)?.approvalMode) === 'always-ask';
            shell.toast('success', `Git is set up in ${name} — changes show here from now on.${asking ? ' People still ask before every edit; change that with the mode chip under the chat box.' : ''}`, { projectId: pid });
          } catch (err) {
            shell.toast('error', (err as Error).message || 'Couldn’t set up git.', { projectId: pid });
          } finally {
            settingUp = null;
            if (projectId === pid) refresh();
            render();
          }
        },
      },
      busy ? h('span', { class: 'spinner spinner-sm' }) : icon('branch', 14),
      busy ? 'Setting up git…' : 'Set up git',
    );
  }

  function render() {
    const project = store.project(projectId);
    if (!project) {
      setChildren(el, emptyState('folder', 'No house selected', 'Enter a house to see what changed in its folder.'));
      return;
    }
    const { key, job } = gitTarget(shell, project.id);
    shownKey = key;
    const summary = store.state.git[key];
    if (!summary) {
      setChildren(el, h('div', { class: 'loading-row' }, h('span', { class: 'spinner' }), job ? `Reading “${job.name}”’s copy…` : 'Reading git status…'));
      return;
    }
    const browse = (cls = 'icon-btn') =>
      h(
        'button',
        { type: 'button', class: cls, 'aria-label': 'Browse files', title: 'Browse the files in the viewer', onclick: () => openFolder(shell, viewerFolder(shell, project.id)) },
        icon('folder', 15),
        cls === 'icon-btn' ? null : 'Browse files',
      );
    if (!summary.isGit) {
      setChildren(el, job
        ? emptyState('alert', 'Can’t read its copy', `“${job.name}” works in its own copy of the files, but CAST can’t read it right now.`, browse('btn btn-soft btn-sm'))
        : emptyState(
            'alert',
            'Changes aren’t tracked here',
            `${project.name} is not a git repository, so CAST can’t show what people change in it, and nothing they do can be undone. Set up git to save a starting point: every change after it shows here and on the TV, and can be undone here.`,
            h('div', { class: 'empty-actions' }, setUpGitButton(project.id), browse('btn btn-soft btn-sm')),
          ));
      return;
    }
    const adds = summary.files.reduce((t, f) => t + f.additions, 0);
    const dels = summary.files.reduce((t, f) => t + f.deletions, 0);
    const head = h(
      'div',
      { class: 'changes-head' },
      h(
        'div',
        { class: 'changes-summary' },
        job
          ? h('span', { class: 'branch-chip is-copy', title: `${job.worktree!.branch}\n${job.worktree!.path}` }, icon('copy', 13), h('span', { class: 'branch-chip-text' }, `own copy · ${job.worktree!.branch}`))
          : h('span', { class: 'branch-chip', title: `Git branch: the line of saved history these changes are on${summary.branch ? ` (“${summary.branch}”)` : ''}` }, icon('branch', 13), summary.branch ?? 'detached'),
        summary.files.length
          ? h(
              'span',
              { class: 'num', title: `${adds} line${adds === 1 ? '' : 's'} added and ${dels} removed since the last saved version (commit)` },
              h('span', { class: 'add' }, `+${adds}`), ' ', h('span', { class: 'del' }, `−${dels}`), h('span', { class: 'muted' }, ` in ${files(summary.files.length)}`),
            )
          : null,
      ),
      h(
        'div',
        { class: 'changes-head-actions' },
        browse(),
        h('button', { type: 'button', class: 'icon-btn', 'aria-label': 'Refresh', title: `Updated ${timeAgo(summary.ts)}`, onclick: refresh }, icon('refresh', 15)),
      ),
    );
    const intro = job
      ? h('p', { class: 'changes-intro' }, `“${job.name}” works in its own copy of the files. The house and the other jobs don’t see these changes until you bring them in.`)
      : null;
    renderFoot(true);
    if (!job) {
      leftovers.show(project.id); // the house folder: what deleted jobs left on their branches
      undos.show(project.id); // …and what Undo changes kept
    }
    if (!summary.files.length) {
      setChildren(el,
        head,
        intro,
        job
          ? emptyState('checkCircle', 'Nothing new in its copy', job.worktree!.lastBring ? `Everything “${job.name}” changed has been brought into the house.` : `When people in “${job.name}” edit files, the changes show up here, ready to bring into the house.`)
          : emptyState('checkCircle', 'No changes yet', 'When people edit files in this house, every change shows up here and on the living-room TV, ready to undo.', h('div', { class: 'empty-actions' }, browse('btn btn-soft btn-sm'))),
        job ? null : undos.el,
        job ? null : leftovers.el,
        job?.worktree?.lastBring ? foot : null,
      );
      return;
    }
    setChildren(el,
      head,
      intro,
      h(
        'ul',
        { class: 'file-list' },
        summary.files.map((f) => {
          const { dir, file } = splitPath(f.path);
          const gone = f.status.trim() === 'D';
          const isNew = f.status.trim() === '??' || f.status.trim() === 'A';
          return h(
            'li',
            { class: 'file-item' },
            h(
              'button',
              { type: 'button', class: 'file-row', onclick: () => shell.openDiff(project.id, f.path), title: `${f.path} — see the change on TV` },
              statusBadge(f.status),
              h('span', { class: 'file-path' }, dir ? h('span', { class: 'file-dir' }, dir) : null, h('span', { class: 'file-name' }, file)),
              h('span', { class: 'file-stat num' }, f.additions ? h('span', { class: 'add' }, `+${f.additions}`) : null, f.deletions ? h('span', { class: 'del' }, `−${f.deletions}`) : null),
              diffBlocks(f),
            ),
            h(
              'button',
              {
                type: 'button',
                class: 'icon-btn file-view',
                disabled: gone,
                'aria-label': `View ${f.path}`,
                title: gone ? 'Deleted — nothing to view' : `View ${file} in the viewer`,
                onclick: () => openFile(shell, { folder: viewerFolder(shell, project.id), path: f.path.replace(/\/$/, ''), ...(f.path.endsWith('/') ? { dir: true } : {}) }),
              },
              icon('eye', 15),
            ),
            // the house folder only (a job's copy has Bring into house); never another repository inside this one
            job || f.path.endsWith('/')
              ? null
              : h(
                  'button',
                  {
                    type: 'button',
                    class: 'icon-btn file-undo',
                    'aria-label': `Undo changes to ${f.path}`,
                    title: isNew ? `Undo — delete this new file (Bring back puts it back)` : 'Undo changes — back to the last commit (Bring back puts them back)',
                    onclick: () => void undos.undo(project.id, [f]),
                  },
                  icon('revert', 15),
                ),
          );
        }),
      ),
      job ? null : undos.el,
      job ? null : leftovers.el,
      foot,
    );
  }

  return {
    el,
    show(pid: string) {
      const changed = pid !== projectId || gitTarget(shell, pid).key !== shownKey;
      projectId = pid;
      if (changed || Date.now() - requested > 4000) refresh();
      render();
    },
    onState(msg?: ServerMsg) {
      if (!msg || msg.t === 'git' || msg.t === 'snapshot' || msg.t === 'city' || msg.t === 'jobs') render();
      // people and teams starting or stopping decide whether Bring into house can run
      else if (msg.t === 'agent' || msg.t === 'run' || msg.t === 'agent_removed') {
        renderFoot();
        leftovers.refresh(false);
        undos.refresh(false);
      }
      if (msg?.t === 'jobs') leftovers.refresh(true); // a deleted job may have left a branch
    },
  };
}
