// Permission modes (Claude Code style): how much the people of a house may do without asking. Shown as a chip under
// the chat input; Alt+M in the input cycles the everyday modes, Bypass only from the menu (with a confirm).
import type { ApprovalMode, Project } from '../../../shared/protocol';
import { RequestError } from '../net/requests';
import { h } from './dom';
import { icon } from './icons';
import { openMenu } from './menu';
import { openModal } from './modal';
import { autoAsksAbout, autoRuleLabel } from '../../../shared/auto-rules';
import type { Shell } from './shell';

interface ModeInfo {
  id: ApprovalMode;
  label: string;
  icon: string;
  hint: string;
}

// The hints say what each mode really does (omp's approval modes; Auto = shared/auto-rules.ts) — no more, no less.
export const MODES: ModeInfo[] = [
  { id: 'always-ask', label: 'Ask first', icon: 'hand', hint: 'Asks before every edit, command and helper. Reading files doesn’t ask.' },
  { id: 'write', label: 'Accept edits', icon: 'pencil', hint: 'Edits files without asking — not only in this folder. Asks before it runs commands or scripts, opens a browser or starts helpers.' },
  {
    id: 'auto',
    label: 'Auto',
    icon: 'wand',
    hint: 'Asks only about steps its rules flag as risky — sudo, deleting folders, force-pushing or throwing away git work, files outside the project, sending data to the internet. Edits and commands inside the project, a plain git push and requests to this machine run. Best effort, not a sandbox: what the rules don’t recognise runs without asking.',
  },
  { id: 'yolo', label: 'Bypass', icon: 'alert', hint: 'Never asks — any command, any file, the network. Only for folders you could lose.' },
];

/** Alt+M cycles these (Bypass is never one key away). */
const CYCLE: ApprovalMode[] = ['always-ask', 'write', 'auto'];

export const modeInfo = (mode: ApprovalMode): ModeInfo => MODES.find((m) => m.id === mode) ?? MODES[1];

/** True once the house has `mode` (false: the confirm was declined, or the server said no — a toast says why). */
export async function setPermissionMode(shell: Shell, project: Project, mode: ApprovalMode): Promise<boolean> {
  if (mode === project.approvalMode) return true;
  if (mode === 'yolo') {
    const ok = await shell.confirm({
      title: `Never ask in “${project.name}”?`,
      body: 'Everyone in this house will run any command, delete files and use the network without asking you. Use it only for a folder you could lose.',
      confirmLabel: 'Never ask',
      tone: 'danger',
      icon: 'alert',
    });
    if (!ok) return false;
  }
  try {
    await shell.store.request({ t: 'set_project', reqId: '', projectId: project.id, patch: { approvalMode: mode } });
    const m = modeInfo(mode);
    shell.toast('info', `${m.label} for everyone in ${project.name} — ${m.hint}`, { projectId: project.id });
    return true;
  } catch (err) {
    shell.toast('error', err instanceof RequestError ? err.message : `Could not change the mode: ${(err as Error).message}`);
    return false;
  }
}

export function cyclePermissionMode(shell: Shell, project: Project): void {
  const i = CYCLE.indexOf(project.approvalMode);
  void setPermissionMode(shell, project, CYCLE[(i + 1) % CYCLE.length]);
}

/** Under the modes: a house without git can't undo edits (say so and offer the fix), what Auto really checks, and the key. */
function permFooter(shell: Shell, project: Project): HTMLElement {
  return h(
    'div',
    { class: 'perm-foot' },
    project.isGit
      ? null
      : h(
          'p',
          { class: 'perm-foot-warn' },
          icon('alert', 13),
          h('span', null, `${project.name} has no git, so edits can’t be seen or undone. `, h('button', { type: 'button', class: 'link-btn', onclick: () => (shell.layers.closeTop(), shell.openPanel('changes', project.id)) }, 'Set up git…')),
        ),
    h('p', { class: 'muted small' }, h('button', { type: 'button', class: 'link-btn', onclick: () => (shell.layers.closeTop(), openAutoRules(shell)) }, 'What Auto checks'), h('span', { class: 'perm-foot-key' }, ' · Alt+M in the message box switches Ask first → Accept edits → Auto.')),
  );
}

/** The list of Auto's rules, straight from the data the server checks with. */
export function openAutoRules(shell: Shell): void {
  const modal = openModal(shell.root, shell.layers, {
    id: 'auto-rules',
    className: 'modal-auto-rules',
    title: 'What Auto checks',
    subtitle: 'Auto answers routine steps itself and stops for the ones its rules flag. It is a best-effort pattern check, not a sandbox.',
    body: h(
      'div',
      { class: 'auto-rules' },
      h('p', { class: 'field-label' }, 'It asks you before a step that…'),
      h('ul', { class: 'auto-rules-list' }, autoAsksAbout().map((r) => h('li', null, r))),
      h('p', { class: 'field-label' }, 'Everything else runs without asking, for example'),
      h(
        'ul',
        { class: 'auto-rules-list is-quiet' },
        h('li', null, 'reading any file the server’s user can read'),
        h('li', null, 'editing files inside the project folder (except secrets files and git internals)'),
        h('li', null, 'commands the rules don’t match: tests, builds, installing the project’s dependencies, chmod inside the project'),
        h('li', null, 'git commit, rebase, restoring single files, and a plain git push to one of the project’s remotes'),
        h('li', null, 'requests to this machine (localhost) and downloading web pages'),
        h('li', null, 'looking at the system: systemctl status, service … status, tailscale status, crontab -l, mount'),
        h('li', null, 'code that runs, deletes or sends the same things — checked like the command line'),
        h('li', null, 'the agent’s own notes, memory, skills and helpers — helpers’ own steps are checked one by one'),
      ),
      h(
        'p',
        { class: 'muted small' },
        'A command too long to check, a command code puts together while running, or a tool Auto has no rule for always comes to you. On a card Auto stopped, “Always allow in <house>” lets that rule through in that house from then on (the permission menu lists and removes them) — never for credentials, secrets files, downloaded scripts, deleting outside the project or raw device writes.',
      ),
    ),
    footer: [h('button', { type: 'button', class: 'btn btn-primary', onclick: () => modal.close() }, 'Got it')],
  });
}

/** Take a rule off the house's standing allows: Auto asks about it again there. */
async function removeStandingAllow(shell: Shell, project: Project, rule: string): Promise<void> {
  try {
    await shell.store.request({ t: 'set_project', reqId: '', projectId: project.id, patch: { autoAllow: (project.autoAllow ?? []).filter((r) => r !== rule) } });
    shell.toast('info', `Auto asks again in ${project.name} before a step that ${autoRuleLabel(rule)}.`, { projectId: project.id });
  } catch (err) {
    shell.toast('error', err instanceof RequestError ? err.message : `Could not remove it: ${(err as Error).message}`);
  }
}

/** The chip under the chat input: current mode, click for the menu. */
export function permissionChip(shell: Shell, project: Project): HTMLElement {
  const m = modeInfo(project.approvalMode);
  const chip: HTMLButtonElement = h(
    'button',
    {
      type: 'button',
      class: ['perm-chip', `perm-${project.approvalMode}`],
      title: `${m.label}: ${m.hint} (Alt+M in the message box to change)`,
      'aria-label': `Permission mode: ${m.label}. Change`,
      'aria-haspopup': 'menu',
      // the house as it is now: its standing allows change without the chip being drawn again
      onclick: () => openPermissionMenu(shell, shell.store.project(project.id) ?? project, chip),
    },
    icon(m.icon, 13),
    h('span', null, m.label),
    icon('chevronUp', 11),
  );
  return chip;
}

function openPermissionMenu(shell: Shell, project: Project, anchor: HTMLElement): void {
  openMenu(
    shell.root,
    shell.layers,
    anchor,
    [
      {
        title: `What people in ${project.name} may do without asking — every job in this house`,
        items: MODES.map((x) => ({
          label: x.label,
          icon: x.icon,
          hint: x.hint,
          checked: x.id === project.approvalMode,
          onSelect: () => void setPermissionMode(shell, project, x.id),
        })),
      },
      ...(project.autoAllow?.length
        ? [
            {
              title: `Auto always allows in ${project.name} — choose one to remove it`,
              items: project.autoAllow.map((rule) => ({
                label: autoRuleLabel(rule),
                icon: 'x',
                hint: 'Remove: Auto asks about this again',
                onSelect: () => void removeStandingAllow(shell, project, rule),
              })),
            },
          ]
        : []),
    ],
    { id: 'permission-mode', placement: 'above', align: 'start', minWidth: 320, className: 'perm-menu', footer: permFooter(shell, project) },
  );
}
