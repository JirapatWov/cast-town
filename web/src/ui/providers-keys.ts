// Paste API key on the Anthropic, OpenAI and Google cards of Models & providers. omp has no key sign-in for these: it
// reads ANTHROPIC_API_KEY, OPENAI_API_KEY or GEMINI_API_KEY from its environment. So CAST checks a pasted key with its
// vendor once, keeps it in the server's config.json "ompEnv" (server/agents/omp-env.ts) and gives it to every omp it
// starts; the models follow without a restart. The browser never gets the key back, only whether one is set and
// where it comes from (OmpEnvView, read and saved by the Google card's settings: providers-google.ts).
import type { ApiKeyName, OmpEnvKey, OmpEnvView, Vendor } from '../../../shared/protocol';
import { confirmDialog } from './confirm';
import { h } from './dom';
import { icon } from './icons';
import type { Shell } from './shell';

export type KeyVendor = 'anthropic' | 'openai' | 'google';

interface KeySpec {
  name: ApiKeyName;
  label: string;
  maker: string;
  placeholder: string;
  page: string;
  pageName: string;
  /** Said when the key is about to be removed. */
  gone: string;
  /** Said under the paste box, after how the key is kept. */
  extra?: string;
}

const SPECS: Record<KeyVendor, KeySpec> = {
  anthropic: {
    name: 'ANTHROPIC_API_KEY',
    label: 'Anthropic API key',
    maker: 'Anthropic',
    placeholder: 'sk-ant-…',
    page: 'https://console.anthropic.com/settings/keys',
    pageName: 'the Claude Console',
    gone: 'Claude models that run on this key can’t be used until you add a key or sign in with Claude.',
    extra: 'If you also sign in with Claude, the agent uses the sign-in first.',
  },
  openai: {
    name: 'OPENAI_API_KEY',
    label: 'OpenAI API key',
    maker: 'OpenAI',
    placeholder: 'sk-…',
    page: 'https://platform.openai.com/api-keys',
    pageName: 'the OpenAI dashboard',
    gone: 'OpenAI models that run on this key can’t be used until you add a key. A ChatGPT sign-in keeps its own models.',
  },
  google: {
    name: 'GEMINI_API_KEY',
    label: 'Gemini API key',
    maker: 'Google',
    placeholder: 'AIza…',
    page: 'https://aistudio.google.com/apikey',
    pageName: 'Google AI Studio',
    gone: 'Gemini models that run on this key can’t be used until you add a key or sign in with Google.',
  },
};

export const hasKeyPaste = (v: Vendor | undefined): v is KeyVendor => !!v && Object.hasOwn(SPECS, v);

/** A small inline form whose input survives re-renders (the page is rebuilt on every models/login/usage update). */
export interface Form {
  input: HTMLInputElement;
  busy: boolean;
  error: string | null;
}

export function form(attrs: Record<string, unknown>, submit: () => void): Form {
  const input = h('input', {
    class: 'input',
    autocomplete: 'off',
    spellcheck: 'false',
    ...attrs,
    onkeydown: (e: KeyboardEvent) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        submit();
      }
    },
  });
  return { input, busy: false, error: null };
}

export const errText = (err: unknown) => (err instanceof Error ? err.message : String(err));

export interface KeyPasteOptions {
  shell: Shell;
  /** Rebuild the providers page. */
  render(): void;
  /** Give this field the focus once the page has been rebuilt. */
  focusAfterRender(el: HTMLInputElement): void;
  /** omp's settings as last read (null: not yet). */
  env(): OmpEnvView | null;
  /** The settings were read, or reading them failed (then a paste is still worth a try). */
  ready(): boolean;
  /** Save settings; the answer's warning, if any. */
  save(patch: Partial<Record<OmpEnvKey, string | null>>): Promise<string | undefined>;
}

export interface KeyPaste {
  /** The paste box while it is open, else null. */
  box(v: KeyVendor): HTMLElement | null;
  /** "Paste API key" (or "Replace API key…"); none while the server's own environment sets the key. */
  button(v: KeyVendor): HTMLElement | null;
  /** The key as one of the card's accounts (from config.json, or the server's environment). */
  row(v: KeyVendor): HTMLElement | null;
  /** The page closed: open boxes go. */
  close(): void;
}

export function createKeyPaste(o: KeyPasteOptions): KeyPaste {
  const forms = new Map<KeyVendor, Form>();
  const field = (v: KeyVendor) => o.env()?.[SPECS[v].name] ?? { source: null };

  async function submit(v: KeyVendor) {
    const f = forms.get(v);
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
      const warning = await o.save({ [SPECS[v].name]: value });
      forms.delete(v);
      // the server's toast says how many models it unlocked once omp has looked
      o.shell.toast(warning ? 'warn' : 'info', warning ?? `Key accepted — checking which ${SPECS[v].maker} models it unlocks…`);
    } catch (err) {
      f.busy = false;
      f.error = errText(err);
      o.focusAfterRender(f.input);
    }
    o.render();
  }

  function open(v: KeyVendor) {
    const f = form({ type: 'password', placeholder: SPECS[v].placeholder, 'aria-label': SPECS[v].label }, () => void submit(v));
    forms.set(v, f);
    o.focusAfterRender(f.input);
    o.render();
  }

  async function remove(v: KeyVendor) {
    const s = SPECS[v];
    const ok = await confirmDialog(o.shell.root, o.shell.layers, { title: `Remove the ${s.label}?`, body: s.gone, confirmLabel: 'Remove key', tone: 'danger', icon: 'trash' });
    if (!ok) return;
    try {
      await o.save({ [s.name]: null });
      o.shell.toast('success', `${s.label} removed.`);
    } catch (err) {
      o.shell.toast('error', `Couldn’t remove the key: ${errText(err)}`);
    }
    o.render();
  }

  /** The paste box while it is open, else null. */
  function box(v: KeyVendor): HTMLElement | null {
    const f = forms.get(v);
    if (!f) return null;
    const s = SPECS[v];
    f.input.disabled = f.busy;
    return h(
      'div',
      { class: 'g-form', role: 'group', 'aria-label': `Paste the ${s.label}` },
      h('p', { class: 'field-label' }, s.label),
      h(
        'p',
        { class: 'signin-help' },
        'Create a key in ',
        h('a', { href: s.page, target: '_blank', rel: 'noopener noreferrer' }, s.pageName),
        ` and paste it here. CAST checks it with ${s.maker} once, then keeps it in its settings file on this server (readable only by the CAST server’s user) and gives it to the agent. It is never shown again.`,
        s.extra ? ` ${s.extra}` : null,
      ),
      h(
        'div',
        { class: 'signin-field' },
        f.input,
        h(
          'button',
          { type: 'button', class: 'btn btn-primary btn-sm', disabled: f.busy, onclick: () => void submit(v) },
          f.busy ? h('span', { class: 'spinner spinner-sm' }) : null,
          f.busy ? 'Checking…' : 'Save key',
        ),
      ),
      f.error ? h('div', { class: 'signin-result is-err', role: 'alert' }, icon('alert', 16), h('span', null, f.error)) : null,
      h(
        'div',
        { class: 'signin-actions' },
        h('button', { type: 'button', class: 'btn btn-ghost btn-sm', disabled: f.busy, 'data-focus-key': `key:${v}`, onclick: () => (forms.delete(v), o.render()) }, 'Cancel'),
      ),
    );
  }

  /** "Paste API key" (or "Replace API key…"); none while the server's own environment sets the key. */
  function button(v: KeyVendor): HTMLElement | null {
    const source = field(v).source;
    if (source === 'env') return null;
    return h(
      'button',
      { type: 'button', class: 'btn btn-soft btn-sm', 'data-focus-key': `key:${v}`, disabled: !o.ready(), onclick: () => open(v) },
      icon('key', 14),
      source === 'config' ? 'Replace API key…' : 'Paste API key',
    );
  }

  /** The key as one of the card's accounts (from config.json, or the server's environment). */
  function row(v: KeyVendor): HTMLElement | null {
    const key = field(v);
    if (!key.source) return null;
    const s = SPECS[v];
    return h(
      'li',
      { class: 'acct' },
      h(
        'div',
        { class: 'acct-top' },
        h('span', { class: 'acct-name' }, s.label),
        h('span', { class: 'acct-plan' }, key.source === 'config' ? 'saved in CAST' : 'server environment'),
        key.source === 'config' ? h('button', { type: 'button', class: 'link-btn acct-out', onclick: () => void remove(v) }, 'Remove') : null,
      ),
      h(
        'p',
        { class: 'acct-note' },
        key.source === 'config'
          ? key.shadowed
            ? 'The server’s environment sets a key too, and that one is used.'
            : 'API key — no usage limits reported'
          : 'Set where the CAST server starts — remove it there and restart CAST.',
      ),
    );
  }

  return {
    box,
    button,
    row,
    close() {
      forms.clear();
    },
  };
}
