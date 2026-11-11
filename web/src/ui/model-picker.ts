// Model picker: a button showing the current model, opening a menu grouped by vendor with availability. When any
// provider is signed in, models without a sign-in can't be used: they show "not connected" and can't be picked. With
// none signed in, any can be picked (people work once an account is connected).
// Models another sign-in brings (Antigravity's Claude) have a section of their own, and a name two models share says
// the route ("Claude Opus 5.5 · via Antigravity").
import { h, setChildren } from './dom';
import { anyConnected, modelGroupTitle, modelGroups, modelLabel, modelNames, vendorColor, vendorOfModel } from './format';
import { icon } from './icons';
import { openMenu, type MenuSection } from './menu';
import type { Shell } from './shell';
import { modelChip } from './widgets';
import { vendorStateText } from './model-chip';

export function createModelPicker(shell: Shell, value: string, onChange: (id: string) => void): HTMLElement {
  let current = value;
  const btn = h('button', { type: 'button', class: 'model-btn', 'aria-haspopup': 'menu' });

  const render = () => {
    const models = shell.store.state.models;
    const vendor = vendorOfModel(current, models);
    setChildren(btn,
      h('span', { class: 'vendor-dot', style: { background: vendorColor(vendor) } }),
      h('span', { class: 'model-btn-label' }, modelLabel(current, models)),
      modelChip(current, models),
      icon('chevronDown', 14, 'model-btn-chev'),
    );
    btn.setAttribute('aria-label', `Model: ${modelLabel(current, models)}`);
  };

  btn.addEventListener('click', () => {
    const s = shell.store.state;
    const live = anyConnected(s.models);
    const names = modelNames(s.models);
    const sections: MenuSection[] = modelGroups(s.models).map((g) => {
      const connected = s.providers.find((p) => p.vendor === g.vendor)?.connected ?? false;
      return {
        title: g.route ? modelGroupTitle(g) : `${modelGroupTitle(g)}${vendorStateText(connected)}`,
        items: g.models.map((m) => ({
          label: names.get(m.id) ?? m.label,
          swatch: vendorColor(m.vendor),
          checked: m.id === current,
          disabled: live && !m.available,
          hint: h('span', { class: ['avail', m.available ? 'is-ready' : live ? 'is-off' : 'is-setup'] }, m.available ? 'ready' : 'not connected'),
          onSelect: () => {
            current = m.id;
            render();
            onChange(m.id);
          },
        })),
      };
    });
    let closeMenu = () => {};
    closeMenu = openMenu(shell.root, shell.layers, btn, sections, {
      id: 'model-menu',
      minWidth: 300,
      className: 'model-menu',
      footer: live
        ? h(
            'span',
            null,
            'Models without a sign-in can’t be used — ',
            h('button', { type: 'button', class: 'link-btn', onclick: () => (closeMenu(), shell.openProviders()) }, 'sign in under Models & providers'),
            '.',
          )
        : h(
            'span',
            null,
            'No AI account connected yet — you can pick a model now; people can work once you connect one. ',
            h('button', { type: 'button', class: 'link-btn', onclick: () => (closeMenu(), shell.openProviders()) }, 'Connect an AI account…'),
          ),
    });
  });

  render();
  return btn;
}
