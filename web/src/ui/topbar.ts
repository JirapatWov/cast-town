// Top bar: three floating glass islands — location (left), live run relay (center), status + controls (right).
import { APP_NAME, markSvg } from '../../../shared/brand';
import { OMP_TESTED_VERSION, ompVersionWarning } from '../../../shared/omp-version';
import { agentsState } from './agents-health';
import type { Vendor } from '../../../shared/protocol';
import type { Quality } from '../core/types';
import { createCitySwitcher } from './cities';
import { h, memo, setChildren } from './dom';
import { VENDOR_LABEL, fmtUsd, vendorColor } from './format';
import { icon } from './icons';
import { openMenu } from './menu';
import { createMoreButton } from './more-menu';
import { playerMenuSection } from './player-menu';
import { QUALITY_LABEL, qualityMenuSection } from './quality-menu';
import { timeOfDayMenuSection } from './time-menu';
import { openPopover } from './popover';
import { createRunStrip } from './runstrip';
import { helpButton } from './help';
import { settingsIcon } from './settings';
import { sessionSpend, spendBarParts, spendRows } from './spend';
import { onInboxSeen, unseenInboxErrors } from './inbox-tab';
import type { Shell } from './shell';
import { modKey } from './widgets';
import { waitingCount } from './plans';
import { shownProvidersStatus } from './model-state';
import { singleKeysEnabled } from './shortcuts';
import { TOWN_FILES_SHARE, threeD } from './view-mode';
import { inboxScope } from './last-house';

/** The session's real spend per vendor (spend.ts): it never drops when a run's people or the helpers leave. */
function costByVendor(shell: Shell): { vendor: Vendor; usd: number }[] {
  return spendRows(sessionSpend(shell.store.state));
}

export function createTopBar(shell: Shell) {
  const { store, bus } = shell;
  const runStrip = createRunStrip(shell);

  // ── left: brand + breadcrumb ──
  const crumbs = h('nav', { class: 'crumbs', 'aria-label': 'Location' });
  const brand = h(
    'button',
    { type: 'button', class: 'brand', 'aria-label': `${APP_NAME} — back to the city`, title: `${APP_NAME} — back to the city`, onclick: () => bus.emit('nav:city', {}) },
    h('span', { class: 'brand-mark', html: markSvg({ size: 18 }) }),
  );
  // #city-switcher: which machine's town this is (contract C4), before the breadcrumb
  const citySwitcher = createCitySwitcher(shell);
  const left = h('div', { class: 'tb-island tb-left glass' }, brand, citySwitcher.el, crumbs);

  // ── right: needs-you, cost, providers, quality, focus, palette, connection ──
  const bell = h('button', { type: 'button', class: 'tb-btn tb-bell', onclick: () => shell.openPanel('inbox', inboxScope(shell.view)) });
  const cost = h('button', { type: 'button', class: 'tb-btn tb-cost', 'aria-haspopup': 'dialog' });
  const providers = h('button', { type: 'button', class: 'tb-btn tb-providers', onclick: () => shell.openProviders() });
  const quality = h('button', { type: 'button', class: 'tb-btn tb-quality', 'aria-haspopup': 'menu' });
  // Board / 3D town: a visible, labelled choice (it used to be an unlabeled "focus mode" icon). Buttons are made once
  // and updated in place, so the focused one keeps its focus; arrows move between them (radios.ts).
  const viewBtn = (id: 'board' | '3d', iconName: string, label: string) =>
    h('button', { type: 'button', role: 'radio', class: 'tb-view-opt', 'data-view': id, onclick: () => shell.setFocusMode(id === 'board') }, icon(iconName, 15), h('span', { class: 'tb-view-label' }, label));
  const view3d = viewBtn('3d', 'cube', '3D');
  const viewBoard = viewBtn('board', 'board', 'Board');
  const focus = h('div', { class: 'tb-view tb-focus', role: 'radiogroup', 'aria-label': 'Town view' }, view3d, viewBoard);
  const palette = h(
    'button',
    { type: 'button', class: 'tb-btn tb-palette', 'aria-label': 'Open command palette', title: `Search and commands (${modKey}+K)`, onclick: () => shell.openPalette() },
    icon('search', 15),
    h('span', { class: 'kbd-group' }, h('kbd', null, modKey), h('kbd', null, 'K')),
  );
  // one Settings for both: this device's view, keys and accessibility (g6), and devices, pairing and data (g1)
  const settings = h(
    'button',
    { type: 'button', class: 'tb-btn tb-icon tb-settings', 'aria-label': 'Settings', title: 'Settings — view, keyboard, accessibility, devices and your data', onclick: () => shell.openSettings() },
    settingsIcon(17),
  );
  const conn = h('span', { class: 'tb-conn', role: 'status' });
  // phones / touch screens: quality, the town view and palette live in the More menu (mobile.css shows one or the other).
  // With large text a phone's top bar also drops the spend pill and, at the very largest, the inbox button (a11y.css):
  // the menu then offers them too.
  const shown = (el: HTMLElement) => getComputedStyle(el).display !== 'none';
  const more = createMoreButton(shell, () => [
    !shown(bell) && /\bis-alert\b|\bhas-errors\b/.test(bell.className)
      ? { label: bell.getAttribute('aria-label')?.replace(/ — open inbox$/, '') ?? 'Inbox', icon: 'inbox', onSelect: () => shell.openPanel('inbox', inboxScope(shell.view)) }
      : null,
    !shown(cost) ? { label: 'Spend', hint: cost.querySelector('.tb-cost-total')?.textContent || undefined, icon: 'coins', onSelect: () => openSpend(more) } : null,
  ]);
  const right = h('div', { class: 'tb-island tb-right glass' }, bell, cost, providers, h('span', { class: 'tb-sep' }), focus, quality, settings, palette, helpButton(shell), more, conn);

  quality.addEventListener('click', () => {
    openMenu(
      shell.root,
      shell.layers,
      quality,
      [
        qualityMenuSection(shell),
        ...[timeOfDayMenuSection(shell), playerMenuSection(shell, quality)].filter((s) => s !== null),
        { items: [{ label: 'Settings…', icon: 'gear', hint: 'View, keyboard, accessibility', onSelect: () => shell.openSettings() }] },
      ],
      { id: 'quality-menu', align: 'end', minWidth: 250 },
    );
  });

  cost.addEventListener('click', () => openSpend(cost));
  function openSpend(anchor: HTMLElement) {
    const rows = costByVendor(shell);
    const total = rows.reduce((t, r) => t + r.usd, 0);
    const body = h(
      'div',
      { class: 'cost-pop glass-strong', role: 'dialog', 'aria-label': 'Spend by vendor' },
      h('div', { class: 'cost-pop-head' }, h('span', null, 'Spend this session'), h('strong', { class: 'num' }, fmtUsd(total))),
      rows.length
        ? h(
            'div',
            { class: 'cost-rows' },
            rows.map((r) =>
              h(
                'div',
                { class: 'cost-row' },
                h('span', { class: 'vendor-dot', style: { background: vendorColor(r.vendor) } }),
                h('span', { class: 'cost-vendor' }, VENDOR_LABEL[r.vendor]),
                h('span', { class: 'cost-bar' }, h('span', { style: { width: `${total ? (r.usd / total) * 100 : 0}%`, background: vendorColor(r.vendor) } })),
                h('span', { class: 'num' }, fmtUsd(r.usd)),
              ),
            ),
          )
        : h('p', { class: 'muted small' }, 'Nothing spent yet. Costs appear here as people work.'),
      h('p', { class: 'muted small cost-since' }, 'Since the CAST server started — finished team runs and helpers included.'),
    );
    openPopover(shell.root, shell.layers, anchor, body, { id: 'cost-pop', align: 'end' });
  }

  const crumbsChanged = memo();
  const rightChanged = memo();

  function renderCrumbs() {
    const { view, projectId } = shell.view;
    const project = store.project(projectId);
    if (!crumbsChanged([view, projectId, project?.name])) return;
    const parts: HTMLElement[] = [
      h('button', { type: 'button', class: ['crumb', view === 'city' && 'is-current'], 'aria-current': view === 'city' ? 'page' : undefined, onclick: () => bus.emit('nav:city', {}) }, 'City'),
    ];
    if (view === 'house' && project) {
      parts.push(
        h('span', { class: 'crumb-sep', 'aria-hidden': 'true' }, icon('chevronRight', 13)),
        h('button', { type: 'button', class: 'crumb is-current', 'aria-current': 'page', title: project.path, onclick: () => shell.openPanel('chat', project.id) }, h('span', { class: 'crumb-text' }, project.name)),
      );
    } else if (view === 'drive') {
      parts.push(h('span', { class: 'crumb-sep', 'aria-hidden': 'true' }, icon('chevronRight', 13)), h('span', { class: 'crumb is-current' }, icon('car', 14), 'Driving'));
    }
    setChildren(crumbs, ...parts);
  }

  function renderRight() {
    const s = store.state;
    const approvals = waitingCount(s); // tool approvals + plan cards
    const errors = unseenInboxErrors(shell); // errors in the Inbox's Recent not seen on this device yet
    const sig = [approvals, errors, costByVendor(shell), s.providers, s.models.filter((m) => m.available).length, s.hello?.ompVersion, s.hello?.agents, shell.quality, shell.focusMode, s.connected, threeD.state, Math.round(threeD.progress * 100), threeD.working, singleKeysEnabled()];
    if (!rightChanged(sig)) return;
    bell.className = ['tb-btn', 'tb-bell', approvals > 0 && 'is-alert', errors > 0 && 'has-errors'].filter(Boolean).join(' ');
    const errText = errors ? `${errors} new error${errors === 1 ? '' : 's'}` : '';
    bell.setAttribute('aria-label', approvals ? `${approvals} waiting for you${errText ? `, ${errText}` : ''} — open inbox` : errText ? `Inbox — ${errText}` : 'Inbox');
    bell.title = approvals ? `${approvals} waiting for you${errText ? ` · ${errText}` : ''}` : errText ? `Inbox — ${errText}` : 'Inbox';
    setChildren(bell,
      icon(approvals ? 'hand' : 'inbox', 16),
      approvals ? h('span', { class: 'num' }, String(approvals)) : null,
      errors ? h('span', { class: 'tb-bell-dot', 'aria-hidden': 'true' }) : null,
    );

    const rows = costByVendor(shell);
    const total = rows.reduce((t, r) => t + r.usd, 0);
    const bar = spendBarParts(rows, total); // empty beside $0.00
    cost.setAttribute('aria-label', `Spend ${fmtUsd(total)} — show breakdown`);
    cost.title = `Spent this session: ${fmtUsd(total)}`;
    setChildren(cost,
      h('span', { class: 'num tb-cost-total' }, fmtUsd(total)),
      h(
        'span',
        { class: 'tb-cost-bar', 'aria-hidden': 'true' },
        bar.length ? bar.map((p) => h('span', { style: { flex: String(p.flex), background: vendorColor(p.vendor) } })) : h('span', { class: 'is-empty' }),
      ),
    );

    // Never a green "0 live": omp missing, the first check running and a failed check each say so (agents-health.ts);
    // otherwise green only when a provider really works — with none connected it is an amber "Connect AI" (phones keep
    // it too: nobody can work until then). Before the first snapshot the accounts aren't known: a neutral "Loading…".
    const health = agentsState(s.hello);
    const { tone, label: word, aria } = shownProvidersStatus(health.kind, s);
    providers.className = ['tb-btn', 'tb-providers', `is-${tone}`].join(' ');
    providers.title = tone === 'none' ? 'No AI account connected yet — connect one so people can work' : 'Models & providers';
    setChildren(providers, h('span', { class: 'prov-dot', 'aria-hidden': 'true' }), h('span', { class: 'tb-btn-label' }, word));
    providers.setAttribute('aria-label', aria);

    setChildren(quality, icon('gauge', 16), h('span', { class: 'tb-quality-label' }, QUALITY_LABEL[shell.quality]));
    quality.setAttribute('aria-label', `Graphics quality: ${QUALITY_LABEL[shell.quality]}`);
    // 3D settings only mean something once there is a 3D town; without WebGL there is no choice to make
    quality.hidden = threeD.state !== 'ready';
    focus.hidden = threeD.state === 'unavailable';
    const key = singleKeysEnabled() ? ' (`)' : '';
    const loading = threeD.state === 'loading';
    const pct = Math.round(threeD.progress * 100);
    for (const [btn, on] of [[view3d, !shell.focusMode], [viewBoard, shell.focusMode]] as const) {
      btn.setAttribute('aria-checked', String(on));
      btn.tabIndex = on ? 0 : -1;
      btn.classList.toggle('is-on', on);
    }
    // nothing measurable moving (building the town, getting its graphics ready): the number pulses and the label
    // says so, rather than a percentage that looks stuck (#67)
    const working = loading && threeD.working;
    const doing = working ? (threeD.progress >= TOWN_FILES_SHARE ? 'getting the graphics ready' : 'still working') : '';
    view3d.classList.toggle('is-loading', loading);
    view3d.classList.toggle('is-working', working);
    view3d.setAttribute('aria-label', loading ? `3D town — loading, ${pct}%${doing ? `, ${doing}` : ''}` : '3D town');
    view3d.title = loading ? `Loading the 3D town… ${pct}%${doing ? ` — ${doing}` : ''}` : `3D town${key}`;
    viewBoard.setAttribute('aria-label', 'Board — every house as a list');
    viewBoard.title = `Board: every house as a list${key}`;
    setChildren(view3d.querySelector('.tb-view-label')!, loading ? `${pct}%` : '3D');

    const hello = s.hello;
    conn.className = ['tb-conn', s.connected ? 'is-up' : 'is-down'].join(' ');
    const tested = hello?.ompTested || OMP_TESTED_VERSION; // a server from before the pin sends none
    const untested = hello && ompVersionWarning(hello.ompVersion, tested) ? ` (not the tested ${tested})` : '';
    const ompPart = hello?.ompVersion ? ` · cast-agent ${hello.ompVersion}${untested}` : health.kind === 'omp-missing' ? ' · cast-agent not built' : '';
    const label = s.connected ? `Connected${ompPart}` : `Reconnecting to the ${APP_NAME} server…`;
    conn.title = label;
    conn.setAttribute('aria-label', label);
  }

  function render() {
    renderCrumbs();
    renderRight();
    runStrip.render();
  }

  onInboxSeen(() => renderRight());
  const el = h('header', { class: 'topbar' }, left, runStrip.el, right);
  return { el, render };
}
