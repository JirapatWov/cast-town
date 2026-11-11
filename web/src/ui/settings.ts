// Settings, one dialog in two parts.
//  - This device: how CAST is shown and driven here — Board or 3D town, single-key shortcuts (with the full list of
//    shortcuts from the registry, shortcuts.ts) and accessibility options. Every choice is per device (deviceStorage).
//  - Access and data: who can get in (paired devices, signing out, a new pairing link), pairing a phone with a one-time
//    QR code, the terminal's state, and deleting everything CAST keeps ("Your data"). Devices and pairing are the
//    hub's (the server this browser paired with — see net/session.ts); the terminal and the data belong to the city
//    on screen.
// Other modules can add their own section with registerSettingsSection().
import './css/trust.css';
import { a11yPref, setA11yPref, type A11yPref } from './a11y-prefs';
import {
  hubSession, listDevices, loadSession, newPairingLink, probeAccess, revokeDevice, revokeOtherDevices, rotatePairingToken, wipeAllData,
  type PairedDevice, type SessionInfo,
} from '../net/session';
import { CITY_ID } from '../net/base';
import { currentCityName, hasManyCities, loadCities } from '../net/cities';
import { h, setChildren, storage, type Child } from './dom';
import { timeAgo } from './format';
import { icon } from './icons';
import { openModal, type ModalHandle } from './modal';
import { pairTargetLine } from './pair-text';
import { qrSvg } from './qr';
import { installBlock, shortCodeBlock } from './settings-install';
import { holdInView } from './settings-link';
import type { Shell } from './shell';
import { SCOPE_LABEL, SHORTCUTS, displayKeys, onSingleKeysChange, setSingleKeys, singleKeysEnabled, type ShortcutScope } from './shortcuts';
import { TERMINAL_OFF_TEXT } from './terminal-gate';
import { setThemePref, themePref, type ThemePref } from './theme';
import { threeD } from './view-mode';
import { wipeComeBackLine, wipeDevicesLine, type TextPart } from './wipe-text';
import { isTouchUI } from './touch';
import { groupField, isMac, segmented, uid } from './widgets';

/** 'notifications': Notifications & app (web/src/ui/settings-notify.ts, a registered section). */
export type SettingsSection = 'view' | 'keyboard' | 'a11y' | 'devices' | 'pair' | 'terminal' | 'data' | 'notifications';

/** A section another module adds (shown after the built-in ones, in `order`). */
export interface ExtraSettingsSection {
  id: string;
  title: string;
  order?: number;
  render(shell: Shell): Child;
}
const extraSections: ExtraSettingsSection[] = [];
export function registerSettingsSection(s: ExtraSettingsSection): void {
  extraSections.push(s);
  extraSections.sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
}

/** Typed to confirm "Delete all CAST data" (server/data-wipe.ts WIPE_CONFIRM_TEXT). */
const WIPE_WORDS = 'delete everything';

const isLoopbackPage = () => ['localhost', '127.0.0.1', '[::1]', '::1'].includes(location.hostname) || location.hostname.startsWith('127.');

let open: ModalHandle | null = null;

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function section(id: SettingsSection | string, title: string, lead: Child, ...body: Child[]): HTMLElement {
  return h('section', { class: 'set-sec', id: `set-${id}`, 'aria-labelledby': `set-${id}-h` }, h('h3', { class: 'set-h', id: `set-${id}-h` }, title), h('p', { class: 'set-lead' }, lead), ...body);
}

// ───────────────────────── this device: view, keyboard, accessibility ─────────────────────────

/** A labelled on/off switch with a line of explanation under it. */
function toggle(label: string, hint: string, on: boolean, onChange: (on: boolean) => void): HTMLElement {
  // named by the label alone, described by the hint (a wrapping <label> would read both as the name)
  const labelId = uid('sl');
  const hintId = uid('sh');
  const box = h('input', { type: 'checkbox', role: 'switch', class: 'set-switch', checked: on, 'aria-labelledby': labelId, 'aria-describedby': hintId });
  box.addEventListener('change', () => onChange(box.checked));
  return h(
    'label',
    { class: 'set-row' },
    box,
    h('span', { class: 'set-text' }, h('span', { class: 'set-label', id: labelId }, label), h('span', { class: 'field-hint', id: hintId }, hint)),
  );
}

function shortcutList(): HTMLElement {
  const on = singleKeysEnabled();
  const scopes = [...new Set(SHORTCUTS.map((s) => s.scope))] as ShortcutScope[];
  return h(
    'div',
    { class: 'set-keys' },
    scopes.map((scope) =>
      h(
        'section',
        { class: 'set-keys-group', 'aria-label': SCOPE_LABEL[scope] },
        h('h4', null, SCOPE_LABEL[scope]),
        h(
          'dl',
          null,
          SHORTCUTS.filter((s) => s.scope === scope).map((s) =>
            h(
              'div',
              { class: ['set-key', s.single && !on && 'is-off'] },
              h('dt', null, h('span', { class: 'kbd-group' }, displayKeys(s.keys, isMac).map((k) => h('kbd', null, k)))),
              h('dd', null, s.label, s.single && !on ? h('span', { class: 'muted' }, ' — off') : null),
            ),
          ),
        ),
      ),
    ),
  );
}

function viewSection(shell: Shell): HTMLElement {
  const view = threeD.state === 'unavailable'
    ? h('p', { class: 'field-hint' }, '3D isn’t available in this browser, so CAST shows the town board — it has everything.')
    : groupField(
        'Town view',
        segmented<'3d' | 'board'>(
          [
            { value: '3d', label: '3D town', icon: 'cube' },
            { value: 'board', label: 'Board', icon: 'board' },
          ],
          shell.focusMode ? 'board' : '3d',
          (v) => shell.setFocusMode(v === 'board'),
          'Town view',
        ),
        'The board lists every house with its people and status: quicker on slow computers, and easiest with a keyboard or screen reader. CAST remembers your choice; with the board, the 3D town loads only when you switch to it.',
      );
  const theme = groupField(
    'Theme',
    segmented<ThemePref>(
      [
        { value: 'system', label: 'System', icon: 'monitor' },
        { value: 'dark', label: 'Dark', icon: 'moon' },
        { value: 'light', label: 'Light', icon: 'sun' },
      ],
      themePref(),
      (v) => setThemePref(v),
      'Theme',
    ),
    'Colours of the panels, menus and dialogs. System follows your device’s light or dark setting. The 3D town keeps its own look.',
  );
  return section('view', 'View', '', view, theme);
}

/** Keyboard: the single-key switch and every shortcut. Returns the section and how to stop following the switch. */
function keyboardSection(): { el: HTMLElement; dispose(): void } {
  const keysSlot = h('div');
  const renderKeys = () => setChildren(keysSlot, shortcutList());
  renderKeys();
  const dispose = onSingleKeysChange(renderKeys);
  const el = section(
    'keyboard',
    'Keyboard',
    '',
    toggle(
      'Single-key shortcuts',
      'Letters, numbers and ` act as shortcuts while you are not typing (W workflow, T changes, 1–9 houses, A / D on a focused approval). Turn this off if you use voice control, dictation or a screen reader.',
      singleKeysEnabled(),
      (on) => setSingleKeys(on),
    ),
    h('details', { class: 'set-details' }, h('summary', null, 'All keyboard shortcuts'), keysSlot),
  );
  return { el, dispose };
}

function a11ySection(): HTMLElement {
  const pref = (p: A11yPref) => (on: boolean) => setA11yPref(p, on);
  return section(
    'a11y',
    'Accessibility',
    '',
    toggle('Screen reader support in the terminal', 'Lets screen readers read the shell’s output. Slower with very long output.', a11yPref('termReader'), pref('termReader')),
    toggle('Solid panels', 'No see-through glass behind text. Also on when your system asks for less transparency or more contrast.', a11yPref('solid'), pref('solid')),
  );
}

// ───────────────────────── devices ─────────────────────────

function devicesSection(shell: Shell): HTMLElement {
  const list = h('ul', { class: 'set-devices', 'aria-live': 'polite' }, h('li', { class: 'set-empty' }, h('span', { class: 'spinner spinner-sm' }), 'Loading devices…'));
  const note = h('p', { class: 'set-note', hidden: true });
  const others = h('button', { type: 'button', class: 'btn btn-soft btn-sm' }, icon('exit', 14), 'Sign out all other devices');
  const rotate = h('button', { type: 'button', class: 'btn btn-ghost btn-sm' }, icon('key', 14), 'New pairing link…');
  let hub: SessionInfo | null = null;

  async function refresh() {
    try {
      const [s, r] = await Promise.all([hub ? Promise.resolve(hub) : hubSession(), listDevices()]);
      hub = s;
      renderList(r.devices, s);
    } catch (err) {
      setChildren(list, h('li', { class: 'set-empty' }, `Could not load the devices: ${errText(err)}`));
    }
  }

  function renderList(devices: PairedDevice[], s: SessionInfo) {
    note.hidden = s.via === 'session';
    if (s.via === 'tailnet') note.textContent = `You’re in through Tailscale as ${s.user ?? 'a listed login'} (CAST_ALLOWED_USERS), so this browser has no pairing to sign out.`;
    else if (s.via === 'token') note.textContent = 'This page uses the pairing token directly, so it is not a paired device.';
    others.disabled = !devices.some((d) => !d.current);
    if (!devices.length) {
      setChildren(list, h('li', { class: 'set-empty' }, 'No paired devices.'));
      return;
    }
    setChildren(list, ...devices.map((raw) => {
      // the Mac menu-bar app is never "this device" (this page is a browser), and is named for what it is
      const app = raw.kind === 'app';
      const d = app ? { ...raw, current: false, name: APP_DEVICE_LABEL } : raw;
      const btn = h('button', { type: 'button', class: ['btn', 'btn-sm', d.current ? 'btn-soft' : 'btn-ghost btn-deny'] }, d.current ? 'Sign out' : 'Remove');
      btn.setAttribute('aria-label', d.current ? 'Sign out this device' : `Remove ${d.name}`);
      btn.addEventListener('click', () => void revoke(d));
      return h(
        'li',
        { class: ['set-device', d.current && 'is-current', app && 'is-app'] },
        h('span', { class: 'set-device-ic', html: app ? MENU_BAR_ICON : deviceIcon(d.name) }),
        h(
          'span',
          { class: 'set-device-text' },
          h('span', { class: 'set-device-name' }, d.name, d.current ? h('span', { class: 'chip chip-ok' }, 'This device') : null, app ? h('span', { class: 'chip' }, 'Menu bar app') : null),
          h('span', { class: 'set-device-meta' }, `${app ? 'Shows CAST’s status in the menu bar · ' : ''}Paired ${timeAgo(d.createdAt)} · last used ${timeAgo(d.lastSeenAt)}`),
        ),
        btn,
      );
    }));
  }

  async function revoke(d: PairedDevice) {
    const ok = await shell.confirm(
      d.current
        ? { title: 'Sign out this device?', body: 'This browser leaves CAST. To come back, pair it again with a pairing link.', confirmLabel: 'Sign out', icon: 'exit' }
        : d.kind === 'app'
          ? { title: `Remove “${d.name}”?`, body: 'The CAST menu-bar app on this Mac signs in again by itself while it runs. To keep it out, quit it from its menu first.', confirmLabel: 'Remove', tone: 'danger', icon: 'trash' }
          : { title: `Remove “${d.name}”?`, body: 'That device is signed out right away; its open pages close. It needs a new pairing link to come back.', confirmLabel: 'Remove device', tone: 'danger', icon: 'trash' },
    );
    if (!ok) return;
    try {
      const r = await revokeDevice(d.id);
      if (r.signedOut) {
        location.reload(); // the server now shows "This device is signed out"
        return;
      }
      shell.toast('success', `${d.name} is signed out.`);
    } catch (err) {
      shell.toast('error', `Could not sign it out: ${errText(err)}`);
    }
    void refresh();
  }

  others.addEventListener('click', async () => {
    const ok = await shell.confirm({ title: 'Sign out all other devices?', body: 'Every other browser and script paired with CAST is signed out right away. This device stays signed in.', confirmLabel: 'Sign out others', tone: 'danger', icon: 'exit' });
    if (!ok) return;
    try {
      const r = await revokeOtherDevices();
      shell.toast('success', r.revoked ? `Signed out ${r.revoked} device${r.revoked === 1 ? '' : 's'}.` : 'No other devices were signed in.');
    } catch (err) {
      shell.toast('error', `Could not sign them out: ${errText(err)}`);
    }
    void refresh();
  });

  rotate.addEventListener('click', async () => {
    const all = h('input', { type: 'checkbox' });
    const body = h(
      'div',
      { class: 'set-rotate' },
      h('p', null, 'CAST makes a new pairing token. Every pairing link made before stops working — use this if a link was shared or a phone was lost.'),
      h('p', null, 'The new link is shown on the computer running CAST: run ', h('code', null, 'bun run pair'), ' in the CAST folder.'),
      h('label', { class: 'set-check' }, all, h('span', null, h('strong', null, 'Also sign out every other device'), h('span', { class: 'muted small' }, ' — they will need the new link'))),
    );
    const ok = await shell.confirm({ title: 'Make a new pairing link?', body, confirmLabel: 'Make a new link', icon: 'key' });
    if (!ok) return;
    try {
      const r = await rotatePairingToken(all.checked);
      shell.toast('success', `New pairing token saved${r.revoked ? `; ${r.revoked} other device${r.revoked === 1 ? '' : 's'} signed out` : ''}. Old links no longer work.`);
    } catch (err) {
      shell.toast('error', `Could not make a new pairing link: ${errText(err)}`);
    }
    void refresh();
  });

  void refresh();
  return section(
    'devices',
    'Devices',
    'Browsers and scripts paired with CAST on this machine. Lost a phone? Remove it here, then make a new pairing link.',
    note,
    list,
    h('div', { class: 'set-actions' }, others, rotate),
  );
}

/** How Settings names the CAST menu-bar app's session (device kind 'app'). */
const APP_DEVICE_LABEL = 'This Mac’s menu bar';
/** A menu bar with a status item. */
const MENU_BAR_ICON = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="4.5" width="18" height="15" rx="2"/><path d="M3 8.5h18M15.5 6.5h3"/></svg>';

/** A small phone/laptop/terminal glyph from a device name. */
function deviceIcon(name: string): string {
  const svg = (body: string) => `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;
  if (/iPhone|Android|Mobile/i.test(name)) return svg('<rect x="7" y="2.5" width="10" height="19" rx="2.2"/><path d="M11 18.5h2"/>');
  if (/iPad|tablet/i.test(name)) return svg('<rect x="4.5" y="3" width="15" height="18" rx="2"/><path d="M11 18h2"/>');
  if (/curl|script|Bun|hub/i.test(name)) return svg('<rect x="3" y="4.5" width="18" height="15" rx="2"/><path d="M7 9.5l3 2.5-3 2.5M12.5 15h4.5"/>');
  return svg('<rect x="3.5" y="4.5" width="17" height="11" rx="1.6"/><path d="M2 19h20"/>');
}

// ───────────────────────── pair a phone ─────────────────────────

function pairSection(shell: Shell): HTMLElement {
  const out = h('div', { class: 'set-pair-out', 'aria-live': 'polite' });
  const show = h('button', { type: 'button', class: 'btn btn-primary btn-sm' }, icon('plus', 14), 'Show a pairing code');
  let timer: ReturnType<typeof setInterval> | null = null;

  async function make() {
    show.disabled = true;
    try {
      const { link, short, expiresAt } = await newPairingLink();
      const left = h('span', { class: 'set-pair-left' });
      const tick = () => {
        const ms = expiresAt - Date.now();
        if (ms <= 0) {
          if (timer) clearInterval(timer);
          timer = null;
          setChildren(out, h('p', { class: 'set-note' }, 'That code expired. Show a new one when the phone is ready.'));
          show.textContent = 'Show a new pairing code';
          return;
        }
        const m = Math.floor(ms / 60_000);
        const s = Math.floor((ms % 60_000) / 1000);
        left.textContent = `Works once, for ${m}:${String(s).padStart(2, '0')} more`;
      };
      const copy = h('button', { type: 'button', class: 'btn btn-soft btn-sm' }, icon('copy', 14), 'Copy link');
      copy.addEventListener('click', async () => {
        try {
          await navigator.clipboard.writeText(link);
          shell.toast('success', 'Pairing link copied — it works once.');
        } catch {
          shell.toast('warn', 'Copy failed — select the link and copy it.');
        }
      });
      setChildren(
        out,
        h('div', { class: 'set-qr', html: qrSvg(link, { label: 'Pairing code: scan with your phone camera' }) }),
        h(
          'div',
          { class: 'set-pair-info' },
          h('p', { class: 'set-warn' }, icon('key', 14), h('span', null, h('strong', null, 'This code is a password.'), ' Anyone who opens it gets into CAST as you. Scan it with your own phone; don’t send it through chat apps (their link previews open it).')),
          h('code', { class: 'set-link', tabindex: '0' }, link),
          h('div', { class: 'set-actions' }, copy, left),
          shortCodeBlock(shell, short),
          isLoopbackPage()
            ? h('p', { class: 'set-note' }, `Your phone can’t open ${location.host} — that address only works on this computer. Open CAST here through an address your phone can reach (for example your tailscale serve address), then show a new code.`)
            : null,
        ),
      );
      tick();
      if (timer) clearInterval(timer);
      timer = setInterval(tick, 1000);
      show.textContent = 'Show a new pairing code';
    } catch (err) {
      setChildren(out, h('p', { class: 'set-note' }, `Could not make a pairing code: ${errText(err)}`));
    } finally {
      show.disabled = false;
    }
  }
  show.addEventListener('click', () => void make());
  // Which CAST the phone joins: always the hub (its code); from a city the link opens that city through it.
  const target = h('p', { class: 'set-note set-pair-target', hidden: true });
  void loadCities().then((v) => {
    const line = v.data ? pairTargetLine(v.data.home.name, CITY_ID ? currentCityName(v) : null, hasManyCities(v)) : CITY_ID ? pairTargetLine(null, currentCityName(v), true) : null;
    target.hidden = !line;
    target.textContent = line ?? '';
  });
  const el = section(
    'pair',
    'Pair a phone',
    'Open CAST on your phone without typing a token: show a one-time code here and scan it with the phone’s camera. The phone must be able to reach this address (same machine network, your tailnet, …).',
    target,
    h('div', { class: 'set-actions' }, show),
    out,
    installBlock(shell),
  );
  // Stop the countdown with the dialog.
  new MutationObserver((_m, obs) => {
    if (!el.isConnected && timer) {
      clearInterval(timer);
      timer = null;
      obs.disconnect();
    }
  }).observe(document.body, { childList: true, subtree: true });
  return el;
}

// ───────────────────────── terminal ─────────────────────────

function terminalSection(): HTMLElement {
  const body = h('p', { class: 'set-term' }, h('span', { class: 'spinner spinner-sm' }), 'Checking…');
  void loadSession().then((s) => {
    const t = s?.terminal;
    if (!t) return setChildren(body, 'On (this server doesn’t say who shells run as).');
    if (!t.enabled) return setChildren(body, h('span', { class: 'chip' }, 'Off'), ' ', TERMINAL_OFF_TEXT);
    setChildren(
      body,
      h('span', { class: ['chip', t.root ? 'chip-root' : 'chip-ok'] }, t.root ? icon('alert', 12) : null, `On · ${t.user}@${t.host}`),
      ' ',
      t.root
        ? 'Shells run as root: anything typed there can change the whole machine. Running CAST as a normal user is safer.'
        : `Shells are real shells on ${t.host} with ${t.user}’s rights.`,
      h('span', { class: 'muted small set-block' }, 'Turn it off with "terminal": false in config.json (or CAST_TERMINAL=0), then restart CAST.'),
    );
  });
  return section('terminal', 'Terminal', 'The terminal at the bottom of the screen runs commands directly on the server machine.', body);
}

// ───────────────────────── your data ─────────────────────────

/** Browser-side leftovers of this city that point at server data the wipe deletes (open terminal tabs, the last folder
 *  picked, the terminal confirmation): cleared with it. Per-device preferences (graphics, look, time of day) stay. */
const CITY_DATA_KEYS = ['rlt.term.tabs', 'rlt.term.active', 'rlt.term.confirmed', 'rlt.place.lastPath', 'rlt.ompWarning.dismissed'];
function clearCityBrowserData() {
  for (const k of CITY_DATA_KEYS) storage.remove(k);
}

const parts = (list: TextPart[]): Child[] => list.map((x) => (typeof x === 'string' ? x : 'em' in x ? h('strong', null, x.em) : h('code', null, x.code)));

async function confirmWipe(shell: Shell, cityName: string): Promise<void> {
  const input = h('input', { class: 'input', type: 'text', autocomplete: 'off', spellcheck: 'false', 'aria-label': `Type ${WIPE_WORDS} to confirm` });
  const go = h('button', { type: 'button', class: 'btn btn-danger', disabled: true }, icon('trash', 15), 'Delete everything');
  const status = h('p', { class: 'set-note', 'aria-live': 'assertive', hidden: true });
  input.addEventListener('input', () => {
    go.disabled = input.value.trim().toLowerCase() !== WIPE_WORDS;
  });
  const modal = openModal(shell.root, shell.layers, {
    id: 'wipe',
    className: 'modal-confirm',
    title: 'Delete all CAST data?',
    body: h(
      'div',
      { class: 'confirm-body set-wipe' },
      h('p', null, `This deletes everything CAST keeps on ${cityName}, for good:`),
      h('ul', null,
        h('li', null, 'every chat and AI session, and the pictures you attached'),
        h('li', null, 'the town (houses, jobs, teams), run history and Undo checkpoints'),
        h('li', null, 'jobs’ own copies of files, and the other cities you added'),
        h('li', null, ...parts(wipeDevicesLine(cityName, !!CITY_ID))),
      ),
      h('p', null, h('strong', null, 'Not deleted:'), ' your project folders and their files, your git branches, and your AI accounts (sign out of those in Models & providers).'),
      h('p', null, ...parts(wipeComeBackLine(cityName, !!CITY_ID))),
      h('label', { class: 'field' }, h('span', { class: 'field-label' }, `Type “${WIPE_WORDS}” to confirm`), input),
      status,
    ),
    footer: [h('button', { type: 'button', class: 'btn btn-ghost', autofocus: true, onclick: () => modal.close() }, 'Cancel'), go],
  });
  go.addEventListener('click', async () => {
    go.disabled = true;
    input.disabled = true;
    status.hidden = false;
    status.textContent = 'Deleting… CAST will restart in a moment.';
    try {
      await wipeAllData(input.value);
    } catch (err) {
      status.textContent = `Could not delete: ${errText(err)}`;
      input.disabled = false;
      go.disabled = false;
      return;
    }
    clearCityBrowserData();
    // Wait for the fresh server, then reload: it shows this device as signed out (the devices list was deleted too).
    const started = Date.now();
    const wait = async () => {
      if (Date.now() - started > 1500 && (await probeAccess()) !== 'unknown') return location.reload();
      if (Date.now() - started > 60_000) {
        status.textContent = 'CAST hasn’t come back yet. Start it again on the computer it runs on, then reload this page.';
        return;
      }
      setTimeout(() => void wait(), 1000);
    };
    void wait();
  });
}

function dataSection(shell: Shell): HTMLElement {
  const btn = h('button', { type: 'button', class: 'btn btn-soft btn-sm btn-deny' }, icon('trash', 14), 'Delete all CAST data…');
  btn.addEventListener('click', () => void loadSession().then((s) => confirmWipe(shell, s?.cityName ?? 'this machine')));
  return section(
    'data',
    'Your data',
    h('span', null, 'CAST keeps your town, chats, AI sessions and attached pictures in its data folder on this machine. Delete one chat from the chat’s history menu, or a house’s chats when you remove the house. Your project folders are never deleted.'),
    h('div', { class: 'set-actions' }, btn),
  );
}

// ───────────────────────── the dialog ─────────────────────────

/** Open Settings, scrolled to `focus` when given (else on the picked town view). */
export function openSettings(shell: Shell, focus?: SettingsSection): void {
  open?.close();
  void loadSession(true);
  const view = viewSection(shell);
  const keyboard = keyboardSection();
  const extras = extraSections.map((s) => ({ id: s.id, el: section(s.id, s.title, '', s.render(shell)) }));
  // A phone in the Board needs notifications and installing the app, not the keyboard: those come right after
  // View and the keyboard goes last. Everything else (and the desktop) keeps its order.
  const phoneBoard = shell.focusMode && isTouchUI();
  const lead = phoneBoard ? extras.filter((s) => s.id === 'notifications') : [];
  const body = h(
    'div',
    { class: 'set-body' },
    // this device first, then the machine's: who can get in, the terminal, the data
    view,
    ...lead.map((s) => s.el),
    ...(phoneBoard ? [] : [keyboard.el]),
    a11ySection(),
    devicesSection(shell),
    pairSection(shell),
    terminalSection(),
    dataSection(shell),
    ...extras.filter((s) => !lead.includes(s)).map((s) => s.el),
    ...(phoneBoard ? [keyboard.el] : []),
  );
  // the dialog opens on its first control (the picked view), not on the first text-like input further down
  if (!focus) view.querySelector('[role="radio"][aria-checked="true"]')?.setAttribute('autofocus', '');
  let release: (() => void) | null = null;
  open = openModal(shell.root, shell.layers, {
    id: 'settings',
    className: 'modal-settings',
    title: 'Settings',
    subtitle: 'This device’s view, keys and accessibility; devices, pairing and your data',
    body,
    footer: h('button', { type: 'button', class: 'btn btn-primary', onclick: () => open?.close() }, 'Done'),
    onClose: () => {
      keyboard.dispose();
      release?.();
      open = null;
    },
  });
  if (focus) {
    requestAnimationFrame(() => {
      const el = body.querySelector<HTMLElement>(`#set-${focus}`);
      el?.scrollIntoView({ block: 'start' });
      el?.querySelector<HTMLElement>('[role="radio"][aria-checked="true"], input:not(:disabled), button:not(:disabled), summary')?.focus({ preventScroll: true });
      // the devices list above fills in a moment later: Pair a phone (or whatever was asked for) stays in view
      if (el && open) release = holdInView(el, body);
    });
  }
}

/** Settings' gear, for the top bar. */
export function settingsIcon(size = 16): HTMLElement {
  return h('span', {
    class: 'set-gear',
    'aria-hidden': 'true',
    html: `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>`,
  });
}
