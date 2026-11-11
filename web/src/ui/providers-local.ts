// The "Model servers on your network" card of Models & providers: llama.cpp, Ollama, LM Studio or any OpenAI-compatible
// server on another machine (a LAN or tailnet address). The server keeps them in the agent's models.yml
// (server/agents/local-models.ts): Test connection asks the server for its models, Save writes it and the models are
// checked again, so they show up in the pickers (and on a card of their own) without a restart. A key typed here
// never comes back to the browser, only whether one is saved.
import { LOCAL_SERVER_KINDS, type LocalServer, type LocalServerKind, type ServerMsg } from '../../../shared/protocol';
import { confirmDialog } from './confirm';
import { h } from './dom';
import { vendorColor } from './format';
import { icon } from './icons';
import { errText } from './providers-keys';
import type { Shell } from './shell';
import './css/providers-local.css';

const KIND_LABEL: Record<LocalServerKind, string> = {
  'llama.cpp': 'llama.cpp',
  ollama: 'Ollama',
  'lm-studio': 'LM Studio',
  'openai-models-list': 'Other (OpenAI-compatible)',
};
const KIND_PORT: Record<LocalServerKind, number> = { 'llama.cpp': 8080, ollama: 11434, 'lm-studio': 1234, 'openai-models-list': 8000 };

export interface LocalCardOptions {
  shell: Shell;
  /** Rebuild the providers page. */
  render(): void;
  /** The list arrived: rebuild only if the page would change. */
  renderData(): void;
  /** Give this field the focus once the page has been rebuilt. */
  focusAfterRender(el: HTMLInputElement): void;
}

export interface LocalCard {
  /** The card, for the page's grid. */
  el(): HTMLElement;
  /** What the card shows from the server (the page skips a rebuild when it is unchanged). */
  sig(): string;
  /** The page opened: read the list. */
  open(): void;
  close(): void;
  /** This provider is one of the saved model servers. */
  owns(provider: string): boolean;
}

type TestResult = { ok: true; models: string[] } | { ok: false; error: string };

/** The add / edit form. Its fields survive re-renders (typed text and focus are kept). */
interface Editor {
  editing: LocalServer | null;
  name: HTMLInputElement;
  kind: HTMLSelectElement;
  address: HTMLInputElement;
  key: HTMLInputElement;
  /** Editing a server with a saved key: save it without one. */
  dropKey: boolean;
  busy: 'test' | 'save' | null;
  test: TestResult | null;
  error: string | null;
}

export function createLocalCard(o: LocalCardOptions): LocalCard {
  const { store } = o.shell;
  let servers: LocalServer[] | null = null;
  let file = '';
  let loadErr: string | null = null;
  let open = false;
  let editor: Editor | null = null;
  const removing = new Set<string>();

  async function load() {
    try {
      const res = await store.request<{ servers?: LocalServer[]; file?: string } | undefined>({ t: 'list_local_servers', reqId: '' });
      servers = res?.servers ?? [];
      file = res?.file ?? '';
      loadErr = null;
    } catch (err) {
      loadErr = errText(err);
    }
    if (open) o.renderData();
  }

  store.subscribe((_s, msg?: ServerMsg) => {
    if (msg?.t === 'local_servers') {
      servers = msg.servers;
      if (open) o.renderData();
    } else if (msg?.t === 'snapshot' && open) {
      void load(); // reconnected: it may have changed meanwhile
    }
  });

  const input = (attrs: Record<string, unknown>) =>
    h('input', {
      class: 'input',
      autocomplete: 'off',
      spellcheck: 'false',
      ...attrs,
      onkeydown: (e: KeyboardEvent) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          void save();
        }
      },
    });

  function openEditor(s: LocalServer | null) {
    const kind = h(
      'select',
      { class: 'input', 'aria-label': 'Kind of server' },
      LOCAL_SERVER_KINDS.map((k) => h('option', { value: k, selected: k === (s?.kind ?? 'llama.cpp') }, KIND_LABEL[k])),
    );
    const address = input({ type: 'text', class: 'input input-mono', inputmode: 'url', 'aria-label': 'Address', value: s?.baseUrl ?? '' });
    const placeholder = () => (address.placeholder = `http://192.168.1.20:${KIND_PORT[kind.value as LocalServerKind]}`);
    placeholder();
    kind.addEventListener('change', () => {
      placeholder();
      if (editor) editor.test = null;
      o.render();
    });
    const ed: Editor = {
      editing: s,
      name: input({ type: 'text', class: 'input input-mono', placeholder: 'desk-llama', 'aria-label': 'Name', value: s?.name ?? '', disabled: !!s }),
      kind,
      address,
      key: input({ type: 'password', 'aria-label': 'API key (optional)', placeholder: s?.hasKey ? 'Saved — type a new one to replace it' : 'Only if the server asks for one' }),
      dropKey: false,
      busy: null,
      test: null,
      error: null,
    };
    editor = ed;
    o.focusAfterRender(s ? ed.address : ed.name);
    o.render();
  }

  const kindOf = (ed: Editor) => ed.kind.value as LocalServerKind;

  async function test() {
    const ed = editor;
    if (!ed || ed.busy) return;
    if (!ed.address.value.trim()) {
      ed.address.focus();
      return;
    }
    ed.busy = 'test';
    ed.test = null;
    ed.error = null;
    o.render();
    const key = ed.dropKey ? '' : ed.key.value.trim();
    try {
      const res = await store.request<{ models?: string[] } | undefined>({
        t: 'test_local_server',
        reqId: '',
        kind: kindOf(ed),
        baseUrl: ed.address.value.trim(),
        ...(key ? { apiKey: key } : {}),
        ...(ed.editing && !ed.dropKey ? { name: ed.editing.name } : {}),
      });
      ed.test = { ok: true, models: res?.models ?? [] };
    } catch (err) {
      ed.test = { ok: false, error: errText(err) };
    }
    ed.busy = null;
    o.render();
  }

  async function save() {
    const ed = editor;
    if (!ed || ed.busy) return;
    const empty = [ed.name, ed.address].find((el) => !el.value.trim());
    if (empty) {
      empty.focus();
      return;
    }
    ed.busy = 'save';
    ed.error = null;
    o.render();
    const key = ed.key.value.trim();
    try {
      const res = await store.request<{ servers?: LocalServer[] } | undefined>({
        t: 'save_local_server',
        reqId: '',
        name: ed.name.value.trim(),
        kind: kindOf(ed),
        baseUrl: ed.address.value.trim(),
        ...(key ? { apiKey: key } : ed.dropKey ? { apiKey: null } : {}),
      });
      if (res?.servers) servers = res.servers;
      editor = null;
      // the server's toast says how many models it found once the agent has looked
      o.shell.toast('info', 'Saved — checking which models it has…');
    } catch (err) {
      ed.busy = null;
      ed.error = errText(err);
    }
    o.render();
  }

  async function remove(s: LocalServer) {
    const ok = await confirmDialog(o.shell.root, o.shell.layers, {
      title: `Remove ${s.name}?`,
      body: 'Its models can’t be used any more. People set to one of them stop until you pick another model. The server itself is not touched.',
      confirmLabel: 'Remove',
      tone: 'danger',
      icon: 'trash',
    });
    if (!ok) return;
    removing.add(s.name);
    o.render();
    try {
      const res = await store.request<{ servers?: LocalServer[] } | undefined>({ t: 'remove_local_server', reqId: '', name: s.name });
      if (res?.servers) servers = res.servers;
      if (editor?.editing?.name === s.name) editor = null;
      o.shell.toast('success', `${s.name} removed.`);
    } catch (err) {
      o.shell.toast('error', `Couldn’t remove ${s.name}: ${errText(err)}`);
    }
    removing.delete(s.name);
    o.render();
  }

  /** How many of a server's models the agent lists as ready right now. */
  const readyCount = (name: string) => store.state.models.filter((m) => m.available && m.id.startsWith(`${name}/`)).length;

  function serverRow(s: LocalServer): HTMLElement {
    const n = readyCount(s.name);
    const gone = removing.has(s.name);
    return h(
      'li',
      { class: 'acct' },
      h(
        'div',
        { class: 'acct-top' },
        h('code', { class: 'acct-name' }, s.name),
        h('span', { class: 'acct-plan' }, KIND_LABEL[s.kind]),
      ),
      h('p', { class: 'acct-note lm-addr' }, h('code', null, s.baseUrl), s.hasKey ? ' · with API key' : null),
      h(
        'p',
        { class: ['acct-note', n ? 'lm-ready' : 'lm-none'] },
        n ? `${n} ${n === 1 ? 'model' : 'models'} ready — pick ${n === 1 ? 'it' : 'them'} for any role.` : 'No models listed. Is the server running and reachable? Press Refresh after starting it.',
      ),
      h(
        'div',
        { class: 'lm-row-actions' },
        h('button', { type: 'button', class: 'btn btn-ghost btn-sm', disabled: gone || !!editor, 'data-focus-key': `lm:edit:${s.name}`, onclick: () => openEditor(s) }, icon('pencil', 14), 'Edit'),
        h('button', { type: 'button', class: 'btn btn-ghost btn-sm', disabled: gone, onclick: () => void remove(s) }, gone ? h('span', { class: 'spinner spinner-sm' }) : icon('trash', 14), 'Remove'),
      ),
    );
  }

  function testLine(t: TestResult): HTMLElement {
    if (!t.ok) return h('div', { class: 'signin-result is-err', role: 'alert' }, icon('alert', 16), h('span', null, t.error));
    if (!t.models.length) {
      return h('div', { class: 'signin-result is-warn', role: 'status' }, icon('alert', 16), h('span', null, 'Connected, but the server lists no models. Load a model on it, then test again.'));
    }
    const shown = t.models.slice(0, 8);
    return h(
      'div',
      { class: 'signin-result is-ok', role: 'status' },
      icon('checkCircle', 16),
      h('div', null, h('span', null, `Connected — ${t.models.length} ${t.models.length === 1 ? 'model' : 'models'}:`), h('ul', { class: 'lm-models' }, shown.map((m) => h('li', null, h('code', null, m)))), t.models.length > shown.length ? h('span', { class: 'muted small' }, `and ${t.models.length - shown.length} more`) : null),
    );
  }

  function editorBox(ed: Editor): HTMLElement {
    const busy = !!ed.busy;
    for (const el of [ed.kind, ed.address, ed.key]) el.disabled = busy;
    ed.name.disabled = busy || !!ed.editing;
    const label = (text: string, el: HTMLElement, hint?: string, wide = false) =>
      h('label', { class: ['lm-field', wide ? 'is-wide' : null] }, h('span', { class: 'field-label' }, text), el, hint ? h('span', { class: 'lm-hint' }, hint) : null);
    return h(
      'div',
      { class: 'g-form lm-form', role: 'group', 'aria-label': ed.editing ? `Edit ${ed.editing.name}` : 'Add a model server' },
      h(
        'div',
        { class: 'lm-fields' },
        label('Name', ed.name, ed.editing ? undefined : 'Its models are named after it: name/model.'),
        label('Kind', ed.kind),
        label('Address', ed.address, 'The other machine’s IP or tailnet name and port.', true),
        ed.dropKey
          ? h('div', { class: 'lm-field is-wide' }, h('span', { class: 'field-label' }, 'API key'), h('p', { class: 'lm-hint' }, 'The saved key is removed when you save.'))
          : label('API key (optional)', ed.key, undefined, true),
      ),
      ed.editing?.hasKey
        ? h(
            'button',
            { type: 'button', class: 'btn btn-ghost btn-sm lm-drop-key', disabled: busy, onclick: () => ((ed.dropKey = !ed.dropKey), (ed.key.value = ''), o.render()) },
            ed.dropKey ? 'Keep the saved key' : 'Use no key',
          )
        : null,
      h('p', { class: 'lm-hint' }, 'The server has to listen on the network, not only on its own machine: llama.cpp ', h('code', null, '--host 0.0.0.0'), ', Ollama ', h('code', null, 'OLLAMA_HOST=0.0.0.0'), ', LM Studio “Serve on Local Network”.'),
      ed.test ? testLine(ed.test) : null,
      ed.error ? h('div', { class: 'signin-result is-err', role: 'alert' }, icon('alert', 16), h('span', null, ed.error)) : null,
      h(
        'div',
        { class: 'signin-actions' },
        h('button', { type: 'button', class: 'btn btn-soft btn-sm', disabled: busy, onclick: () => void test() }, ed.busy === 'test' ? h('span', { class: 'spinner spinner-sm' }) : icon('refresh', 14), ed.busy === 'test' ? 'Testing…' : 'Test connection'),
        h('button', { type: 'button', class: 'btn btn-primary btn-sm', disabled: busy, onclick: () => void save() }, ed.busy === 'save' ? h('span', { class: 'spinner spinner-sm' }) : icon('save', 14), ed.busy === 'save' ? 'Saving…' : 'Save'),
        h('button', { type: 'button', class: 'btn btn-ghost btn-sm', disabled: busy, 'data-focus-key': 'lm:add', onclick: () => ((editor = null), o.render()) }, 'Cancel'),
      ),
    );
  }

  function el(): HTMLElement {
    const list = servers ?? [];
    const ready = list.filter((s) => readyCount(s.name) > 0).length;
    return h(
      'article',
      { class: ['vendor-card', 'lm-card', ready ? 'is-connected' : 'is-off'], style: { '--vc': vendorColor('other') }, 'data-card': 'local' },
      h(
        'header',
        { class: 'vendor-head' },
        h('span', { class: 'vendor-mark' }, icon('monitor', 16)),
        h('div', { class: 'vendor-titles' }, h('h3', null, 'Model servers on your network'), h('p', { class: 'muted small' }, 'llama.cpp, Ollama, LM Studio or another OpenAI-compatible server on another machine')),
        list.length ? h('span', { class: ['conn-pill', ready ? 'is-on' : 'is-off'] }, h('span', { class: 'conn-dot' }), ready ? 'Connected' : 'No models') : null,
      ),
      loadErr ? h('p', { class: 'acct-note is-err' }, `Couldn’t read the agent’s model servers: ${loadErr} `, h('button', { type: 'button', class: 'link-btn', onclick: () => void load() }, 'Retry')) : null,
      list.length ? h('ul', { class: 'acct-list lm-list' }, list.map(serverRow)) : null,
      editor
        ? editorBox(editor)
        : h(
            'div',
            { class: 'vendor-connect lm-add' },
            h('button', { type: 'button', class: 'btn btn-soft btn-sm', 'data-focus-key': 'lm:add', disabled: servers === null && !loadErr, onclick: () => openEditor(null) }, icon('plus', 14), list.length ? 'Add another server' : 'Add a model server'),
          ),
      file ? h('p', { class: 'lm-file muted small' }, 'Kept in ', h('code', null, file), ', where the agent reads its providers.') : null,
    );
  }

  return {
    el,
    sig: () => JSON.stringify([servers, file, loadErr]),
    owns: (provider) => !!servers?.some((s) => s.name === provider),
    open() {
      open = true;
      void load();
    },
    close() {
      open = false;
      editor = null;
    },
  };
}
