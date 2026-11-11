// The model chip under the chat box (next to the permission chip): which model the person runs on. A job's lead picks
// it right here (update_job, the same as the job dialog: this chat now — from its next step while it works — and new
// chats in that job). A standing team member's model belongs to its workflow, which is the house's own (every job of
// the house with that team shares it; other houses have their own copies): read only, with the way to the Workflow
// tab. Helpers and one-off team people get no chip. Alt+P in the box opens it.
import type { AgentInfo, Job, JobPatch, Workflow, WorkflowStep } from '../../../shared/protocol';
import { RequestError } from '../net/requests';
import { h } from './dom';
import { blockOpts } from './agents-health';
import { agentBlocked, anyConnected, isAgentBusy, modelGroupTitle, modelGroups, modelLabel, modelNames, vendorColor, vendorOfModel } from './format';
import { icon } from './icons';
import { openMenu, type MenuSection } from './menu';
import type { Shell } from './shell';
import { isMac } from './widgets';

/** A chip's menu, open or not: clicking the chip (or its key) again closes it instead of stacking a second one. */
const openMenus = new Map<string, () => void>();
export function toggleChipMenu(shell: Shell, id: string, open: () => () => void): void {
  const close = openMenus.get(id);
  openMenus.delete(id);
  if (close && shell.layers.has(id)) return close();
  openMenus.set(id, open());
}

/** "Alt" / "⌥": the chips' shortcut key (matched by ev.code, so ⌥P typing "π" on a Mac still opens it). */
export const altKey = isMac ? '⌥' : 'Alt';

/** A vendor's state in a model menu's section title — the same words as the Models & providers cards. */
export function vendorStateText(connected: boolean): string {
  return connected ? '' : ' · not connected';
}

/** The label the chip shows: the vendor word goes ("Claude Opus 5.5" → "Opus 5.5"; "GPT-6.1 Sol" stays). */
export function shortModelLabel(label: string): string {
  const short = label.replace(/^Claude\s+/i, '').trim();
  return short || label;
}

/** Who sets a person's model and effort, as the chips need it. */
export type ChipOwner =
  | { by: 'job'; job: Job }
  | { by: 'team'; job: Job | undefined; workflow: Workflow | undefined; step: WorkflowStep | undefined };

/** null → no chips for this person (a helper, a one-off team person, or an older server that doesn't say). */
export function chipOwner(shell: Shell, a: AgentInfo): ChipOwner | null {
  const job = shell.store.job(a.projectId, a.jobId);
  if (a.modelBy === 'job') return job ? { by: 'job', job } : null;
  if (a.modelBy === 'team') {
    const wfId = job ? job.workflowId : shell.store.project(a.projectId)?.workflowId;
    const workflow = shell.store.workflowOf(a.projectId, wfId);
    return { by: 'team', job, workflow, step: workflow?.steps.find((x) => x.id === a.roleId) };
  }
  return null;
}

/** Save a lead's model or effort (update_job) and say what changed; the person's `agent` update redraws the chips. */
export async function patchLead(shell: Shell, a: AgentInfo, job: Job, patch: JobPatch, done: string): Promise<void> {
  try {
    await shell.store.request({ t: 'update_job', reqId: '', projectId: a.projectId, jobId: job.id, patch });
    shell.toast('info', `${done}${isAgentBusy(a) ? ' — from its next step.' : '.'}`, { agentId: a.id });
  } catch (err) {
    shell.toast('error', err instanceof RequestError ? err.message : `Couldn’t change it: ${(err as Error).message}`, { agentId: a.id });
  }
}

/** A read-only chip's menu: who sets it, and the way to change it there. */
export function openTeamMenu(shell: Shell, a: AgentInfo, owner: Extract<ChipOwner, { by: 'team' }>, anchor: HTMLElement, what: 'model' | 'effort'): void {
  const wf = owner.workflow;
  toggleChipMenu(shell, `chip-${what}`, () => openMenu(
    shell.root,
    shell.layers,
    anchor,
    [
      {
        title: `${a.name}’s ${what} is set by the team`,
        items: [{ label: 'Change it in the Workflow tab', icon: 'workflow', onSelect: () => shell.openWorkflow(a.projectId) }],
      },
    ],
    {
      id: `chip-${what}`,
      placement: 'above',
      align: 'start',
      minWidth: 280,
      className: 'chip-menu',
      footer: h(
        'span',
        null,
        wf
          ? `The “${wf.name}” workflow sets it for ${a.name}. It is this house’s workflow: a change there is for every job here that uses it (not other houses, not per chat).`
          : `${a.name}’s workflow sets it, not the chat.`,
      ),
    },
  ));
}

/** The model menu of a lead: models grouped by vendor; without a sign-in a model can't be picked once anything is
 *  connected (as the job dialog) — with nothing connected any can, and works once its account is. after: run once a
 *  model was picked (Alt+P puts the focus back in the box). */
export function openModelMenu(shell: Shell, a: AgentInfo, anchor: HTMLElement, after?: () => void): void {
  const owner = chipOwner(shell, a);
  if (!owner) return;
  if (owner.by === 'team') return openTeamMenu(shell, a, owner, anchor, 'model');
  const job = owner.job;
  const s = shell.store.state;
  const live = anyConnected(s.models);
  const names = modelNames(s.models);
  const current = job.leadModel || a.model;
  const sections: MenuSection[] = modelGroups(s.models).map((g) => {
    const connected = s.providers.find((p) => p.vendor === g.vendor)?.connected ?? false;
    return {
      title: g.route ? modelGroupTitle(g) : `${modelGroupTitle(g)}${vendorStateText(connected)}`,
      items: g.models.map((m) => ({
        label: names.get(m.id) ?? m.label,
        swatch: vendorColor(m.vendor),
        checked: m.id === current,
        disabled: live && !m.available && m.id !== current,
        hint: h('span', { class: ['avail', m.available ? 'is-ready' : live ? 'is-off' : 'is-setup'] }, m.available ? 'ready' : 'not connected'),
        onSelect: () => {
          after?.();
          if (m.id !== current) void patchLead(shell, a, job, { leadModel: m.id }, `${a.name} now uses ${names.get(m.id) ?? m.label}`);
        },
      })),
    };
  });
  let close = () => {};
  toggleChipMenu(shell, 'chip-model', () => (close = openMenu(shell.root, shell.layers, anchor, sections, {
    id: 'chip-model',
    placement: 'above',
    align: 'start',
    minWidth: 280,
    className: 'model-menu chip-menu',
    footer: h(
      'span',
      null,
      `For ${a.name} in “${job.name}”: this chat now (from the next step if working) and every new chat. A new model reads the whole chat again, without the cache.`,
      ' ',
      // the way to more models — and, with none connected, to the first account (nobody can work until then)
      h('button', { type: 'button', class: 'link-btn', onclick: () => (close(), shell.openProviders()) }, live ? 'Sign in to more…' : 'Connect an AI account…'),
    ),
  })));
}

/** The chip; null → none for this person. */
export function personModelChip(shell: Shell, a: AgentInfo): HTMLElement | null {
  const owner = chipOwner(shell, a);
  if (!owner) return null;
  const s = shell.store.state;
  const id = owner.by === 'job' ? owner.job.leadModel || a.model : a.model;
  const label = id === a.model ? a.modelLabel : modelLabel(id, s.models);
  // not connected (another account is, or none is): the person can't work on it
  const blocked = agentBlocked(id === a.model ? a : { model: id }, s.models, blockOpts(s.hello));
  const team = owner.by === 'team';
  const shown = shortModelLabel(label);
  // the chip stays short; its tooltip and name say which sign-in when another listed model has the same name
  const full = s.models.some((m) => m.id === id) ? modelLabel(id, s.models) : label;
  const named = shortModelLabel(full);
  const title = team
    ? `${full}${blocked ? ' — not connected' : ''} — set by the team (Workflow tab)`
    : `${full}${blocked ? ' — not connected' : ''}. Change the model (${altKey}+P)`;
  const chip: HTMLButtonElement = h(
    'button',
    {
      type: 'button',
      class: ['perm-chip', 'chip-model', team && 'is-readonly', blocked && 'is-warn'],
      'data-chip': 'model',
      title,
      'aria-label': team ? `Model: ${named}, set by the team` : `Model: ${named}. Change`,
      'aria-haspopup': 'menu',
      onclick: () => openModelMenu(shell, a, chip),
    },
    h('span', { class: 'vendor-dot', style: { background: vendorColor(vendorOfModel(id, s.models)) }, 'aria-hidden': 'true' }),
    h('span', { class: 'chip-label' }, shown),
    team ? null : icon('chevronUp', 11),
  );
  return chip;
}
