// Settings → Notifications & app: Web Push for this paired device (who waits for you, team runs ending, people
// stopping with an error), a test notification, and the installed app's own controls (no address bar there: "Reset
// the app's cache" is the way out of a stuck worker). The permission prompt only ever follows a tap here.
import { loadSession } from '../net/session';
import { currentPlatform, installHelp, isStandalone } from '../pwa/install';
import { pushSupport, sendTest, serverPush, setPrefs, turnOff, turnOn, type PushPrefs, type ServerPush } from '../pwa/push';
import { resetAppCache, swRegistration } from '../pwa/register';
import { h, setChildren, type Child } from './dom';
import { icon } from './icons';
import { registerSettingsSection } from './settings';
import type { Shell } from './shell';
import { uid } from './widgets';

const PRIVACY =
  'Notifications go through your browser’s push service (Apple, Google, Mozilla or Microsoft), encrypted end to end. They say who needs you and where — never commands, code or what was asked. CAST must reach the internet to send them.';

const errText = (err: unknown) => (err instanceof Error ? err.message : String(err));

function prefToggle(label: string, hint: string, on: boolean, disabled: boolean, onChange: (on: boolean) => void): HTMLElement {
  const labelId = uid('pl');
  const hintId = uid('ph');
  const box = h('input', { type: 'checkbox', role: 'switch', class: 'set-switch', checked: on, disabled, 'aria-labelledby': labelId, 'aria-describedby': hintId });
  box.addEventListener('change', () => onChange(box.checked));
  return h('label', { class: 'set-row' }, box, h('span', { class: 'set-text' }, h('span', { class: 'set-label', id: labelId }, label), h('span', { class: 'field-hint', id: hintId }, hint)));
}

function unsupportedText(why: string): Child {
  switch (why) {
    case 'city':
      return 'Notifications come from Home, the CAST this device paired with: open Home here to turn them on. Cities added through it don’t send them yet.';
    case 'insecure':
      return 'Notifications need a secure address. Open CAST through your tailscale serve address (https://…ts.net) — or on the computer running it, at 127.0.0.1.';
    case 'ios-tab': {
      const steps = installHelp('ios-safari', false).steps.slice(0, 2);
      return h('span', null, 'On iPhone and iPad, notifications work once CAST is on your Home Screen: ', steps.join(' '), ' Then turn them on here, in the app.');
    }
    case 'no-worker':
      return 'Notifications need the built app (bun run build), not the dev server.';
    default:
      return 'This browser can’t show notifications from CAST.';
  }
}

function appPart(shell: Shell): HTMLElement {
  const reset = h('button', { type: 'button', class: 'btn btn-ghost btn-sm' }, icon('refresh', 14), 'Reset the app’s cache');
  reset.addEventListener('click', async () => {
    reset.setAttribute('disabled', '');
    await resetAppCache();
    shell.toast('success', 'Done — CAST reloads now.');
    setTimeout(() => location.reload(), 600);
  });
  const installed = isStandalone() || installHelp(currentPlatform(), false).done;
  return h(
    'div',
    { class: 'set-push-app' },
    h('h4', { class: 'set-sub' }, 'App'),
    h('p', { class: 'set-push-line' }, installed ? 'CAST is installed on this device ✓' : 'Not installed here — Settings → Pair a phone → Install CAST on this device shows how.'),
    h('div', { class: 'set-actions' }, reset),
    h('p', { class: 'muted small' }, 'Reset removes CAST’s offline helper and its saved code, then reloads. This device stays paired.'),
  );
}

function notifySection(shell: Shell): HTMLElement {
  const body = h('div', { class: 'set-push', 'aria-live': 'polite' }, h('p', { class: 'set-term' }, h('span', { class: 'spinner spinner-sm' }), 'Checking…'));
  const el = h('div', null, body, appPart(shell));

  async function render() {
    const support = pushSupport();
    if (!support.ok) return setChildren(body, h('p', { class: 'set-note' }, unsupportedText(support.why)));
    const session = await loadSession();
    if (session?.pwa?.push === false) return setChildren(body, h('p', { class: 'set-note' }, 'Notifications are off on this server (CAST_PUSH=off).'));
    let server: ServerPush;
    try {
      server = await serverPush();
    } catch (err) {
      return setChildren(body, h('p', { class: 'set-note' }, `Could not ask the server: ${errText(err)}`));
    }
    if (!server.enabled) return setChildren(body, h('p', { class: 'set-note' }, 'Notifications are off on this server (CAST_PUSH=off).'));
    if (server.error) return setChildren(body, h('p', { class: 'set-note' }, server.error));
    const reg = await swRegistration();
    const sub = reg ? await reg.pushManager.getSubscription().catch(() => null) : null;
    const permission = Notification.permission;
    const on = !!(server.subscribed && sub && sub.endpoint === server.endpoint);
    const prefs: PushPrefs = server.prefs ?? { waiting: true, runs: true, errors: false };

    const status =
      permission === 'denied'
        ? h('span', { class: 'chip chip-root' }, 'Blocked')
        : on
          ? h('span', { class: 'chip chip-ok' }, icon('check', 12), 'On for this device')
          : h('span', { class: 'chip' }, 'Off');
    const blockedHelp =
      permission === 'denied'
        ? h('p', { class: 'set-note' }, /iPhone|iPad/.test(navigator.userAgent) ? 'Allow them in iOS Settings → Notifications → CAST, then come back here.' : 'Allow notifications for this site in the browser’s site settings (the icon left of the address), then come back here.')
        : null;

    const main = h('button', { type: 'button', class: ['btn', 'btn-sm', on ? 'btn-soft' : 'btn-primary'], disabled: permission === 'denied' || (!on && (!reg || !server.publicKey)) }, icon('bell', 14), on ? 'Turn off for this device' : 'Turn on notifications for this device');
    main.addEventListener('click', () => {
      if (on) {
        main.setAttribute('disabled', '');
        void turnOff(reg)
          .then(() => shell.toast('success', 'Notifications are off for this device.'))
          .catch((err) => shell.toast('error', `Could not turn them off: ${errText(err)}`))
          .finally(() => void render());
        return;
      }
      // straight from the tap: subscribe() asks for permission, so nothing may wait before it (Safari)
      const started = turnOn(reg!, server.publicKey!, prefs);
      main.setAttribute('disabled', '');
      void started
        .then(() => shell.toast('success', 'Notifications are on for this device. Send a test to see one.'))
        .catch((err) => {
          const denied = Notification.permission === 'denied';
          shell.toast(denied ? 'warn' : 'error', denied ? 'Notifications are blocked for CAST on this device.' : `Could not turn them on: ${errText(err)}`);
        })
        .finally(() => void render());
    });

    const save = (patch: Partial<PushPrefs>) =>
      void setPrefs(patch).catch((err) => {
        shell.toast('error', `Could not save that: ${errText(err)}`);
        void render();
      });
    const prefsList = h(
      'div',
      { class: on ? 'set-push-prefs' : 'set-push-prefs is-off' },
      prefToggle('Waiting for you', 'Someone needs your OK, has a question or a plan.', prefs.waiting, !on, (v) => save({ waiting: v })),
      prefToggle('Team runs finished', 'A team run finished or failed.', prefs.runs, !on, (v) => save({ runs: v })),
      prefToggle('Someone stopped with an error', 'A person in the town stopped because something went wrong.', prefs.errors, !on, (v) => save({ errors: v })),
    );

    const result = h('p', { class: 'set-note', hidden: !server.lastError }, server.lastError ? `The push service last said: ${server.lastError}` : '');
    const test = h('button', { type: 'button', class: 'btn btn-soft btn-sm', disabled: !on }, icon('send', 14), 'Send a test notification');
    test.addEventListener('click', async () => {
      test.setAttribute('disabled', '');
      try {
        const r = await sendTest();
        if (r.ok) {
          result.hidden = true;
          shell.toast('success', 'Sent — it arrives in a few seconds. Lock the phone to see it there.');
        } else {
          result.hidden = false;
          result.textContent = r.error ?? 'The push service refused it.';
        }
      } catch (err) {
        result.hidden = false;
        result.textContent = errText(err);
      } finally {
        test.removeAttribute('disabled');
      }
    });

    setChildren(
      body,
      h('p', { class: 'set-push-line' }, status, ' ', on ? 'This device gets a notification when CAST needs you while it is in the background.' : 'Get a notification on this device when someone needs you, even with CAST closed or the phone locked.'),
      blockedHelp,
      h('div', { class: 'set-actions' }, main, test),
      result,
      prefsList,
      h('p', { class: 'muted small' }, PRIVACY),
    );
  }
  void render();
  return el;
}

registerSettingsSection({ id: 'notifications', title: 'Notifications & app', order: 10, render: (shell) => notifySection(shell) });
