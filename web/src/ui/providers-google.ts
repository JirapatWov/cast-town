// The Google card of Models & providers: its three ways in (Sign in with Google, Paste API key, Sign in with
// Antigravity — unofficial) and the settings CAST keeps for omp in the server's config.json "ompEnv"
// (server/agents/omp-env.ts): the Google Cloud project some accounts need to sign in (GOOGLE_CLOUD_PROJECT). It also
// reads and saves those settings for the API keys of every card (providers-keys.ts: GEMINI_API_KEY here,
// ANTHROPIC_API_KEY and OPENAI_API_KEY on their cards). The browser never gets a key back, only whether one is set
// and where it comes from.
import { type LoginState, type OmpEnvKey, type OmpEnvView, type ServerMsg } from '../../../shared/protocol';
import { h, type Child } from './dom';
import { icon } from './icons';
import { errText, form, type Form, type KeyPaste } from './providers-keys';
import type { Shell } from './shell';
import './css/providers-google.css';

export const GEMINI_CLI = 'google-gemini-cli';
export const ANTIGRAVITY = 'google-antigravity';
const PROJECT_DOCS = 'https://goo.gle/gemini-cli-auth-docs#workspace-gca';
export const ANTIGRAVITY_WARNING =
  'Unofficial: Google may suspend accounts that use Antigravity sign-in from tools other than Google’s own. An AI Studio API key is the safer choice.';

export interface GoogleCardOptions {
  shell: Shell;
  /** Rebuild the providers page (every change here re-renders it). */
  render(): void;
  /** omp's settings arrived: rebuild only if the page would change (default: render). */
  renderData?(): void;
  /** Start an omp sign-in (the page's own flow: panel, steps, result). */
  startLogin(provider: string): void;
  /** Give this field the focus once the page has been rebuilt. */
  focusAfterRender(el: HTMLInputElement): void;
  /** The Paste API key box and row (made with this card's env and save). */
  keys: KeyPaste;
}

export function createGoogleCard(o: GoogleCardOptions) {
  const { store } = o.shell;
  let env: OmpEnvView | null = null;
  let envErr: string | null = null;
  let open = false;
  let projectForm: Form | null = null;
  /** The project field of a failed sign-in, per attempt (a new failure starts with the saved value again). */
  let retry: (Form & { loginId: string }) | null = null;

  const field = (key: OmpEnvKey) => env?.[key] ?? { source: null };

  async function load() {
    try {
      const res = await store.request<{ ompEnv?: OmpEnvView } | undefined>({ t: 'get_omp_env', reqId: '' });
      env = res?.ompEnv ?? null;
      envErr = null;
    } catch (err) {
      envErr = errText(err);
    }
    if (open) (o.renderData ?? o.render)();
  }

  store.subscribe((_s, msg?: ServerMsg) => {
    if (msg?.t === 'omp_env') {
      env = msg.ompEnv;
      if (open) (o.renderData ?? o.render)();
    } else if (msg?.t === 'snapshot' && open) {
      void load(); // reconnected: it may have changed meanwhile
    }
  });

  /** Save settings; the answer is the new view (also pushed to every tab). Returns the server's warning, if any. */
  async function save(patch: Partial<Record<OmpEnvKey, string | null>>): Promise<string | undefined> {
    const res = await store.request<{ ompEnv?: OmpEnvView; warning?: string } | undefined>({ t: 'set_omp_env', reqId: '', patch });
    if (res?.ompEnv) env = res.ompEnv;
    return res?.warning;
  }

  // ───────────── Cloud project ─────────────

  async function submitProject() {
    const f = projectForm;
    if (!f || f.busy) return;
    const value = f.input.value.trim();
    f.busy = true;
    f.error = null;
    o.render();
    try {
      await save({ GOOGLE_CLOUD_PROJECT: value || null });
      projectForm = null;
      o.shell.toast('success', value ? `Google Cloud project set to ${value}.` : 'Google Cloud project removed.');
    } catch (err) {
      f.busy = false;
      f.error = errText(err);
      o.focusAfterRender(f.input);
    }
    o.render();
  }

  function openProjectForm() {
    projectForm = form({ type: 'text', class: 'input input-mono', placeholder: 'my-project-123', 'aria-label': 'Google Cloud project ID' }, () => void submitProject());
    projectForm.input.value = field('GOOGLE_CLOUD_PROJECT').source === 'config' ? (field('GOOGLE_CLOUD_PROJECT').value ?? '') : '';
    o.focusAfterRender(projectForm.input);
    o.render();
  }

  const projectHelp = (): HTMLElement =>
    h(
      'p',
      { class: 'signin-help' },
      'Use a project where the Gemini for Google Cloud API is turned on. Work and school accounts also need a Gemini Code Assist licence. ',
      h('a', { href: PROJECT_DOCS, target: '_blank', rel: 'noopener noreferrer' }, 'How to set this up'),
    );

  const envNote = (value: string | undefined) =>
    h('p', { class: 'g-note' }, 'The CAST server’s environment sets ', h('code', null, 'GOOGLE_CLOUD_PROJECT'), value ? [' (', h('code', null, value), ')'] : null, ', and it wins over this setting. Change it there and restart CAST.');

  /** "Cloud project: my-project · Change" under the Google card's ways in, or its editor. */
  function projectLine(): HTMLElement {
    const p = field('GOOGLE_CLOUD_PROJECT');
    if (projectForm) {
      const f = projectForm;
      f.input.disabled = f.busy;
      return h(
        'div',
        { class: 'g-form', role: 'group', 'aria-label': 'Google Cloud project' },
        h('p', { class: 'field-label' }, 'Google Cloud project ID'),
        projectHelp(),
        h(
          'div',
          { class: 'signin-field' },
          f.input,
          h('button', { type: 'button', class: 'btn btn-primary btn-sm', disabled: f.busy, onclick: () => void submitProject() }, f.busy ? h('span', { class: 'spinner spinner-sm' }) : null, 'Save'),
        ),
        f.error ? h('div', { class: 'signin-result is-err', role: 'alert' }, icon('alert', 16), h('span', null, f.error)) : null,
        h(
          'div',
          { class: 'signin-actions' },
          h('button', { type: 'button', class: 'btn btn-ghost btn-sm', disabled: f.busy, 'data-focus-key': 'google:project', onclick: () => ((projectForm = null), o.render()) }, 'Cancel'),
        ),
      );
    }
    const label = h('span', { class: 'g-line-label' }, 'Cloud project');
    if (p.source === 'env') return h('div', { class: 'g-line' }, label, h('code', null, p.value ?? 'set'), h('span', { class: 'g-line-note' }, 'from the CAST server’s environment'));
    return h(
      'div',
      { class: 'g-line' },
      label,
      p.source === 'config' ? h('code', null, p.value) : h('span', { class: 'g-line-note' }, 'not set — some accounts need one'),
      h('button', { type: 'button', class: 'link-btn', 'data-focus-key': 'google:project', disabled: !env, onclick: openProjectForm }, p.source === 'config' ? 'Change' : 'Set…'),
    );
  }

  // ───────────── a failed Sign in with Google ─────────────

  async function retryWithProject(l: LoginState) {
    const f = retry;
    if (!f || f.busy) return;
    const value = f.input.value.trim();
    if (!value) {
      f.input.focus();
      return;
    }
    f.busy = true;
    f.error = null;
    o.render();
    try {
      await save({ GOOGLE_CLOUD_PROJECT: value });
      retry = null;
      o.startLogin(l.provider); // omp's next sign-in runs with GOOGLE_CLOUD_PROJECT set
    } catch (err) {
      f.busy = false;
      f.error = errText(err);
      o.focusAfterRender(f.input);
      o.render();
    }
  }

  /** The fix for a failed sign-in that needs a Google Cloud project: the ID field (saved for every omp, then the
   *  sign-in runs again). Null when this failure has no such fix. */
  function loginFix(l: LoginState, close: () => void): HTMLElement | null {
    if (l.fix !== 'google-project') return null;
    const p = field('GOOGLE_CLOUD_PROJECT');
    const tryAgain = (primary: boolean) =>
      h('button', { type: 'button', class: ['btn', 'btn-sm', primary ? 'btn-primary' : 'btn-soft'], onclick: () => o.startLogin(l.provider) }, icon('refresh', 14), 'Try again');
    const closeBtn = h('button', { type: 'button', class: 'btn btn-ghost btn-sm', onclick: close }, 'Close');
    if (p.source === 'env') {
      return h('div', { class: 'g-form' }, envNote(p.value), h('div', { class: 'signin-actions' }, tryAgain(true), closeBtn));
    }
    // "Try again" while the field holds the project this attempt ran with, "Save and try again" once it is changed
    const label = (input: HTMLInputElement) => (l.project && input.value.trim() === l.project ? 'Try again' : 'Save and try again');
    if (!retry || retry.loginId !== l.loginId) {
      const f = form({ type: 'text', class: 'input input-mono', placeholder: 'my-project-123', 'aria-label': 'Google Cloud project ID' }, () => void retryWithProject(l));
      f.input.value = l.project ?? p.value ?? '';
      f.input.addEventListener('input', () => {
        const el = f.input.closest('.g-form')?.querySelector('.g-retry-label');
        if (el) el.textContent = label(f.input);
      });
      retry = { ...f, loginId: l.loginId };
      o.focusAfterRender(f.input);
    }
    const f = retry;
    f.input.disabled = f.busy;
    return h(
      'div',
      { class: 'g-form', role: 'group', 'aria-label': 'Google Cloud project' },
      h('p', { class: 'field-label' }, 'Google Cloud project ID'),
      projectHelp(),
      h(
        'div',
        { class: 'signin-field' },
        f.input,
        h(
          'button',
          { type: 'button', class: 'btn btn-primary btn-sm', disabled: f.busy, onclick: () => void retryWithProject(l) },
          f.busy ? h('span', { class: 'spinner spinner-sm' }) : icon('refresh', 14),
          h('span', { class: 'g-retry-label' }, label(f.input)),
        ),
      ),
      f.error ? h('div', { class: 'signin-result is-err', role: 'alert' }, icon('alert', 16), h('span', null, f.error)) : null,
      h('div', { class: 'signin-actions' }, closeBtn),
    );
  }

  /** Said above the steps of a running sign-in (Antigravity: the warning, again where it counts). */
  function loginNote(l: LoginState): HTMLElement | null {
    return l.provider === ANTIGRAVITY ? h('p', { class: 'g-warn', role: 'note' }, icon('alert', 14), h('span', null, ANTIGRAVITY_WARNING)) : null;
  }

  // ───────────── the card ─────────────

  const antigravityButton = () =>
    h(
      'button',
      { type: 'button', class: 'btn btn-ghost btn-sm g-antigravity', 'data-focus-key': `signin:${ANTIGRAVITY}`, onclick: () => o.startLogin(ANTIGRAVITY) },
      'Sign in with Antigravity (unofficial)',
    );
  const warnLine = () => h('p', { class: 'g-warn' }, icon('alert', 14), h('span', null, ANTIGRAVITY_WARNING));

  /** The other ways in, under "Sign in with Google" on a card that isn't connected. */
  function connectOptions(): Child[] {
    const keyBox = o.keys.box('google');
    if (keyBox) return [keyBox, projectLine()];
    return [
      h(
        'div',
        { class: 'g-ways' },
        o.keys.button('google'),
        antigravityButton(),
      ),
      warnLine(),
      envErr ? h('p', { class: 'acct-note is-err' }, `Couldn’t read CAST’s Google settings: ${envErr}`) : null,
      projectLine(),
    ];
  }

  /** On a connected card, below its accounts: the key (add / replace) and Antigravity. */
  function connectedOptions(): Child[] {
    const keyBox = o.keys.box('google');
    if (keyBox) return [h('div', { class: 'g-connected' }, keyBox, projectLine())];
    return [
      h(
        'div',
        { class: 'g-connected' },
        h(
          'div',
          { class: 'g-ways' },
          o.keys.button('google'),
          antigravityButton(),
        ),
        warnLine(),
        projectLine(),
      ),
    ];
  }

  return {
    get env() {
      return env;
    },
    /** The settings were read, or reading them failed (a paste is still worth a try then). */
    get ready() {
      return env !== null || envErr !== null;
    },
    save,
    /** What the card shows from the server (the page skips a rebuild when an answer changes none of it). */
    sig(): string {
      return JSON.stringify([env, envErr]);
    },
    /** The page opened: read the settings (and again on every reopen — another tab may have changed them). */
    open() {
      open = true;
      void load();
    },
    close() {
      open = false;
      projectForm = null;
      retry = null;
    },
    connectOptions,
    connectedOptions,
    loginFix,
    loginNote,
  };
}

export type GoogleCard = ReturnType<typeof createGoogleCard>;
