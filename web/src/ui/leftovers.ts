// Changes → "Left over from deleted jobs" (finding #75). Deleting a job that worked in its own copy keeps that work as
// a commit on its git branch; before, CAST never showed the branch again and only `git merge` got the work back. The
// house's Changes tab now lists those branches with Bring in… (preview → confirm, the same merge into the house's
// files as a job's Bring into house, undoable) and Delete…. Server: list_leftovers / leftover_branch (git.ts).
import type { BringPlan, LeftoverBranch } from '../../../shared/protocol';
import { h, setChildren } from './dom';
import { timeAgo } from './format';
import { icon } from './icons';
import { MAIN_JOB } from './jobs';
import { isRunActive, runsOf } from './runs';
import type { Shell } from './shell';

const files = (n: number) => `${n} ${n === 1 ? 'file' : 'files'}`;

function fileList(paths: string[]): HTMLElement {
  return h('ul', { class: 'revert-files' }, paths.slice(0, 10).map((f) => h('li', null, h('code', null, f))), paths.length > 10 ? h('li', { class: 'muted' }, `and ${paths.length - 10} more`) : null);
}

/** What the leftover's line says about it: what Bring in would look at, and how sure that is. Pure, for tests. */
export function leftoverMeta(b: Pick<LeftoverBranch, 'files' | 'at' | 'exact'>, now = Date.now()): string {
  const what = b.files ? `${files(b.files)} changed` : 'Nothing new — all of it is in the house';
  return `${what} · ${timeAgo(b.at, now)}`;
}

/** Someone working in the house folder (a job without its own copy) — a bring writes the house's files, so the
 *  server refuses then too — or null. */
export function houseBusy(shell: Shell, projectId: string): string | null {
  const { store } = shell;
  for (const j of store.jobsOf(projectId).filter((x) => !x.worktree)) {
    if (runsOf(store.state, projectId).some((r) => isRunActive(r) && (r.jobId ?? MAIN_JOB) === j.id)) return `the team in “${j.name}”`;
    const busy = store.agentsOfJob(projectId, j.id).find((a) => a.status === 'busy');
    if (busy) return `${busy.name} in “${j.name}”`;
  }
  return null;
}

export function createLeftovers(shell: Shell) {
  const { store } = shell;
  const el = h('section', { class: 'leftovers', hidden: true, 'aria-label': 'Left over from deleted jobs' });
  let projectId: string | null = null;
  let list: LeftoverBranch[] = [];
  let loadedAt = 0;
  let seq = 0;
  let working: string | null = null; // the branch a bring / undo / delete is on its way for
  let slow: string | null = null;

  async function load() {
    const pid = projectId;
    if (!pid) return;
    const mine = ++seq;
    loadedAt = Date.now();
    try {
      const data = await store.request<{ branches?: LeftoverBranch[] } | undefined>({ t: 'list_leftovers', reqId: '', projectId: pid });
      if (mine !== seq || pid !== projectId) return;
      list = data?.branches ?? [];
    } catch {
      if (mine !== seq) return;
      list = []; // an older server without leftovers, or not a git house any more
    }
    render();
  }

  const stillWorking = (what: string) => ({
    onSlow: () => {
      slow = what;
      render();
    },
  });

  async function act<T>(b: LeftoverBranch, fn: () => Promise<T>): Promise<T | undefined> {
    if (working) return undefined;
    working = b.branch;
    render();
    try {
      return await fn();
    } finally {
      working = null;
      slow = null;
      void load();
    }
  }

  async function bring(pid: string, b: LeftoverBranch) {
    await act(b, async () => {
      let plan: BringPlan;
      try {
        plan = (await store.request<{ plan: BringPlan }>(
          { t: 'leftover_branch', reqId: '', projectId: pid, branch: b.branch, action: 'bring', preview: true },
          stillWorking(`Still comparing “${b.job}” with the house…`),
        )).plan;
      } catch (err) {
        shell.toast('error', `Could not bring “${b.job}” in: ${(err as Error).message}`);
        return;
      }
      slow = null;
      render();
      const n = plan.files.length + plan.conflicts.length;
      if (!n) {
        shell.toast('info', plan.skipped.length
          ? `Nothing can be brought in: the ${files(plan.skipped.length)} “${b.job}” changed ${plan.skipped.length === 1 ? 'is a binary file' : 'are binary files'} the house changed too.`
          : `Nothing to bring: the house already has everything “${b.job}” changed.`);
        return;
      }
      const ok = await shell.confirm({
        title: `Bring “${b.job}” into the house?`,
        body: h(
          'div',
          null,
          h('p', null, 'This job was deleted; its work stayed on the branch ', h('code', null, b.branch), '.'),
          plan.files.length ? [h('p', null, `${plan.files.length === 1 ? 'This file merges' : `These ${plan.files.length} files merge`} cleanly into the house’s files:`), fileList(plan.files)] : null,
          plan.conflicts.length
            ? [h('p', { class: 'revert-warn' }, icon('alert', 14), ` Changed on both sides — ${plan.conflicts.length === 1 ? 'it gets' : 'they get'} <<<<<<< house / >>>>>>> job markers to sort out by hand:`), fileList(plan.conflicts)]
            : null,
          plan.skipped.length ? [h('p', null, `Left as the house has ${plan.skipped.length === 1 ? 'it' : 'them'} — binary, changed on both sides:`), fileList(plan.skipped)] : null,
          b.exact ? null : h('p', { class: 'muted' }, 'CAST lost track of when this job was last in step with the house, so it compares with the house as it was when the job began. Files the house already has as the job left them are skipped.'),
          h('p', { class: 'muted' }, 'Only the house’s files change: your commits, branches and staged changes are not touched. Undo puts them back.'),
        ),
        confirmLabel: n === 1 ? 'Bring 1 file in' : `Bring ${n} files in`,
        icon: 'home',
      });
      if (!ok) return;
      try {
        const data = await store.request<{ plan?: BringPlan } | undefined>(
          { t: 'leftover_branch', reqId: '', projectId: pid, branch: b.branch, action: 'bring' },
          stillWorking(`Still bringing “${b.job}” into the house…`),
        );
        const done = data?.plan ?? plan;
        const brought = done.files.length + done.conflicts.length;
        if (done.conflicts.length) shell.toast('warn', `Brought ${files(brought)} from “${b.job}” into the house — ${done.conflicts.length} with conflict markers to sort out.`, { projectId: pid });
        else shell.toast('success', `Brought ${files(brought)} from “${b.job}” into the house.`, { projectId: pid });
      } catch (err) {
        shell.toast('error', `Could not bring “${b.job}” in: ${(err as Error).message}`);
      }
    });
  }

  async function undo(pid: string, b: LeftoverBranch) {
    const last = b.lastBring;
    if (!last) return;
    const ok = await shell.confirm({
      title: 'Undo that bring?',
      body: h(
        'div',
        null,
        h('p', null, `${last.files.length === 1 ? 'This file goes' : `These ${last.files.length} files go`} back to how ${last.files.length === 1 ? 'it was' : 'they were'} in the house before “${b.job}” came in (${timeAgo(last.at)}):`),
        fileList(last.files),
        h('p', { class: 'muted' }, 'Files changed again since then are kept as they are. The branch is not touched.'),
      ),
      confirmLabel: 'Undo bring',
      tone: 'danger',
    });
    if (!ok) return;
    await act(b, async () => {
      try {
        const data = await store.request<{ files?: string[]; kept?: string[] } | undefined>(
          { t: 'leftover_branch', reqId: '', projectId: pid, branch: b.branch, action: 'undo' },
          stillWorking('Still putting the house’s files back…'),
        );
        const back = data?.files?.length ?? 0;
        const kept = data?.kept?.length ?? 0;
        shell.toast('success', `Undid the bring: ${back ? `${files(back)} back as ${back === 1 ? 'it was' : 'they were'}` : 'nothing to put back'}${kept ? `, ${kept} changed since and kept` : ''}.`, { projectId: pid });
      } catch (err) {
        shell.toast('error', `Could not undo the bring: ${(err as Error).message}`);
      }
    });
  }

  async function remove(pid: string, b: LeftoverBranch) {
    const ok = await shell.confirm({
      title: `Delete what “${b.job}” left?`,
      body: h(
        'div',
        null,
        h('p', null, 'The branch ', h('code', null, b.branch), ' and the work saved on it are deleted from the repository.'),
        b.files
          ? h('p', { class: 'revert-warn' }, icon('alert', 14), ` ${b.files === 1 ? '1 changed file isn’t' : `${b.files} changed files aren’t`} in the house — ${b.files === 1 ? 'it is' : 'they are'} gone for good after this. Bring in first to keep ${b.files === 1 ? 'it' : 'them'}.`)
          : h('p', null, 'Everything on it is already in the house.'),
      ),
      confirmLabel: 'Delete branch',
      tone: 'danger',
      icon: 'trash',
    });
    if (!ok) return;
    await act(b, async () => {
      try {
        await store.request({ t: 'leftover_branch', reqId: '', projectId: pid, branch: b.branch, action: 'delete' });
        list = list.filter((x) => x.branch !== b.branch);
        shell.toast('info', `Deleted the branch ${b.branch}.`, { projectId: pid });
      } catch (err) {
        shell.toast('error', `Could not delete ${b.branch}: ${(err as Error).message}`);
      }
    });
  }

  function row(pid: string, b: LeftoverBranch, blocked: string | null): HTMLElement {
    const mine = working === b.branch;
    const off = !!working || !!blocked;
    const why = blocked ? `Waits until ${blocked} is done` : undefined;
    return h(
      'li',
      { class: 'leftover' },
      h('span', { class: 'leftover-icon', 'aria-hidden': 'true' }, icon('branch', 15)),
      h(
        'div',
        { class: 'leftover-main' },
        h('span', { class: 'leftover-name', title: b.branch }, `“${b.job}”`),
        h(
          'span',
          { class: 'leftover-meta' },
          leftoverMeta(b),
          b.exact ? null : h('span', { class: 'leftover-approx', title: 'CAST lost track of when this job was last in step with the house: it compares with the house as it was when the job began.' }, ' · approximate'),
        ),
        b.lastBring
          ? h(
              'span',
              { class: 'leftover-meta' },
              `Brought in ${timeAgo(b.lastBring.at)} (${files(b.lastBring.files.length)}). `,
              h('button', { type: 'button', class: 'link-btn', disabled: off, title: why, onclick: () => void undo(pid, b) }, 'Undo'),
            )
          : null,
      ),
      h(
        'div',
        { class: 'leftover-actions' },
        b.files
          ? h(
              'button',
              { type: 'button', class: 'btn btn-soft btn-sm', disabled: off, title: why ?? `Merge what “${b.job}” changed into the house’s files`, onclick: () => void bring(pid, b) },
              mine ? h('span', { class: 'spinner spinner-sm' }) : icon('home', 14),
              'Bring in…',
            )
          : null,
        h('button', { type: 'button', class: 'icon-btn', disabled: !!working, 'aria-label': `Delete the branch ${b.branch}`, title: 'Delete this branch', onclick: () => void remove(pid, b) }, icon('trash', 15)),
      ),
    );
  }

  function render() {
    const pid = projectId;
    if (!pid || !list.length) {
      el.hidden = true;
      setChildren(el);
      return;
    }
    el.hidden = false;
    const blocked = houseBusy(shell, pid);
    setChildren(el,
      h(
        'h3',
        { class: 'leftovers-title' },
        'Left over from deleted jobs',
        h('span', { class: 'leftovers-info', tabindex: '0', title: 'A job that worked in its own copy keeps its work on a git branch when it is deleted. Bring it into the house’s files here, or delete the branch.' }, icon('help', 13)),
      ),
      h('ul', { class: 'leftover-list' }, list.map((b) => row(pid, b, blocked))),
      working && slow ? h('p', { class: 'changes-note is-wait', role: 'status' }, h('span', { class: 'spinner spinner-sm' }), h('span', null, slow)) : null,
      blocked && list.some((b) => b.files || b.lastBring) ? h('p', { class: 'changes-note is-wait' }, icon('clock', 13), h('span', null, `Bring in and Undo wait until ${blocked} is done.`)) : null,
    );
  }

  return {
    el,
    /** The house whose Changes tab shows (its folder, not a job's copy). Reloads when it changed or went stale. */
    show(pid: string) {
      const changed = pid !== projectId;
      projectId = pid;
      if (changed) list = [];
      if (changed || Date.now() - loadedAt > 4000) void load();
      else render();
    },
    /** A job came or went (a delete leaves a branch), or someone started / stopped working (Bring in may wait). */
    refresh(reload: boolean) {
      if (reload) void load();
      else render();
    },
  };
}
