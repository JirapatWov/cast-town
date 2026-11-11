// Job actions: the "⋯" menu, quick rename popover and delete confirmation.
import { DEFAULT_WORK_STYLE, type Job } from '../../../shared/protocol';
import { gitKey } from '../net/reducer';
import { h } from './dom';
import { WORK_STYLES, jobRoomCode, kindInfo } from './jobs';
import { openMenu } from './menu';
import { openPopover } from './popover';
import { setWorkStyle } from './work-style';
import type { Shell } from './shell';

export function openJobMenu(shell: Shell, anchor: HTMLElement, job: Job) {
  const jobs = shell.store.jobsOf(job.projectId);
  const last = jobs.length <= 1;
  const style = job.workStyle ?? DEFAULT_WORK_STYLE;
  const lead = shell.store.agentsOfJob(job.projectId, job.id).find((a) => a.roleId === 'assistant' && a.kind !== 'subagent')?.name ?? kindInfo(job.kind).lead;
  openMenu(
    shell.root,
    shell.layers,
    anchor,
    [
      {
        title: `${jobRoomCode(job)} · ${job.name}`,
        items: [
          { label: 'Rename…', icon: 'pencil', onSelect: () => shell.editJob(job.projectId, job.id, 'rename', anchor) },
          { label: 'Edit job (kind, lead, team, brief)…', icon: 'wand', onSelect: () => shell.editJob(job.projectId, job.id, 'edit') },
          { label: 'Move to another room…', icon: 'layers', onSelect: () => shell.editJob(job.projectId, job.id, 'move') },
          ...(job.worktree
            ? [{
                label: 'Changes in its own copy…',
                icon: 'copy',
                hint: 'bring into house',
                onSelect: () => {
                  shell.selectJob(job.projectId, job.id);
                  shell.openPanel('changes', job.projectId);
                },
              }]
            : []),
        ],
      },
      {
        title: `How the ${lead} works`,
        items: WORK_STYLES.map((st) => ({
          label: st.label,
          hint: st.short,
          checked: st.id === style,
          onSelect: () => void setWorkStyle(shell, job, st.id, lead),
        })),
      },
      {
        items: [
          {
            label: 'Delete job…',
            icon: 'trash',
            disabled: last,
            hint: last ? 'last job' : undefined,
            onSelect: () => void shell.deleteJob(job.projectId, job.id),
          },
        ],
      },
    ],
    { id: 'job-menu', align: 'end', minWidth: 250, className: 'job-menu', focusFirst: true },
  );
}

export function openRenamePopover(shell: Shell, anchor: HTMLElement, job: Job) {
  const input = h('input', { class: 'input', value: job.name, maxlength: '60', 'aria-label': 'Job name', autocomplete: 'off', spellcheck: 'false' });
  const save = h('button', { type: 'button', class: 'btn btn-primary btn-sm' }, 'Rename');
  const go = async () => {
    const name = input.value.trim();
    if (!name) {
      input.classList.add('is-invalid');
      setTimeout(() => input.classList.remove('is-invalid'), 900);
      return input.focus();
    }
    if (name === job.name) return close();
    save.disabled = true;
    try {
      await shell.store.request({ t: 'update_job', reqId: '', projectId: job.projectId, jobId: job.id, patch: { name } });
      close();
    } catch (err) {
      save.disabled = false;
      shell.toast('error', `Could not rename: ${(err as Error).message}`);
    }
  };
  input.addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter' && !ev.isComposing) {
      ev.preventDefault();
      void go();
    }
  });
  save.addEventListener('click', () => void go());
  const pop = h(
    'div',
    { class: 'save-pop rename-pop glass-strong', role: 'dialog', 'aria-label': 'Rename job' },
    h('label', { class: 'field' }, h('span', { class: 'field-label' }, `Rename room ${jobRoomCode(job)}`), input),
    h('div', { class: 'save-pop-actions' }, save),
  );
  const target = anchor.isConnected ? anchor : (shell.root.querySelector<HTMLElement>('.jobs-head') ?? shell.root);
  const close = openPopover(shell.root, shell.layers, target, pop, { id: 'rename-job', align: 'end' });
  requestAnimationFrame(() => {
    input.focus();
    input.select();
  });
}

export async function confirmDeleteJob(shell: Shell, job: Job): Promise<boolean> {
  const people = shell.store.agentsOfJob(job.projectId, job.id).filter((a) => a.kind !== 'subagent');
  const copy = job.worktree;
  const summary = copy ? shell.store.state.git[gitKey(job.projectId, job.id)] : undefined;
  const waiting = summary?.files.length ?? 0; // not brought in yet
  const unknown = !!copy && !summary; // its copy wasn't looked at yet: it may have changes
  const bringFirst = () => {
    shell.selectJob(job.projectId, job.id);
    shell.openPanel('changes', job.projectId);
  };
  const ok = await shell.confirm({
    title: `Delete “${job.name}”?`,
    body: h(
      'div',
      null,
      h('p', null, people.length === 1
        ? `${people[0].name} leaves room ${jobRoomCode(job)} and stops working.`
        : `${people.length ? listNames(people.map((p) => p.name)) : 'Everyone'} ${people.length ? 'leave' : 'leaves'} room ${jobRoomCode(job)} and ${people.length ? 'stop' : 'stops'} working.`),
      copy
        ? [
            h('p', null, 'Its own copy of the files is put away: everything in it is saved as a commit on the branch ', h('code', null, copy.branch), ', which stays in the repository — nothing is lost.'),
            waiting || unknown
              ? h(
                  'p',
                  { class: 'revert-warn' },
                  waiting
                    ? `${waiting === 1 ? '1 changed file hasn’t' : `${waiting} changed files haven’t`} been brought into the house yet. ${waiting === 1 ? 'It stays' : 'They stay'} on that branch only.`
                    : 'Its changes may not be in the house yet; after deleting they stay on that branch only.',
                  ' Bring into house first to keep them in the house’s files.',
                )
              : null,
            waiting || unknown
              ? h('p', { class: 'muted small' }, 'To get them later: the house’s Changes tab lists the branch under “Left over from deleted jobs”, with Bring in.')
              : null,
            h('p', { class: 'muted' }, 'The house’s files and the chat history stay on disk. The room becomes free for a new job.'),
          ]
        : h('p', { class: 'muted' }, 'Files in the folder and the chat history stay on disk. The room becomes free for a new job.'),
    ),
    confirmLabel: 'Delete job',
    tone: 'danger',
    icon: 'trash',
    ...(waiting || unknown ? { alt: { label: 'Bring into house first', icon: 'copy', onSelect: bringFirst } } : {}),
  });
  if (!ok) return false;
  try {
    // a copy is committed to its branch before it goes: minutes on a big repo
    await shell.store.request(
      { t: 'delete_job', reqId: '', projectId: job.projectId, jobId: job.id },
      copy ? { onSlow: () => shell.toast('info', `Still deleting “${job.name}” — saving its copy to the branch ${copy.branch} first…`, { projectId: job.projectId }) } : undefined,
    );
    shell.toast('info', `Deleted “${job.name}”. Room ${jobRoomCode(job)} is free.${copy ? ` Its work is kept on the branch ${copy.branch} (Changes → Left over from deleted jobs).` : ''}`, { projectId: job.projectId });
    return true;
  } catch (err) {
    shell.toast('error', `Could not delete: ${(err as Error).message}`);
    return false;
  }
}


/** "A", "A and B", "A, B and C". */
function listNames(names: string[]): string {
  return names.length < 2 ? names.join('') : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}
