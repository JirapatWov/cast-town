// "You" settings: show the homeowner avatar in houses, pick a look (rendered portraits), WASD walking.
// A section in the graphics menu plus a small popover; state lives in player/prefs (per browser).
import './css/player.css';
import { PLAYER_LOOKS, lookIndex, playerPrefs } from '../player/prefs';
import { h, setChildren } from './dom';
import { icon } from './icons';
import type { MenuSection } from './menu';
import { openPopover } from './popover';
import type { Shell } from './shell';

/** The menu section (null when there is no 3D avatar to configure). `anchor` is the button the menu hangs from. */
export function playerMenuSection(shell: Shell, anchor: HTMLElement): MenuSection | null {
  if (!playerPrefs.available) return null;
  const p = playerPrefs.get();
  return {
    title: 'You',
    items: [
      {
        label: 'Show me in the house',
        hint: 'Avatar',
        checked: p.show,
        onSelect: () => playerPrefs.set({ show: !playerPrefs.get().show }),
      },
      {
        label: 'My look & walking…',
        icon: 'users',
        onSelect: () => requestAnimationFrame(() => openPlayerSettings(shell, anchor)),
      },
    ],
  };
}

function toggle(label: string, on: boolean, onChange: (on: boolean) => void, describedBy?: string): HTMLButtonElement {
  const btn = h(
    'button',
    {
      type: 'button',
      class: 'you-switch',
      role: 'switch',
      'aria-checked': String(on),
      'aria-label': label,
      'aria-describedby': describedBy,
      onclick: () => {
        const next = btn.getAttribute('aria-checked') !== 'true';
        btn.setAttribute('aria-checked', String(next));
        onChange(next);
      },
    },
    h('span', { class: 'you-switch-knob' }),
  ) as HTMLButtonElement;
  return btn;
}

const SILHOUETTE =
  '<svg viewBox="0 0 56 70" aria-hidden="true"><circle cx="28" cy="25" r="11" fill="currentColor"/><path d="M8 70c0-14 9-24 20-24s20 10 20 24z" fill="currentColor"/></svg>';

export function openPlayerSettings(shell: Shell, anchor: HTMLElement): () => void {
  const p = playerPrefs.get();
  const grid = h('div', { class: 'you-looks', role: 'radiogroup', 'aria-label': 'Your look' });
  const cards = PLAYER_LOOKS.map((look) => {
    const img = h('span', { class: 'you-look-img', html: SILHOUETTE });
    const card = h(
      'button',
      {
        type: 'button',
        class: ['you-look', look.id === p.look && 'is-on'],
        role: 'radio',
        'aria-checked': String(look.id === p.look),
        'aria-label': `${look.label} (${look.gender === 'f' ? 'woman' : 'man'})`,
        title: look.label,
        onclick: () => {
          playerPrefs.set({ look: look.id, show: true });
          for (const c of cards) {
            c.classList.toggle('is-on', c === card);
            c.setAttribute('aria-checked', String(c === card));
          }
          showSwitch.setAttribute('aria-checked', 'true');
        },
      },
      img,
      h('span', { class: 'you-look-check' }, icon('check', 12)),
    );
    void playerPrefs.portrait(look.id).then((url) => {
      if (!url) {
        img.classList.add('is-flat');
        return;
      }
      const el = new Image();
      el.alt = '';
      el.decoding = 'async';
      el.src = url;
      el.onload = () => setChildren(img, el);
    });
    return card;
  });
  setChildren(grid, ...cards);
  grid.addEventListener('keydown', (ev) => {
    const i = cards.indexOf(document.activeElement as HTMLButtonElement);
    if (i < 0) return;
    const step = ev.key === 'ArrowRight' ? 1 : ev.key === 'ArrowLeft' ? -1 : ev.key === 'ArrowDown' ? 4 : ev.key === 'ArrowUp' ? -4 : 0;
    if (!step) return;
    ev.preventDefault();
    cards[(i + step + cards.length) % cards.length].focus();
  });

  const showSwitch = toggle('Show me in the house', p.show, (on) => playerPrefs.set({ show: on }), 'you-show-hint');
  const wasdSwitch = toggle('Walk with W A S D', p.wasd, (on) => playerPrefs.set({ wasd: on }), 'you-wasd-hint');

  const el = h(
    'div',
    { class: 'you-pop glass-strong', role: 'dialog', 'aria-label': 'You in the house' },
    h('div', { class: 'you-row' },
      h('div', { class: 'you-row-text' },
        h('div', { class: 'you-title' }, 'Show me in the house'),
        h('div', { class: 'you-hint', id: 'you-show-hint' }, 'You walk to whatever you click. You never get in the way.'),
      ),
      showSwitch,
    ),
    h('div', { class: 'you-sep' }),
    h('div', { class: 'you-label' }, 'Your look'),
    grid,
    h('div', { class: 'you-sep' }),
    h('div', { class: 'you-row' },
      h('div', { class: 'you-row-text' },
        h('div', { class: 'you-title' }, 'Walk with ', h('kbd', null, 'W'), h('kbd', null, 'A'), h('kbd', null, 'S'), h('kbd', null, 'D')),
        h('div', { class: 'you-hint', id: 'you-wasd-hint' }, 'Arrow keys always walk when the 3D view has focus. With this on, W A S D walk too instead of their shortcuts.'),
      ),
      wasdSwitch,
    ),
  );
  const close = openPopover(shell.root, shell.layers, anchor, el, { id: 'you-pop', align: 'end', onClose: () => playerPrefs.cancelPortraits() });
  requestAnimationFrame(() => (cards[lookIndex(p.look)] ?? cards[0])?.focus({ preventScroll: true }));
  return close;
}
