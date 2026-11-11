// Small reusable visual atoms: avatars, status dots, chips, kbd hints, empty states.
import type { AgentInfo, ModelInfo, Vendor } from '../../../shared/protocol';
import { h, type Child, setChildren } from './dom';
import { agentBlocked, agentTone, anyConnected, initial, modelAvailable, vendorColor, type StatusTone } from './format';
import { icon } from './icons';
import { isSingleKeyHint } from './shortcuts';

export function avatar(name: string, vendor: Vendor | undefined, size: 'xs' | 'sm' | 'md' | 'lg' = 'sm', tone?: StatusTone): HTMLElement {
  return h(
    'span',
    { class: ['avatar', `avatar-${size}`, tone && `tone-${tone}`], style: { '--vc': vendorColor(vendor) }, 'aria-hidden': 'true' },
    initial(name),
  );
}

export function agentAvatar(a: AgentInfo, size: 'xs' | 'sm' | 'md' | 'lg' = 'sm'): HTMLElement {
  return avatar(a.name, a.vendor, size, agentTone(a));
}

export function statusDot(tone: StatusTone, label?: string): HTMLElement {
  return h('span', { class: ['status-dot', `tone-${tone}`], role: label ? 'img' : undefined, 'aria-label': label });
}

/** "not connected" after a model's name. `any`: some other AI account is connected (the title then says to sign in to
 *  this provider or pick another model). */
export function notConnectedChip(any = true): HTMLElement {
  const title = any
    ? 'Nobody is signed in to this model’s provider — sign in under Models & providers, or pick another model'
    : 'No AI account connected yet — connect one under Models & providers';
  return h('span', { class: 'chip chip-off', title }, 'not connected');
}

/** The chip after a model's name: none when it can be used, else "not connected". */
export function modelChip(id: string, models: ModelInfo[]): HTMLElement | null {
  if (modelAvailable(id, models)) return null;
  return notConnectedChip(anyConnected(models));
}

/** The same for a person: "not connected" when the server won't start them (format.ts agentBlocked). */
export function agentModelChip(a: Parameters<typeof agentBlocked>[0], models: ModelInfo[], o: { scripted?: boolean; checking?: boolean } = {}): HTMLElement | null {
  return agentBlocked(a, models, o) ? notConnectedChip(anyConnected(models)) : null;
}

export function vendorDot(vendor: Vendor | undefined): HTMLElement {
  return h('span', { class: 'vendor-dot', style: { background: vendorColor(vendor) }, 'aria-hidden': 'true' });
}

/** A key hint. One bare key (W, T, 1, `) is marked kbd-single: it hides while single-key shortcuts are off. */
export function kbd(...keys: string[]): HTMLElement {
  return h('span', { class: ['kbd-group', isSingleKeyHint(keys) && 'kbd-single'], 'aria-hidden': 'true' }, keys.map((k) => h('kbd', null, k)));
}

export function emptyState(iconName: string, title: string, body: Child, action?: Child): HTMLElement {
  return h(
    'div',
    { class: 'empty' },
    h('div', { class: 'empty-icon' }, icon(iconName, 22)),
    h('p', { class: 'empty-title' }, title),
    h('p', { class: 'empty-body' }, body),
    action ?? null,
  );
}

let uidSeq = 0;
/** A page-unique id for aria-labelledby / aria-describedby pairs. */
export function uid(prefix: string): string {
  return `${prefix}-${++uidSeq}`;
}

/** A card-style option (a name and a line about it): the name alone names it and the line describes it, instead of
 *  all its text glued into one long name ("🛠️ Build → ReviewThis job’s teamClaude builds it…",
 *  "GeneralPlan, ask, tidy up"). Spread the result into the option's attributes. */
export function optionNames(name: HTMLElement, desc?: HTMLElement | null): { 'aria-labelledby': string; 'aria-describedby'?: string } {
  if (!name.id) name.id = uid('opt-name');
  if (desc && !desc.id) desc.id = uid('opt-desc');
  return desc ? { 'aria-labelledby': name.id, 'aria-describedby': desc.id } : { 'aria-labelledby': name.id };
}

/** A visible label for a group of options (a radiogroup): a div, not a <label> — a <label> would name only the
 *  group's first option, with the label and hint text glued onto it ("Effort How hard they think Default is…"). */
export function groupField(label: string, group: HTMLElement, hint?: string): HTMLElement {
  const labelId = uid('fl');
  const hintId = hint ? uid('fh') : undefined;
  group.removeAttribute('aria-label');
  group.setAttribute('aria-labelledby', labelId);
  if (hintId) group.setAttribute('aria-describedby', hintId);
  return h(
    'div',
    { class: 'field' },
    h('span', { class: 'field-label', id: labelId }, label),
    group,
    hint ? h('span', { class: 'field-hint', id: hintId }, hint) : null,
  );
}

/** Option buttons as a radiogroup: one Tab stop (the picked option), arrows move and pick (radios.ts). */
export function segmented<T extends string>(
  options: { value: T; label: string; icon?: string }[],
  value: T,
  onChange: (v: T) => void,
  ariaLabel: string,
): HTMLElement {
  const wrap = h('div', { class: 'segmented', role: 'radiogroup', 'aria-label': ariaLabel });
  const render = (current: T) => {
    setChildren(wrap,
      ...options.map((o) =>
        h(
          'button',
          {
            type: 'button',
            role: 'radio',
            'aria-checked': String(o.value === current),
            tabindex: o.value === current ? '0' : '-1',
            'data-focus-key': `seg:${o.value}`,
            class: ['seg', o.value === current && 'is-on'],
            onclick: () => {
              render(o.value);
              onChange(o.value);
            },
          },
          o.icon ? icon(o.icon, 14) : null,
          o.label,
        ),
      ),
    );
    // nothing picked (a value not among the options): the first option is the Tab stop
    if (!options.some((o) => o.value === current)) (wrap.firstElementChild as HTMLElement | null)?.setAttribute('tabindex', '0');
  };
  render(value);
  return wrap;
}

export const isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);
export const modKey = isMac ? '⌘' : 'Ctrl';
