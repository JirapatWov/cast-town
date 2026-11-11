// How a job's lead goes about an ask (Job.workStyle: plan card first / just go / teams only on request), shown where
// teams happen — a chip on the Workflow tab, a link on the plan card — not only in the job's ⋯ menu.
import { DEFAULT_WORK_STYLE, type Job, type WorkStyle } from '../../../shared/protocol';
import { h } from './dom';
import { icon } from './icons';
import { WORK_STYLES } from './jobs';
import { openMenu } from './menu';
import type { Shell } from './shell';

export async function setWorkStyle(shell: Shell, job: Job, workStyle: WorkStyle, lead?: string): Promise<boolean> {
  if ((job.workStyle ?? DEFAULT_WORK_STYLE) === workStyle) return true;
  try {
    await shell.store.request({ t: 'update_job', reqId: '', projectId: job.projectId, jobId: job.id, patch: { workStyle } });
    const st = WORK_STYLES.find((s) => s.id === workStyle)!;
    shell.toast('success', `“${job.name}”: ${st.label}${lead ? ` — ${st.hint(lead)}` : ''}`, { projectId: job.projectId });
    return true;
  } catch (err) {
    shell.toast('error', `Could not change it: ${(err as Error).message}`);
    return false;
  }
}

export function openWorkStyleMenu(shell: Shell, anchor: HTMLElement, job: Job, lead: string) {
  const style = job.workStyle ?? DEFAULT_WORK_STYLE;
  openMenu(
    shell.root,
    shell.layers,
    anchor,
    [
      {
        title: `How the ${lead} works in “${job.name}”`,
        items: WORK_STYLES.map((st) => ({
          label: st.label,
          hint: st.short,
          checked: st.id === style,
          onSelect: () => void setWorkStyle(shell, job, st.id, lead),
        })),
      },
    ],
    { id: 'work-style-menu', minWidth: 260 },
  );
}

/** "Assistant: Show me the plan first ▾" — opens the choice. */
export function workStyleChip(shell: Shell, job: Job, lead: string): HTMLElement {
  const st = WORK_STYLES.find((s) => s.id === (job.workStyle ?? DEFAULT_WORK_STYLE)) ?? WORK_STYLES[0]!;
  return h(
    'button',
    {
      type: 'button',
      class: 'chip ws-chip',
      'aria-haspopup': 'menu',
      title: `${st.hint(lead)} Click to change how the ${lead} works in this job.`,
      onclick: (ev: MouseEvent) => openWorkStyleMenu(shell, ev.currentTarget as HTMLElement, job, lead),
    },
    icon('hand', 12),
    h('span', null, `${lead}: ${st.label}`),
    icon('chevronDown', 12),
  );
}
