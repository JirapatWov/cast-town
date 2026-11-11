// The effort chip under the chat box: how hard the person thinks (omp's thinking level). A lead picks it right here
// (update_job's leadThinking, as the job dialog); a team member's comes from its workflow step (read only). Default is
// omp's own setting, which runs as High. A level the model lacks runs as the nearest lower one it has (omp's rule), so
// the menu says what it becomes on this model. Alt+T in the box opens it.
import type { AgentInfo, ModelInfo, ThinkingLevel } from '../../../shared/protocol';
import { THINKING_LEVELS } from '../../../shared/protocol';
import { h } from './dom';
import { THINKING_LABEL, thinkingChoices } from './format';
import { icon } from './icons';
import { openMenu } from './menu';
import { altKey, chipOwner, openTeamMenu, patchLead, toggleChipMenu } from './model-chip';
import type { Shell } from './shell';

/** omp runs a chat at this level when nothing is set. */
export const DEFAULT_THINKING: ThinkingLevel = 'high';

/** What a level runs as on a model (omp's clamp): itself when the model has it; else the nearest lower level it has,
 *  else its lowest. 'off' stays off. ladder undefined → unknown: taken as is. */
export function effectiveThinking(level: ThinkingLevel, ladder: readonly ThinkingLevel[] | undefined): ThinkingLevel {
  if (level === 'off' || !ladder?.length || ladder.includes(level)) return level;
  const want = THINKING_LEVELS.indexOf(level);
  let out: ThinkingLevel | undefined;
  for (const l of THINKING_LEVELS) {
    if (THINKING_LEVELS.indexOf(l) > want) break;
    if (ladder.includes(l)) out = l;
  }
  return out ?? ladder[0];
}

/** One line per level in the menu. */
export const EFFORT_HINT: Record<ThinkingLevel, string> = {
  off: 'Answers straight away — quickest and cheapest',
  minimal: 'A glance before answering',
  low: 'Quick answers',
  medium: 'Everyday work',
  high: 'Planning, review, tricky bugs',
  xhigh: 'The hardest problems — slower, costs more',
  max: 'All it has — slowest, costs the most',
};

/** Short chip text: "V. high" would read oddly; "X-high" matches omp's own word (xhigh). */
const CHIP_LABEL: Record<ThinkingLevel, string> = { off: 'Off', minimal: 'Minimal', low: 'Low', medium: 'Medium', high: 'High', xhigh: 'X-high', max: 'Max' };

export interface EffortItem {
  value: ThinkingLevel | 'default';
  label: string;
  hint: string;
  /** Runs as another level on this model ("→ High on this model"). */
  becomes?: ThinkingLevel;
}

/** The effort menu's items for a model and the configured level (undefined = Default). */
export function effortItems(model: string, models: ModelInfo[], configured: ThinkingLevel | undefined): EffortItem[] {
  const ladder = models.find((m) => m.id === model)?.thinking;
  const runsAs = (l: ThinkingLevel) => {
    const e = effectiveThinking(l, ladder);
    return e === l ? undefined : e;
  };
  const dflt = runsAs(DEFAULT_THINKING);
  return [
    { value: 'default', label: 'Default', hint: `runs as ${THINKING_LABEL[DEFAULT_THINKING]}`, ...(dflt ? { becomes: dflt } : {}) },
    ...thinkingChoices(model, models, configured).map((l): EffortItem => {
      const b = runsAs(l);
      return { value: l, label: THINKING_LABEL[l], hint: EFFORT_HINT[l], ...(b ? { becomes: b } : {}) };
    }),
  ];
}

/** The person's configured level (undefined = Default) and the model it applies to. */
function effortOf(shell: Shell, a: AgentInfo): { configured: ThinkingLevel | undefined; model: string } | null {
  const owner = chipOwner(shell, a);
  if (!owner) return null;
  if (owner.by === 'job') return { configured: a.thinking ?? owner.job.leadThinking, model: owner.job.leadModel || a.model };
  return { configured: a.thinking ?? owner.step?.thinking, model: a.model };
}

export function openEffortMenu(shell: Shell, a: AgentInfo, anchor: HTMLElement, after?: () => void): void {
  const owner = chipOwner(shell, a);
  const eff = effortOf(shell, a);
  if (!owner || !eff) return;
  if (owner.by === 'team') return openTeamMenu(shell, a, owner, anchor, 'effort');
  const job = owner.job;
  const items = effortItems(eff.model, shell.store.state.models, eff.configured);
  toggleChipMenu(shell, 'chip-effort', () => openMenu(
    shell.root,
    shell.layers,
    anchor,
    [
      {
        title: `Effort — how hard ${a.name} thinks`,
        items: items.map((it) => ({
          label: it.label,
          hint: h('span', null, it.hint, it.becomes ? h('span', { class: 'effort-becomes' }, ` → ${THINKING_LABEL[it.becomes]} on this model`) : null),
          checked: it.value === (eff.configured ?? 'default'),
          onSelect: () => {
            after?.();
            const next = it.value === 'default' ? undefined : it.value;
            if (next === eff.configured) return;
            void patchLead(shell, a, job, { leadThinking: next ?? null }, `${a.name}’s effort is now ${next ? THINKING_LABEL[next] : `Default (${THINKING_LABEL[DEFAULT_THINKING]})`}`);
          },
        })),
      },
    ],
    {
      id: 'chip-effort',
      placement: 'above',
      align: 'start',
      minWidth: 300,
      className: 'perm-menu chip-menu effort-menu',
      footer: h('span', null, `For ${a.name} in “${job.name}”: this chat now (from the next step if working) and every new chat. More effort is slower and costs more.`),
    },
  ));
}

/** The chip; null → none for this person. */
export function effortChip(shell: Shell, a: AgentInfo): HTMLElement | null {
  const owner = chipOwner(shell, a);
  const eff = effortOf(shell, a);
  if (!owner || !eff) return null;
  const ladder = shell.store.state.models.find((m) => m.id === eff.model)?.thinking;
  const level = eff.configured ?? DEFAULT_THINKING;
  const runs = effectiveThinking(level, ladder);
  const team = owner.by === 'team';
  const named = eff.configured ? THINKING_LABEL[eff.configured] : `Default (${THINKING_LABEL[DEFAULT_THINKING]})`;
  const what = `Effort: ${named}${runs !== level ? ` — runs as ${THINKING_LABEL[runs]} on this model` : ''}`;
  const chip: HTMLButtonElement = h(
    'button',
    {
      type: 'button',
      class: ['perm-chip', 'chip-effort', team && 'is-readonly', `is-${runs}`],
      'data-chip': 'effort',
      title: team ? `${what} — set by the team (Workflow tab)` : `${what}. Change (${altKey}+T)`,
      'aria-label': team ? `${what}, set by the team` : `${what}. Change`,
      'aria-haspopup': 'menu',
      onclick: () => openEffortMenu(shell, a, chip),
    },
    icon('brain', 12),
    h('span', { class: 'chip-label' }, CHIP_LABEL[runs]),
    team ? null : icon('chevronUp', 11),
  );
  return chip;
}
