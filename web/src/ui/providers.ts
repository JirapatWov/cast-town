// Models & Providers ("Talent Agency"): who is connected, which models are real, and signing in.
// Sign in runs `omp login <provider>` on the server (server/agents/provider-login.ts) and walks the user through it:
// open the provider's page, then paste back what omp asks for — the code Claude shows after approving, the address the
// browser lands on after other sign-ins (a localhost page that can't load, because the callback listens on the server),
// an API key, an account ID — or enter the code a device sign-in shows on the provider's page. A running sign-in
// counts down to the server's deadline; one that ran out says so and offers to start again.
// The featured vendors (Anthropic, OpenAI, DeepSeek, Google, OpenRouter) have a card each; every other provider omp is
// signed in to (GitHub Copilot, Cursor, Cerebras, …) gets a card of its own, and "Connect another account"
// (providers-list.ts) lists every sign-in omp offers.
// A connected card also lists the accounts omp holds for it (list_accounts) and lets the user sign one out or add
// another (a second OAuth sign-in adds an account). Its model list and its usage limits (get_usage: how much of each
// limit is used) start folded; usage is asked for only once its part is unfolded and on screen (omp usage is a
// few-hundred-MB process). With two or more OAuth accounts of a provider, the usage part also holds the global order
// omp tries them in (the same editor as the chat's account chip): saving it applies to every chat and clears the
// chats' own picks.
// Google has more ways in than one button (providers-google.ts): Paste API key, Antigravity (unofficial), and the
// Google Cloud project a failed Sign in with Google may ask for. Anthropic and OpenAI have Paste API key too
// (providers-keys.ts), and model servers on the network (llama.cpp, Ollama, LM Studio) a card of their own
// (providers-local.ts).
import { credentialProviderOf, loginLabel, loginProvider } from '../../../shared/omp-logins';
import { AGENT_BUILD_COMMAND, AGENT_NAME } from '../../../shared/omp-version';
import { PROVIDER_VENDOR } from '../../../shared/provider-vendors';
import { uncheckedOf, type AccountUsage, type LoginState, type ModelInfo, type ProviderAccount, type ProviderStatus, type UsageLimit, type UsageSnapshot, type Vendor } from '../../../shared/protocol';
import { agentsState, recheckAgents, type AgentsState } from './agents-health';
import { cityAccountsNote } from './cities';
import { confirmDialog } from './confirm';
import { copyText, h, setChildren, type Child } from './dom';
import { VENDOR_LABEL, VENDOR_ORDER, anyConnected, modelGroups, sentenceStart, vendorColor } from './format';
import { projectLinks } from './help-info';
import { icon } from './icons';
import { openModal, type ModalHandle } from './modal';
import { connectedLogins, deviceCode, modelCount, otherProviders, signInHome, signedInProviders, type OtherProvider } from './provider-catalog';
import { ANTIGRAVITY, createGoogleCard, type GoogleCard } from './providers-google';
import { createKeyPaste, hasKeyPaste } from './providers-keys';
import { createLocalCard } from './providers-local';
import { createLoginList, openParts, partId, partToggle, watchTallHead } from './providers-list';
import { accountOrder, createOrderEditor, limitBrief, providerLabel, type OrderEditor } from './providers-order';
import type { Shell } from './shell';
import { accountKey, accountName, pairUsage, updatedText, usageLevel, usageLine, usedPct } from './usage-text';
import { whenSeen } from './when-seen';

/** Exact commands per vendor (env var names verified against omp's provider definitions). omp has no key sign-in for
 *  Anthropic, OpenAI or Gemini (its `login` for those is the subscription sign-in above): a key pasted on their cards
 *  goes into CAST's config.json ompEnv (providers-keys.ts); these are the same by hand. */
const CONNECT: Partial<Record<Vendor, { cmd: string; note: string }[]>> = {
  anthropic: [
    { cmd: 'export ANTHROPIC_API_KEY=sk-ant-…', note: 'API key' },
    { cmd: 'cast-agent login anthropic', note: 'or sign in with a Claude subscription' },
  ],
  openai: [{ cmd: 'export OPENAI_API_KEY=sk-…', note: 'API key' }],
  deepseek: [
    { cmd: 'export DEEPSEEK_API_KEY=sk-…', note: 'API key' },
    { cmd: 'cast-agent login deepseek', note: 'or store it with the agent' },
  ],
  google: [{ cmd: 'export GEMINI_API_KEY=…', note: 'Gemini API key (AI Studio)' }],
  openrouter: [
    { cmd: 'export OPENROUTER_API_KEY=sk-or-…', note: 'API key' },
    { cmd: 'cast-agent login openrouter', note: 'or sign in' },
  ],
};

/** The machine facts the copy needs (hello's MachineInfo; absent from older servers). */
interface Where {
  agentDir: string | null; // the agent's sign-in folder, as the server really uses it
  runAs: string | null;
  agentBin: string | null; // what the server runs as the agent (hello.agents.ompPath)
}

/** "By hand": where those commands go. A key typed into CAST's own Terminal (or on a phone) never reaches the server. */
function manualHelp(where: Where): HTMLElement {
  return h(
    'p',
    { class: 'cmd-help' },
    'Keys: add the ', h('code', null, 'export …'), ' line to the shell that starts the CAST server (for example ', h('code', null, '~/.profile'),
    '), restart CAST, then press Refresh. Typing it into CAST’s Terminal doesn’t reach the server. ',
    h('code', null, `${AGENT_NAME} login …`), ` runs in any terminal on this machine${where.runAs ? ` as ${where.runAs}` : ''}`,
    where.agentDir ? [' and stores the sign-in in ', h('code', null, where.agentDir)] : null,
    '.',
  );
}

/** One-click sign-in per vendor: the omp login provider behind it (`key`: it stores an API key, so a second replaces it). */
type SignIn = { provider: string; label: string; key?: true };
const SIGN_IN: Partial<Record<Vendor, SignIn>> = {
  anthropic: { provider: 'anthropic', label: 'Sign in with Claude Pro/Max' },
  openai: { provider: 'openai-codex', label: 'Sign in with ChatGPT Plus/Pro' },
  deepseek: { provider: 'deepseek', label: 'Add a DeepSeek API key', key: true },
  google: { provider: 'google-gemini-cli', label: 'Sign in with Google' },
  openrouter: { provider: 'openrouter', label: 'Sign in to OpenRouter' },
};

/** The featured card a sign-in shows on: its provider's vendor ('openai-codex-device' → OpenAI, Antigravity →
 *  Google); undefined for a provider without a featured card. */
function loginVendor(provider: string): Vendor | undefined {
  if (provider === ANTIGRAVITY) return 'google';
  const v = PROVIDER_VENDOR[credentialProviderOf(provider)];
  return v && v !== 'other' ? v : undefined;
}

/** How a sentence names the provider of a sign-in ('openai-codex' → OpenAI, 'github-copilot' → GitHub Copilot). */
function providerVendorLabel(provider: string): string {
  const v = loginVendor(provider);
  return v ? VENDOR_LABEL[v] : (loginLabel(credentialProviderOf(provider)) ?? provider);
}

/** The sign-in that connects an "other" provider again (Add account… / Replace key…). */
function otherSignIn(o: OtherProvider): SignIn | undefined {
  const l = o.login;
  if (!l) return undefined;
  return { provider: l.id, label: `Connect ${l.label}`, ...(l.kind === 'key' ? { key: true as const } : {}) };
}

/** What omp is asking for, so the step can be explained in plain words. */
type PromptKind = 'code' | 'redirect' | 'key' | 'other';
function promptKind(l: LoginState): PromptKind {
  if (l.secret) return 'key';
  if (/redirect|authorization code/i.test(l.prompt ?? '')) return l.pasteCode ? 'code' : 'redirect';
  return 'other';
}

/** "14:05" — minutes and seconds left. */
function clockText(ms: number): string {
  const s = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

/** omp's prompt without its placeholder: "Enter your Cloudflare account ID (32-character account ID)" → its first part
 *  (the placeholder goes into the field). */
function splitPrompt(prompt: string): { text: string; placeholder: string } {
  const m = /^(.*\S)\s+\(([^()]*)\)$/.exec(prompt.trim());
  return m ? { text: m[1]!, placeholder: m[2]! } : { text: prompt.trim(), placeholder: '' };
}

/** Fallback: pull `backticked` commands out of the server's one-line hint. */
function commandsFromHint(how: string): { cmd: string; note: string }[] {
  const out: { cmd: string; note: string }[] = [];
  for (const part of how.split(/\s+or\s+/i)) {
    const m = /`([^`]+)`/.exec(part);
    const cmd = (m ? m[1] : part).trim();
    if (cmd) out.push({ cmd, note: '' });
  }
  return out;
}

/** A `cast-agent …` command as it runs in a terminal on the server: the agent isn't on PATH there, so its full path. */
function agentCommand(cmd: string, bin: string | null): string {
  if (!bin || !cmd.startsWith(`${AGENT_NAME} `)) return cmd;
  const quoted = /^[\w./~+-]+$/.test(bin) ? bin : `'${bin.replaceAll("'", `'\\''`)}'`;
  return `${quoted}${cmd.slice(AGENT_NAME.length)}`;
}

function commandRow(cmd: string, note: string): HTMLElement {
  const label = h('span', null, 'Copy');
  return h(
    'div',
    { class: 'cmd' },
    h('code', null, cmd),
    note ? h('span', { class: 'cmd-note' }, note) : null,
    h(
      'button',
      {
        type: 'button',
        class: 'cmd-copy',
        'aria-label': `Copy ${cmd}`,
        onclick: async () => {
          label.textContent = (await copyText(cmd)) ? 'Copied' : 'Copy failed';
          setTimeout(() => (label.textContent = 'Copy'), 1400);
        },
      },
      icon('copy', 13),
      label,
    ),
  );
}

/** A card's model list: its own models, then each other sign-in's under a "via …" line (Antigravity's Claude on the
 *  Google card) — that line names the route, so the rows under it keep their plain names. `byRoute: false` lists them
 *  all plainly (a provider's own card: they all run through it). */
function modelRows(models: ModelInfo[], live: boolean, byRoute = true): HTMLElement[] {
  const row = (m: ModelInfo) =>
    h(
      'li',
      null,
      h('span', { class: ['avail-dot', m.available ? 'is-ready' : 'is-off'], title: m.available ? 'Ready' : live ? 'Not connected — can’t be used' : 'Not connected' }),
      h('span', { class: 'vm-label' }, m.label),
      h('code', { class: 'vm-id' }, m.id),
    );
  if (!byRoute) return models.map(row);
  return modelGroups(models).flatMap((g) => [...(g.route ? [h('li', { class: 'vm-route' }, `via ${g.route}`)] : []), ...g.models.map(row)]);
}

export function createProviders(shell: Shell) {
  const { store } = shell;
  let modal: ModalHandle | null = null;
  let content: HTMLElement | null = null;
  let refreshing = false;
  const refreshBtn = h('button', { type: 'button', class: 'btn btn-soft btn-sm' });
  let login: LoginState | null = null;
  // The paste field survives re-renders (models/login updates) so typed text and focus are kept.
  let field: { key: string; input: HTMLInputElement } | null = null;
  // What step 2 of a sign-in asks for, kept while omp checks the answer (its prompt is cleared then, which would turn
  // "Paste the key" into a generic "Answer").
  let stepKind: { loginId: string; kind: PromptKind } | null = null;
  // When the running sign-in times out, by this page's clock (the server sends the time left with every update).
  let loginDeadline: { loginId: string; at: number } | null = null;
  let countdown: ReturnType<typeof setInterval> | null = null;
  const manualOpen = new Set<Vendor>();
  /** A paste field that just appeared (after "Add a … API key"): it gets the focus the pressed button had. */
  let freshField: HTMLInputElement | null = null;
  /** A sign-in started from the list for a provider with a card: that card is scrolled into view once drawn. */
  let reveal: string | null = null;
  // The parts of the cards (models, usage) and of the list (its groups) the user unfolded: remembered per device.
  const parts = openParts();
  // The API keys are among omp's settings the Google card reads and saves (config.json ompEnv).
  const keys = createKeyPaste({
    shell,
    render: () => render(),
    focusAfterRender: (el) => (freshField = el),
    env: () => google.env,
    ready: () => google.ready,
    save: (patch) => google.save(patch),
  });
  const google = createGoogleCard({
    shell,
    render: () => render(),
    renderData: () => renderData(),
    startLogin: (provider) => startLogin(provider),
    focusAfterRender: (el) => (freshField = el),
    keys,
  });
  const local = createLocalCard({ shell, render: () => render(), renderData: () => renderData(), focusAfterRender: (el) => (freshField = el) });
  const loginList = createLoginList({
    parts,
    render: () => render(),
    start: (id) => {
      reveal = id;
      startLogin(id);
    },
  });

  // Accounts (list_accounts) and usage limits (get_usage): null until the first answer. A newer request wins (seq).
  let accounts: ProviderAccount[] | null = null;
  let accountsErr: string | null = null;
  let accountsBusy = false;
  let accountsSeq = 0;
  let usage: UsageSnapshot | null = null;
  let usageErr: string | null = null;
  let usageBusy = false;
  let usageSeq = 0;
  // Usage limits cost the server an `omp usage` run (a few hundred MB): asked for only once a usage part of the page
  // is unfolded and on screen, not on every open. Per open of the page.
  let usageWanted = false;
  let stopUsageWatch: (() => void) | null = null;
  let stopHeadWatch: (() => void) | null = null; // very large text: the whole dialog scrolls (providers-list.ts)
  const signingOut = new Set<string>(); // accountKey()s
  // Add account… remembers the provider's accounts before the sign-in (only that provider's: Google has two); once
  // it succeeds, the first list read after that (seq) tells whether it added an account next to the old one(s) — then
  // `offer` asks whether to sign those out. `card`: the card it was started on (a vendor, or `p:<provider>`).
  let switching: { card: string; provider: string; before: ProviderAccount[] } | null = null;
  let pendingSwitch: { card: string; provider: string; before: ProviderAccount[]; seq: number } | null = null;
  let offer: { card: string; added: ProviderAccount; old: ProviderAccount[] } | null = null;
  // A `models` broadcast means credentials may have changed elsewhere: re-read them a moment later, unless this page
  // read them meanwhile (its own sign-in/sign-out sends the broadcast and then reads them anyway).
  let modelsTimer: ReturnType<typeof setTimeout> | null = null;
  // Text that ages while the page stays open ("updated 3 min ago", "resets in 9 min"); re-read by a timer.
  let tickers: (() => void)[] = [];
  // The global account order (get_account_order; pushed as it changes): one editor per OAuth provider, kept across
  // renders so a draft and the focus survive; a render waits while a row is being dragged.
  const order = accountOrder(store);
  const editors = new Map<string, OrderEditor>();
  let offOrder: (() => void) | null = null;
  let owedRender = false;
  let ticker: ReturnType<typeof setInterval> | null = null;

  const errText = (err: unknown) => (err instanceof Error ? err.message : String(err));
  const ticking = <E extends HTMLElement>(el: E, text: () => string): E => {
    el.textContent = text();
    tickers.push(() => (el.textContent = text()));
    return el;
  };
  // The same account signed in again: the same account id in the same org, or the very same label.
  const sameAccount = (a: ProviderAccount, b: ProviderAccount) => (!!a.accountId && a.accountId === b.accountId && a.org === b.org) || a.label === b.label;

  const startLogin = (provider: string) => {
    login = { loginId: '', provider, phase: 'starting' };
    field = null;
    store.send({ t: 'login_start', provider });
    render();
  };

  /** Add account… / Replace key…: the same sign-in, remembering which accounts were there before. */
  const switchAccount = (card: string, provider: string) => {
    const stored = credentialProviderOf(provider);
    switching = { card, provider, before: (accounts ?? []).filter((a) => a.provider === stored) };
    offer = null;
    startLogin(provider);
  };

  function setAccounts(list: ProviderAccount[], seq: number) {
    accounts = list;
    accountsErr = null;
    const has = (a: ProviderAccount) => list.some((x) => accountKey(x) === accountKey(a));
    if (pendingSwitch && seq >= pendingSwitch.seq) {
      const sw = pendingSwitch;
      pendingSwitch = null;
      const before = new Set(sw.before.map(accountKey));
      const stored = credentialProviderOf(sw.provider);
      const mine = list.filter((a) => a.provider === stored);
      const added = mine.find((a) => !before.has(accountKey(a)));
      const old = mine.filter((a) => before.has(accountKey(a)));
      // omp replaced the key, or it was the same account again: nothing to ask.
      offer = added && old.length && !old.some((a) => sameAccount(a, added)) ? { card: sw.card, added, old } : null;
    } else if (offer) {
      const old = offer.old.filter(has);
      offer = has(offer.added) && old.length ? { ...offer, old } : null;
    }
  }

  async function loadAccounts() {
    const seq = ++accountsSeq;
    // Only a list on screen (its spinner) or a failed one (Retry, Switch account…) shows that a read started.
    const shows = !accountsBusy && !!(accounts || accountsErr);
    accountsBusy = true;
    if (shows) renderData();
    try {
      const res = await store.request<{ accounts?: ProviderAccount[] } | undefined>({ t: 'list_accounts', reqId: '' });
      if (seq === accountsSeq) setAccounts(res?.accounts ?? [], seq);
    } catch (err) {
      if (seq === accountsSeq) accountsErr = errText(err);
    } finally {
      if (seq === accountsSeq) {
        accountsBusy = false;
        renderData();
      }
    }
  }

  async function loadUsage(force = false) {
    const seq = ++usageSeq;
    const shows = !usageBusy;
    usageBusy = true;
    if (shows) renderData();
    try {
      const res = await store.request<{ usage?: UsageSnapshot } | undefined>({ t: 'get_usage', reqId: '', ...(force ? { force: true } : {}) });
      if (seq === usageSeq) {
        const next = res?.usage ?? null;
        // omp couldn't be read this time: keep the numbers on screen, and the usage part says it couldn't refresh.
        if (next?.error && usage && !usage.error) usageErr = next.error;
        else {
          usage = next;
          usageErr = null;
        }
      }
    } catch (err) {
      if (seq === usageSeq) usageErr = errText(err);
    } finally {
      if (seq === usageSeq) {
        usageBusy = false;
        renderData();
      }
    }
  }

  /** A sign-in finished (here or in another tab): the accounts changed, and the server dropped its cached usage. */
  function afterSignIn(provider: string) {
    if (switching?.provider === provider) {
      pendingSwitch = { ...switching, seq: accountsSeq + 1 };
      switching = null;
    }
    if (!modal) return; // re-read when the page opens
    void loadAccounts();
    if (usageWanted) void loadUsage();
  }

  /** How a sentence names an account's provider ("Anthropic", "GitHub Copilot"). */
  const accountVendor = (a: ProviderAccount) => (a.vendor !== 'other' ? VENDOR_LABEL[a.vendor] : (loginLabel(a.provider) ?? a.provider));

  /** `ask` = confirm first; the after-switch prompt already asked. */
  async function signOut(a: ProviderAccount, ask: boolean) {
    const key = accountKey(a);
    if (signingOut.has(key)) return;
    const vendor = accountVendor(a);
    // the accounts that go with it on its card: the vendor's, or (another provider) that provider's
    const sameCard = (x: ProviderAccount) => (a.vendor !== 'other' ? x.vendor === a.vendor : x.provider === a.provider);
    if (ask) {
      const other = (accounts ?? []).find((x) => sameCard(x) && accountKey(x) !== key);
      const elsewhere = (accounts ?? []).some((x) => !sameCard(x)) || store.state.models.some((m) => m.available && (a.vendor !== 'other' ? m.vendor !== a.vendor : !m.id.startsWith(`${a.provider}/`)));
      const ok = await confirmDialog(shell.root, shell.layers, {
        title: `Sign out of ${accountName(a.label)}?`,
        body: other
          ? `Agents on ${vendor} keep working on ${accountName(other.label)}.`
          : // with another provider still signed in, models without a sign-in can't be used at all
            elsewhere
            ? `${vendor} models can’t be used until you sign in again — people on them stop working.`
            : 'Nobody can work until you sign in again — this is your only AI account.',
        confirmLabel: 'Sign out',
        tone: 'danger',
        icon: 'exit',
      });
      if (!ok) return;
    }
    signingOut.add(key);
    render();
    try {
      const res = await store.request<{ accounts?: ProviderAccount[] } | undefined>({ t: 'logout_account', reqId: '', provider: a.provider, credentialId: a.credentialId });
      const seq = ++accountsSeq; // a list still on its way was read before the sign-out
      accountsBusy = false;
      setAccounts(res?.accounts ?? (accounts ?? []).filter((x) => accountKey(x) !== key), seq);
      if (usageWanted) void loadUsage();
    } catch (err) {
      shell.toast('error', `Couldn’t sign out: ${errText(err)}`);
      // omp may have signed it out before failing (or the connection dropped): show what is really stored.
      if (modal) {
        void loadAccounts();
        if (usageWanted) void loadUsage();
      }
    } finally {
      signingOut.delete(key);
      render();
    }
  }

  function limitRow(l: UsageLimit): HTMLElement {
    const pct = usedPct(l);
    return h(
      'li',
      { class: ['lim', `is-${usageLevel(l)}`] },
      h('span', { class: 'lim-label' }, l.label),
      ticking(h('span', { class: 'lim-text' }), () => usageLine(l, Date.now())),
      pct === null ? null : h('span', { class: 'lim-bar', 'aria-hidden': 'true' }, h('span', { style: { width: `${pct}%` } })),
    );
  }

  function accountLimits(u: AccountUsage | undefined, a: ProviderAccount | null): HTMLElement {
    if (u?.limits.length) return h('ul', { class: 'acct-limits' }, u.limits.map(limitRow));
    const note = (text: string, spin = false) => h('p', { class: 'acct-note' }, spin ? h('span', { class: 'spinner spinner-sm' }) : null, text);
    if (a?.type === 'api_key') return note('No usage limits reported');
    if (!usage && (usageBusy || !usageWanted)) return note('Checking limits…', true);
    if (!u && (usageErr || usage?.error)) return note('Couldn’t check usage limits');
    if (u?.stale || (a && uncheckedOf(a, usage))) return note('Couldn’t check this account just now');
    return note('No usage limits reported');
  }

  /** One account: its name, plan and Sign out (the limits are in the card's usage part). */
  function accountRow(name: string, u: AccountUsage | undefined, a: ProviderAccount | null): HTMLElement {
    const leaving = !!a && signingOut.has(accountKey(a));
    const plan = u?.plan && !name.toLowerCase().includes(u.plan.toLowerCase()) ? u.plan : null;
    return h(
      'li',
      { class: ['acct', leaving ? 'is-leaving' : null] },
      h(
        'div',
        { class: 'acct-top' },
        h('span', { class: 'acct-name' }, name),
        plan ? h('span', { class: 'acct-plan' }, plan) : null,
        a
          ? h('button', { type: 'button', class: 'link-btn acct-out', disabled: leaving, onclick: () => void signOut(a, true) }, leaving ? 'Signing out…' : 'Sign out')
          : null,
      ),
    );
  }

  function offerBox(o: NonNullable<typeof offer>): HTMLElement {
    // The email alone, unless another of these accounts has the same one (one person in two orgs): then "email · org".
    const short = (a: ProviderAccount) => accountName(a.label).split(' · ')[0];
    const all = [o.added, ...o.old];
    const name = (a: ProviderAccount) => (all.some((b) => b !== a && short(b) === short(a)) ? accountName(a.label) : short(a));
    return h(
      'div',
      { class: 'acct-offer', role: 'status' },
      h('p', null, 'Signed in as ', h('strong', null, name(o.added)), '. Sign out of ', o.old.map((a, i) => [i ? ', ' : '', h('strong', null, name(a))]), '?'),
      h('p', { class: 'acct-offer-note' }, 'With both, each chat gets one account and moves to the other when a limit is used up.'),
      h(
        'div',
        { class: 'acct-offer-actions' },
        o.old.map((a) =>
          h(
            'button',
            { type: 'button', class: 'btn btn-soft btn-sm', disabled: signingOut.has(accountKey(a)), onclick: () => void signOut(a, false) },
            signingOut.has(accountKey(a)) ? h('span', { class: 'spinner spinner-sm' }) : icon('exit', 14),
            h('span', { class: 'acct-offer-name' }, `Sign out ${name(a)}`),
          ),
        ),
        h('button', { type: 'button', class: 'btn btn-ghost btn-sm', onclick: () => ((offer = null), render()) }, 'Keep both'),
      ),
    );
  }

  /** The order of each of the vendor's OAuth providers with two or more accounts (Google has two providers). */
  function orderBlocks(vendor: Vendor): HTMLElement[] {
    const mine = (order.order?.providers ?? []).filter((p) => p.vendor === vendor && p.accounts.length >= 2);
    return mine.map((p) => {
      let ed = editors.get(p.provider);
      if (!ed) {
        ed = createOrderEditor({
          provider: p.provider,
          client: order,
          limits: false,
          ownPicks: () => Object.values(store.state.agents).filter((x) => x.account?.provider === p.provider && x.account.pinned).length,
          onError: (text) => shell.toast('error', text),
          onDone: (saved) => {
            if (saved) shell.toast('success', `${providerLabel(p.provider)} order saved — every chat follows it now.`);
          },
          onDragEnd: () => {
            if (owedRender) render();
          },
        });
        editors.set(p.provider, ed);
      }
      ed.update();
      return h(
        'section',
        { class: 'acct-order', 'aria-label': `Order of the ${providerLabel(p.provider)} accounts` },
        h('div', { class: 'acct-bar' }, h('span', { class: 'field-label' }, mine.length > 1 ? `Order for every chat · ${providerLabel(p.provider)}` : 'Order for every chat')),
        h('p', { class: 'acct-note' }, 'Each chat starts on the first account that isn’t at a limit and moves down the list when a limit is used up. A chat can pick its own account from the chip under its message box.'),
        ed.el,
      );
    });
  }

  /** What a card shows of its accounts: who they are (with their usage reports), and the reports no listed account
   *  claimed (shown without Sign out) — not before the list has answered, nor from numbers kept after a failed
   *  refresh (they may be of an account signed out since). */
  interface CardAccounts {
    card: string; // the card's key: a vendor, or `p:<provider>`
    title: string; // how the card names its provider ("Anthropic", "GitHub Copilot")
    mine: ProviderAccount[];
    orphans: AccountUsage[];
    paired: ReturnType<typeof pairUsage>;
    vendor?: Vendor; // a featured card: its order editors and Google's key row
  }

  const orphanName = (u: AccountUsage, title: string) => [u.email, u.org].filter(Boolean).join(' · ') || u.projectId || `${title} account`;

  /** Accounts of a connected card (names, plan, Sign out), plus Add account… / Replace key…. */
  function accountsBlock(c: CardAccounts, signIn: SignIn | undefined, busy: boolean): HTMLElement {
    const rows = [
      ...c.mine.map((a) => accountRow(accountName(a.label), c.paired.byAccount.get(accountKey(a)), a)),
      ...c.orphans.map((u) => accountRow(orphanName(u, c.title), u, null)),
      hasKeyPaste(c.vendor) ? keys.row(c.vendor) : null, // the API key CAST gives omp (not one of omp's stored sign-ins)
    ].filter((r): r is HTMLElement => !!r);
    const stored = signIn ? credentialProviderOf(signIn.provider) : null;
    const viaSignIn = stored ? c.mine.filter((a) => a.provider === stored) : [];
    // Until the list answers, who is signed in is unknown (and Switch account… couldn't tell the new account): wait.
    const listing = !accounts && (accountsBusy || !accountsErr);
    const via = !accounts ? (signIn?.key ? 'key' : 'oauth') : !viaSignIn.length ? 'none' : viaSignIn.some((a) => a.type === 'oauth') ? 'oauth' : 'key';
    const action =
      signIn && !busy
        ? h(
            'button',
            {
              type: 'button',
              class: 'btn btn-soft btn-sm acct-switch',
              disabled: listing,
              'data-focus-key': `signin:${signIn.provider}`,
              // an OAuth sign-in adds the account next to the ones there; the offer box then asks keep both / sign out
              title: via === 'oauth' ? 'Sign in with another account. Then keep both (chats move on when one hits a limit) or sign out the old one.' : undefined,
              onclick: async () => {
                if (!accounts) await loadAccounts(); // the list failed: read it first
                if (accounts && modal) switchAccount(c.card, signIn.provider);
              },
            },
            listing ? h('span', { class: 'spinner spinner-sm' }) : icon(via === 'key' ? 'key' : 'users', 14),
            h('span', { class: 'acct-switch-label' }, via === 'none' ? signIn.label : via === 'oauth' ? 'Add account…' : 'Replace key…'),
          )
        : null;
    const failed = accountsErr
      ? h(
          'p',
          { class: 'acct-note is-err' },
          `Couldn’t list accounts: ${accountsErr} `,
          h('button', { type: 'button', class: 'link-btn', disabled: accountsBusy, onclick: () => void loadAccounts() }, accountsBusy ? 'Retrying…' : 'Retry'),
        )
      : null;
    let body: Child;
    const checking = !accounts && !accountsErr ? h('p', { class: 'acct-note' }, h('span', { class: 'spinner spinner-sm' }), 'Checking accounts…') : null;
    if (rows.length) body = [h('ul', { class: 'acct-list' }, rows), checking, failed];
    else if (failed) body = failed;
    else if (!accounts) body = h('p', { class: 'acct-note' }, h('span', { class: 'spinner spinner-sm' }), 'Checking accounts…');
    else body = h('p', { class: 'acct-note' }, 'No stored sign-in — connected through a key in the CAST server’s environment.');
    return h(
      'section',
      { class: 'vendor-accounts', 'aria-label': `${c.title} accounts` },
      h('div', { class: 'acct-bar' }, h('span', { class: 'field-label' }, 'Accounts'), accountsBusy && accounts ? h('span', { class: 'spinner spinner-sm', title: 'Checking accounts…' }) : null, action),
      body,
      offer?.card === c.card ? offerBox(offer) : null,
    );
  }

  /** The most-used limit among a card's accounts, if the page (or the account order, which the chat chips read) has
   *  usage numbers already: "5h 38% used". Never asks for them. */
  function usageBrief(c: CardAccounts): ReturnType<typeof limitBrief> {
    const limits: UsageLimit[] = [];
    for (const a of c.mine) limits.push(...(c.paired.byAccount.get(accountKey(a))?.limits ?? []));
    for (const u of c.orphans) limits.push(...u.limits);
    if (!limits.length) {
      const ids = new Set(c.mine.map((a) => a.provider));
      for (const p of order.order?.providers ?? []) if (ids.has(p.provider)) for (const x of p.accounts) limits.push(...(x.limits ?? []));
    }
    return limitBrief(limits);
  }

  /** "updated 3 min ago · Check again" inside an unfolded usage part. */
  function usageStatus(): HTMLElement {
    const failed = usageErr ?? usage?.error ?? null;
    const fetchedAt = usage?.fetchedAt ?? 0;
    const status = failed
      ? h('span', null, usage?.fetchedAt && usageErr ? 'Couldn’t refresh — ' : 'Couldn’t check — ', failed)
      : usage
        ? ticking(h('span'), () => sentenceStart(updatedText(fetchedAt, Date.now())))
        : h('span', null, 'Checking…');
    return h(
      'div',
      { class: ['usage-head', failed ? 'is-err' : null] },
      icon('gauge', 15),
      h('p', { class: 'usage-head-text' }, status),
      h(
        'button',
        { type: 'button', class: 'btn btn-ghost btn-sm', disabled: usageBusy, 'aria-label': 'Check usage limits again', onclick: () => void loadUsage(true) },
        usageBusy ? h('span', { class: 'spinner spinner-sm' }) : icon('refresh', 14),
        usageBusy ? 'Checking…' : 'Check again',
      ),
    );
  }

  /** A connected card's usage part: folded to one line ("Usage · 5h 38% used ▸"); unfolded, each account's limits
   *  (how much is used) and, with two or more OAuth accounts, the order chats use them in. */
  function usagePart(c: CardAccounts): { toggle: HTMLElement; body: HTMLElement | null } {
    const key = `usage:${c.card}`;
    const open = parts.has(key);
    const brief = usageBrief(c);
    const toggle = partToggle({
      key,
      open,
      className: 'usage-toggle',
      label: 'Usage',
      meta: brief ? h('span', { class: `is-${brief.level}` }, brief.text) : null,
      onToggle: (next) => {
        parts.set(key, next);
        if (next) wantUsage(); // asked for now: the user unfolded it, so it is on screen
        render();
      },
    });
    if (!open) return { toggle, body: h('div', { class: 'part-body usage-block', id: partId(key), hidden: true }) };
    const several = c.mine.length + c.orphans.length > 1;
    const rows = [
      ...c.mine.map((a) => ({ name: accountName(a.label), u: c.paired.byAccount.get(accountKey(a)), a })),
      ...c.orphans.map((u) => ({ name: orphanName(u, c.title), u, a: null })),
    ];
    return {
      toggle,
      body: h(
        'div',
        { class: 'part-body usage-block is-open', id: partId(key), 'data-usage': c.card },
        usageStatus(),
        rows.length
          ? h(
              'ul',
              { class: 'usage-accts' },
              rows.map((r) =>
                h(
                  'li',
                  { class: 'usage-acct' },
                  several || r.u?.stale
                    ? h(
                        'p',
                        { class: 'usage-acct-name' },
                        several ? r.name : null,
                        r.u?.stale && r.u.limits.length ? h('span', { class: 'acct-stale', title: 'Couldn’t check this account just now — these are the last limits it reported.' }, '(last known)') : null,
                      )
                    : null,
                  accountLimits(r.u, r.a),
                ),
              ),
            )
          : h('p', { class: 'acct-note' }, 'No usage limits reported'),
        c.vendor ? orderBlocks(c.vendor) : null,
      ),
    };
  }

  /** A card's models, folded to one line ("12 models ▸"). */
  function modelsPart(card: string, models: ModelInfo[], live: boolean, byRoute = true): { toggle: HTMLElement; body: HTMLElement } | null {
    if (!models.length) return null;
    const key = `models:${card}`;
    const open = parts.has(key);
    return {
      toggle: partToggle({ key, open, className: 'models-toggle', label: modelCount(models.length), onToggle: (next) => (parts.set(key, next), render()) }),
      body: h('ul', { class: 'part-body vendor-models', id: partId(key), hidden: !open }, open ? modelRows(models, live, byRoute) : null),
    };
  }

  /** The folded parts of a card: their toggles in one row, then what is unfolded. */
  const cardParts = (...ps: ({ toggle: HTMLElement; body: HTMLElement | null } | null)[]): Child => {
    const shown = ps.filter((p): p is { toggle: HTMLElement; body: HTMLElement | null } => !!p);
    if (!shown.length) return null;
    return [h('div', { class: 'card-parts' }, shown.map((p) => p.toggle)), shown.map((p) => p.body)];
  };

  const submitField = () => {
    if (!login || !field || login.phase !== 'waiting') return;
    const value = field.input.value.trim();
    if (!value && !login.allowEmpty) {
      field.input.focus();
      return;
    }
    store.send({ t: 'login_input', loginId: login.loginId, value });
    field.input.value = '';
  };

  function loginPanel(l: LoginState): HTMLElement {
    if (l.phase === 'done') {
      return h('div', { class: 'signin-result is-ok', role: 'status' }, icon('checkCircle', 16), h('span', null, l.message ?? 'Signed in.'));
    }
    if (l.phase === 'failed') {
      const close = () => ((login = null), (switching = null), render());
      return h(
        'div',
        { class: 'signin' },
        h('div', { class: 'signin-result is-err', role: 'alert' }, icon('alert', 16), h('span', null, l.message ?? 'Sign-in failed.')),
        l.link ? h('a', { class: 'btn btn-soft btn-sm signin-link', href: l.link.url, target: '_blank', rel: 'noopener noreferrer' }, icon('external', 14), l.link.label) : null,
        l.details ? h('details', { class: 'signin-details' }, h('summary', null, 'Details'), h('pre', null, l.details)) : null,
        // a Google account that needs a Cloud project: its ID field (saved, then the sign-in runs again)
        google.loginFix(l, close) ??
          h(
            'div',
            { class: 'signin-actions' },
            h('button', { type: 'button', class: ['btn', 'btn-sm', l.timedOut ? 'btn-primary' : 'btn-soft'], onclick: () => startLogin(l.provider) }, icon('refresh', 14), l.timedOut ? 'Start again' : 'Try again'),
            h('button', { type: 'button', class: 'btn btn-ghost btn-sm', onclick: close }, 'Close'),
          ),
      );
    }
    const cancel = h(
      'button',
      {
        type: 'button',
        class: 'btn btn-ghost btn-sm',
        'data-focus-key': `signin:${l.provider}`,
        onclick: () => {
          if (l.loginId) store.send({ t: 'login_cancel', loginId: l.loginId });
          login = null;
          field = null;
          switching = null;
          render();
        },
      },
      'Cancel',
    );
    const progress = (fallback: string) => h('p', { class: 'signin-wait', role: 'status' }, h('span', { class: 'spinner spinner-sm' }), l.progress ?? fallback);
    if (l.phase === 'starting' || (!l.url && !l.prompt)) {
      return h('div', { class: 'signin' }, google.loginNote(l), progress('Starting sign-in…'), h('div', { class: 'signin-actions' }, cancel));
    }

    if (l.prompt) stepKind = { loginId: l.loginId, kind: promptKind(l) };
    const kind = !l.prompt && stepKind?.loginId === l.loginId ? stepKind.kind : promptKind(l);
    const meta = loginProvider(l.provider);
    const isKey = kind === 'key' || (!l.prompt && /api.?key/i.test(l.instructions ?? l.url ?? ''));
    const code = deviceCode(l);
    const device = !!code || (meta?.kind === 'device' && !!l.url && !l.prompt);
    const verifying = l.phase === 'verifying';
    const vendor = providerVendorLabel(l.provider);
    const where = whereNow();
    const key = `${l.loginId}:${l.prompt ?? ''}`;
    const asked = l.prompt ? splitPrompt(l.prompt) : null;
    if (l.prompt && field?.key !== key) {
      const input = h('input', {
        class: ['input', kind === 'key' ? null : 'input-mono'],
        type: kind === 'key' ? 'password' : 'text',
        autocomplete: 'off',
        spellcheck: 'false',
        'aria-label': asked!.text,
        placeholder: kind === 'code' ? 'Ab12Cd…#Ef34Gh…' : kind === 'redirect' ? 'http://localhost:…/callback?code=…' : asked!.placeholder || (kind === 'key' ? 'sk-…' : ''),
        onkeydown: (e: KeyboardEvent) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            submitField();
          }
        },
      });
      field = { key, input };
      freshField = input;
    }
    const input = l.prompt ? field!.input : null;
    if (input) input.disabled = verifying;

    const step = (n: number, title: string, body: Child[]) =>
      h('li', { class: 'signin-step' }, h('span', { class: 'signin-num' }, String(n)), h('div', null, h('p', { class: 'signin-title' }, title), body));

    const open = l.url
      ? h(
          'a',
          { class: 'btn btn-soft btn-sm signin-open', href: l.url, target: '_blank', rel: 'noopener noreferrer' },
          icon('external', 14),
          isKey ? 'Open the key page' : device ? 'Open the page' : 'Open the sign-in page',
        )
      : null;
    const codeBox = code
      ? h(
          'div',
          { class: 'signin-code' },
          h('span', { class: 'signin-code-label' }, 'Code'),
          h('code', { class: 'signin-code-value' }, code),
          h('button', { type: 'button', class: 'cmd-copy', 'aria-label': `Copy the code ${code}`, onclick: () => void copyText(code).then((ok) => shell.toast(ok ? 'success' : 'error', ok ? 'Code copied.' : 'Couldn’t copy — select the code instead.')) }, icon('copy', 13), 'Copy'),
        )
      : null;
    const stepTwoHelp =
      kind === 'code'
        ? 'Sign in, then copy the code Claude shows and paste it here.'
        : kind === 'redirect'
          ? 'After you approve, your browser opens a page that can’t load (“This site can’t be reached”, localhost). That’s expected — copy that page’s full address from the address bar and paste it here.'
          : kind === 'key'
            ? `Paste the key. The agent checks it with ${vendor} once, then keeps it on this server${where.agentDir ? ` (in ${where.agentDir})` : ''}. CAST never shows it again.`
            : l.allowEmpty
              ? `${asked?.text ?? ''}. You can leave it empty.`
              : (asked?.text ?? '');
    const answer = [
      l.prompt ? h('p', { class: 'signin-help' }, stepTwoHelp) : null,
      l.prompt && l.message ? h('div', { class: 'signin-result is-err', role: 'alert' }, icon('alert', 16), h('span', null, l.message)) : null,
      input
        ? h(
            'div',
            { class: 'signin-field' },
            input,
            h(
              'button',
              { type: 'button', class: 'btn btn-primary btn-sm', disabled: verifying, onclick: submitField },
              verifying ? h('span', { class: 'spinner spinner-sm' }) : null,
              verifying ? 'Checking…' : kind === 'key' ? 'Save key' : kind === 'redirect' || kind === 'code' ? 'Finish sign-in' : 'Continue',
            ),
          )
        : progress(
            verifying
              ? (l.message ?? (kind === 'key' ? `Checking the key with ${vendor}…` : `Finishing the sign-in with ${vendor}…`))
              : device
                ? `Waiting for you to approve on ${vendor}’s page…`
                : 'Waiting for the next step of the sign-in…',
          ),
    ];
    // A question before any page (an endpoint, a GitHub Enterprise domain, an e-mail address): one step.
    const steps = !l.url
      ? [step(1, 'Answer', answer)]
      : [
          step(1, isKey ? 'Get an API key' : device ? 'Open the page and enter the code' : 'Sign in and approve access', [
            l.instructions && (isKey || (!device && !code && meta?.kind !== 'browser')) ? h('p', { class: 'signin-help' }, l.instructions) : null,
            codeBox,
            open,
          ]),
          step(2, kind === 'key' ? 'Paste the key' : kind === 'code' ? 'Paste the code' : kind === 'redirect' ? 'Paste the address you land on' : device && !l.prompt ? 'Approve, then wait' : 'Answer', answer),
        ];
    return h('div', { class: 'signin' }, google.loginNote(l), h('ol', { class: 'signin-steps' }, steps), h('div', { class: 'signin-actions' }, timeLeft(l), cancel));
  }

  /** "14:05 left" until the server gives up on this sign-in, kept current by a one-second timer while it is on screen. */
  function timeLeft(l: LoginState): HTMLElement | null {
    if (loginDeadline?.loginId !== l.loginId) return null;
    const ms = loginDeadline.at - Date.now();
    countdown ??= setInterval(tickCountdown, 1000);
    return h(
      'span',
      { class: ['signin-timer', ms < 120_000 ? 'is-low' : null], role: 'timer', title: 'Time left to finish this sign-in' },
      icon('clock', 14),
      h('span', null, h('span', { class: 'signin-timer-left' }, clockText(ms)), ' left'),
    );
  }

  function tickCountdown() {
    const shown = content ? [...content.querySelectorAll<HTMLElement>('.signin-timer')] : [];
    if (!shown.length || !loginDeadline) {
      if (countdown) clearInterval(countdown);
      countdown = null;
      return;
    }
    const ms = loginDeadline.at - Date.now();
    for (const el of shown) {
      el.querySelector('.signin-timer-left')!.textContent = clockText(ms);
      el.classList.toggle('is-low', ms < 120_000);
    }
  }

  function whereNow(): Where {
    const hello = store.state.hello;
    return { agentDir: hello?.agentDir ?? null, runAs: hello?.runAs ?? null, agentBin: hello?.agents?.ompPath ?? null };
  }

  /** Everything a card needs from the page's state. */
  interface CardCtx {
    /** Some AI account is connected: then a model without a sign-in can't be used at all. */
    live: boolean;
    where: Where;
    paired: ReturnType<typeof pairUsage>;
    /** The sign-in running, if it shows on this card. */
    loginFor(match: (provider: string) => boolean): LoginState | null;
  }

  const orphansOf = (paired: ReturnType<typeof pairUsage>, keep: (u: AccountUsage) => boolean) => ((accounts || accountsErr) && !usageErr ? paired.orphans.filter(keep) : []);

  /** Paste API key on the Anthropic and OpenAI cards (Google's sits among its other ways in). */
  function keyOptions(v: Vendor, connected: boolean): HTMLElement | null {
    if (v === 'google' || !hasKeyPaste(v)) return null;
    const button = keys.button(v);
    const part = keys.box(v) ?? (button && h('div', { class: 'g-ways' }, button));
    if (!part) return null;
    return connected ? h('div', { class: 'g-connected' }, part) : part;
  }

  function vendorCard(p: ProviderStatus, models: ModelInfo[], ctx: CardCtx): HTMLElement {
    const cmds = CONNECT[p.vendor] ?? commandsFromHint(p.how);
    const signIn = SIGN_IN[p.vendor];
    const login = ctx.loginFor((provider) => loginVendor(provider) === p.vendor);
    const isGoogle = p.vendor === 'google';
    const manual = [manualHelp(ctx.where), ...cmds.map((c) => commandRow(agentCommand(c.cmd, ctx.where.agentBin), c.note))];
    const manualBox = h('details', { class: 'cmd-manual', open: manualOpen.has(p.vendor) }, h('summary', null, 'Or set it up by hand'), manual);
    manualBox.addEventListener('toggle', () => (manualBox.open ? manualOpen.add(p.vendor) : manualOpen.delete(p.vendor)));
    const c: CardAccounts = {
      card: p.vendor,
      title: VENDOR_LABEL[p.vendor],
      mine: (accounts ?? []).filter((a) => a.vendor === p.vendor),
      orphans: orphansOf(ctx.paired, (u) => u.vendor === p.vendor),
      paired: ctx.paired,
      vendor: p.vendor,
    };
    const busy = !!login && login.phase !== 'done';
    return h(
      'article',
      { class: ['vendor-card', p.connected ? 'is-connected' : 'is-off'], style: { '--vc': vendorColor(p.vendor) }, 'data-card': p.vendor },
      h(
        'header',
        { class: 'vendor-head' },
        h('span', { class: 'vendor-mark' }, p.label[0]),
        h('div', { class: 'vendor-titles' }, h('h3', null, p.label), models.length ? null : h('p', { class: 'muted small' }, p.connected ? 'Its models are listed under their makers' : 'Models appear once connected')),
        h('span', { class: ['conn-pill', p.connected ? 'is-on' : 'is-off'] }, h('span', { class: 'conn-dot' }), p.connected ? 'Connected' : 'Not connected'),
      ),
      cardParts(modelsPart(p.vendor, models, ctx.live), p.connected && (c.mine.length || c.orphans.length) ? usagePart(c) : null),
      p.connected ? accountsBlock(c, signIn, busy) : null,
      p.connected && (!login || login.phase === 'done') ? (isGoogle ? google.connectedOptions() : keyOptions(p.vendor, true)) : null,
      login
        ? h('div', { class: 'vendor-connect', 'data-signin-for': login.provider }, loginPanel(login))
        : p.connected
          ? null
          : h(
              'div',
              { class: 'vendor-connect' },
              signIn
                ? [
                    h(
                      'button',
                      // the sign-in's Cancel has the same focus key: it takes the focus over when this button goes
                      { type: 'button', class: 'btn btn-primary btn-sm signin-btn', 'data-focus-key': `signin:${signIn.provider}`, onclick: () => startLogin(signIn.provider) },
                      icon('key', 14),
                      signIn.label,
                    ),
                    isGoogle ? google.connectOptions() : keyOptions(p.vendor, false),
                    manualBox,
                  ]
                : [h('p', { class: 'field-label' }, 'How to connect'), manual],
            ),
    );
  }

  /** A signed-in provider without a featured card (GitHub Copilot, Cursor, Cerebras, a models.yml one): its accounts,
   *  usage and models, and the sign-in that connects it again. */
  function otherCard(o: OtherProvider, ctx: CardCtx): HTMLElement {
    const signIn = otherSignIn(o);
    const login = ctx.loginFor((provider) => !loginVendor(provider) && credentialProviderOf(provider) === o.provider);
    const card = `p:${o.provider}`;
    const c: CardAccounts = {
      card,
      title: o.label,
      mine: o.accounts,
      orphans: orphansOf(ctx.paired, (u) => u.provider === o.provider),
      paired: ctx.paired,
    };
    const busy = !!login && login.phase !== 'done';
    return h(
      'article',
      { class: 'vendor-card is-connected is-other', style: { '--vc': vendorColor('other') }, 'data-card': card },
      h(
        'header',
        { class: 'vendor-head' },
        h('span', { class: 'vendor-mark' }, (o.label.match(/[A-Za-z0-9]/)?.[0] ?? '·').toUpperCase()),
        h('div', { class: 'vendor-titles' }, h('h3', null, o.label), h('p', { class: 'muted small vendor-id' }, h('code', null, o.provider), o.models.length ? null : ' · no models')), // every model through it is in o.models: none to list (a search tool, a local server that isn't running)
        h('span', { class: 'conn-pill is-on' }, h('span', { class: 'conn-dot' }), 'Connected'),
      ),
      cardParts(modelsPart(card, o.models, ctx.live, false), c.mine.length || c.orphans.length ? usagePart(c) : null),
      // a model server from models.yml has no sign-in: it is edited on the Model servers card
      local.owns(o.provider) && !c.mine.length ? h('p', { class: 'acct-note' }, 'A model server on your network: edit or remove it under Model servers on your network.') : accountsBlock(c, signIn, busy),
      login ? h('div', { class: 'vendor-connect', 'data-signin-for': login.provider }, loginPanel(login)) : null,
    );
  }

  /** Where credentials live, what goes to providers and what stays, and how to take a sign-in away again. */
  function trustFoot(where: Where): HTMLElement {
    const line = (ic: string, ...body: Child[]) => h('li', null, icon(ic, 14), h('span', null, ...body));
    return h(
      'ul',
      { class: 'prov-foot' },
      // Why the lists are short (finding #73): the catalog is what CAST is tested with; connected accounts add the rest.
      line('sparkle', 'Before you connect, each vendor shows the few models CAST is tested with. Once an account is connected, every model it offers is listed too. Through OpenRouter, Claude, GPT, Gemini and DeepSeek models appear on those vendors’ cards (their ids start with ', h('code', null, 'openrouter/'), '); pick one of those to run on OpenRouter.'),
      line('key', 'Sign-ins and keys stay on this machine, in the agent’s folder ', h('code', null, where.agentDir ?? '~/.omp/agent (or $PI_CODING_AGENT_DIR)'),
        '. An API key pasted here is kept in CAST’s settings file (config.json in its data folder, readable only by the server’s user); a model server on your network, in the agent’s models.yml. Keys set in the CAST server’s environment work too, and win: restart the server, then press Refresh.'),
      line('send', 'What leaves this machine: your messages, and the files and command output people read while they work, go to the provider of that person’s model.'),
      line('exit', 'To remove one: Sign out on its card. A key from the environment: remove it there and restart CAST.'),
    );
  }

  const renderRefresh = () => {
    refreshBtn.disabled = refreshing;
    setChildren(refreshBtn, refreshing ? h('span', { class: 'spinner spinner-sm' }) : icon('refresh', 14), refreshing ? 'Checking…' : 'Refresh');
  };
  refreshBtn.addEventListener('click', () => {
    refreshing = true;
    renderRefresh();
    recheckAgents(shell);
    // the answer is a `models` push (onModels); a check on a busy computer can take a minute
    setTimeout(() => {
      if (refreshing) {
        refreshing = false;
        renderRefresh();
      }
    }, 75_000);
  });

  const copyBtn = (text: string) =>
    h('button', { type: 'button', class: 'link-btn', onclick: () => void copyText(text).then((ok) => shell.toast(ok ? 'success' : 'error', ok ? 'Copied — paste it in a terminal.' : 'Couldn’t copy — select the command instead.')) }, 'Copy');

  /** omp missing, the first account check running, or no check working: said above the cards, with the fix. */
  function healthNotice(st: Exclude<AgentsState, { kind: 'ok' }>, checking: boolean): HTMLElement {
    if (st.kind === 'checking') {
      return h('div', { class: 'prov-health' }, h('span', { class: 'spinner spinner-sm' }), h('div', null, h('p', { class: 'prov-health-title' }, 'Checking AI accounts…'), h('p', null, 'The agent is looking up who is signed in. On a busy computer this can take a minute; messages wait for it.')));
    }
    if (st.kind === 'omp-missing') {
      const guide = projectLinks();
      return h(
        'div',
        { class: 'prov-health is-error', role: 'alert' },
        icon('alert', 18),
        h(
          'div',
          null,
          h('p', { class: 'prov-health-title' }, 'The agent isn’t built'),
          h('p', null, `CAST runs every person through its agent (cast-agent) and couldn’t find it at ${st.path}. Build it in the CAST folder:`),
          h('p', null, h('code', null, AGENT_BUILD_COMMAND), ' ', copyBtn(AGENT_BUILD_COMMAND)),
          h('p', null, 'Then press Refresh. Using another build? Start CAST with ', h('code', null, 'CAST_AGENT_BIN=/path/to/cast-agent'), '.', guide ? [' ', h('a', { href: `${guide.home}#install`, target: '_blank', rel: 'noopener noreferrer' }, 'Install guide')] : null),
        ),
      );
    }
    return h(
      'div',
      { class: 'prov-health is-warn', role: 'status' },
      icon('alert', 18),
      h(
        'div',
        null,
        h('p', { class: 'prov-health-title' }, checking ? 'Checking AI accounts again…' : 'Couldn’t check your AI accounts'),
        h('p', null, `${sentenceStart(st.reason)}. Until a check works nothing counts as signed in, so nobody can work. CAST tries again by itself — or press Refresh.`),
      ),
    );
  }

  // Renders are coalesced: at most one per animation frame, and an answer that changes nothing the page shows (the
  // accounts, limits, order and omp settings it already has) draws nothing — opening the page settles at once instead
  // of being rebuilt for every answer (which also detached what a click was aimed at).
  let frame = 0;
  let shownSig = '';
  /** What the page shows that comes from the server or a request in flight. */
  const dataSig = () => {
    const s = store.state;
    return JSON.stringify([s.synced, s.providers, s.models, s.hello?.agents, accounts, accountsErr, accountsBusy, usage, usageErr, usageBusy, order.order, order.error, order.loading, google.sig(), local.sig(), login, whereNow()]);
  };
  /** Rebuild on the next frame (a user action, or several answers at once). */
  function render() {
    if (!content || frame) return;
    frame = requestAnimationFrame(() => {
      frame = 0;
      renderNow();
    });
  }
  /** Data arrived: rebuild only when the page would show something else. */
  function renderData() {
    if (!content || frame || dataSig() === shownSig) return;
    render();
  }

  function renderNow() {
    if (!content) return;
    if ([...editors.values()].some((e) => e.dragging)) {
      owedRender = true; // re-attaching the editor mid-drag would drop the drag
      return;
    }
    owedRender = false;
    // Rebuilding detaches the fields (the sign-in's paste field, the Google key and project fields, the list's search),
    // which a load finishing mid-typing would blur: keep focus and selection.
    const active = document.activeElement;
    const typing = active instanceof HTMLInputElement && content.contains(active) ? active : null;
    const sel = typing && ([typing.selectionStart, typing.selectionEnd, typing.selectionDirection ?? undefined] as const);
    tickers = [];
    const s = store.state;
    const featured = s.providers.filter((p) => p.vendor !== 'other');
    const vendors = VENDOR_ORDER.filter((v) => v !== 'other' && (s.providers.some((p) => p.vendor === v) || s.models.some((m) => m.vendor === v)));
    const providers = vendors.map(
      (v) => featured.find((p) => p.vendor === v) ?? { vendor: v, label: VENDOR_LABEL[v], connected: false, how: '' },
    );
    // every other signed-in provider: a card of its own (they replace the old "Other providers" card)
    const others = otherProviders(s.models, accounts ?? []);
    const cards = new Set(others.map((o) => o.provider));
    const connected = providers.filter((p) => p.connected).length + others.length;
    const total = providers.length + others.length;
    const paired = pairUsage(accounts ?? [], usage?.accounts ?? []);
    const where = whereNow();
    const health = agentsState(s.hello);
    const live = anyConnected(s.models);
    const running = login && login.phase !== 'cancelled' ? login : null;
    const ctx: CardCtx = { live, where, paired, loginFor: (match) => (running && match(running.provider) ? running : null) };

    setChildren(content,
      h(
        'p',
        { class: 'prov-intro' },
        'CAST runs each person with cast-agent, its open-source coding agent (based on ',
        h('a', { href: 'https://github.com/can1357/oh-my-pi', target: '_blank', rel: 'noopener noreferrer' }, 'omp'),
        '), on this machine. Sign in to a provider here (the agent keeps the sign-in), then pick its models for any role.',
      ),
      // omp or the account check first; then, with nothing connected (nobody can work), what to do — once the accounts
      // are known (before the first snapshot an empty list means "not here yet")
      health.kind !== 'ok'
        ? healthNotice(health, !!s.hello?.agents?.checking)
        : !s.synced
        ? h('p', { class: 'acct-note', role: 'status' }, h('span', { class: 'spinner spinner-sm', 'aria-hidden': 'true' }), 'Loading your AI accounts…')
        : connected === 0 && !live
        ? h(
            'div',
            { class: 'setup-banner' },
            h('span', { class: 'setup-banner-icon' }, icon('key', 18)),
            h(
              'div',
              null,
              h('p', { class: 'setup-banner-title' }, 'Connect an AI account to start'),
              h('p', null, 'The people here are AI agents: until CAST can reach a model, nobody can read, write or run anything. Sign in below with your Claude, ChatGPT or Google account, or use an API key — it stays on this machine.'),
            ),
          )
        : connected > 0
          ? h('p', { class: 'prov-summary' }, icon('checkCircle', 15), `${connected} of ${total} providers connected. Models without a sign-in can’t be used — sign in to use them.`)
          : null,
      h(
        'div',
        { class: 'vendor-grid' },
        providers.map((p) => vendorCard(p, s.models.filter((m) => m.vendor === p.vendor), ctx)),
        others.map((o) => otherCard(o, ctx)),
        local.el(),
      ),
      loginList.el({
        connected: connectedLogins(signedInProviders(s.models, accounts ?? [])),
        login: running,
        panel: loginPanel,
        homeOf: (id) => signInHome(id, cards),
      }),
      trustFoot(where),
    );
    if (typing?.isConnected && sel) {
      typing.focus({ preventScroll: true });
      typing.setSelectionRange(...sel);
    }
    const at = document.activeElement;
    // (focus on the dialog or a region around the page — where the focus guard leaves it when the pressed button went
    // away in a re-render — counts as nowhere in particular)
    if (freshField?.isConnected && !freshField.disabled && (!at || at === document.body || content.contains(at) || at.contains(content))) freshField.focus({ preventScroll: true });
    freshField = null;
    if (reveal) {
      // a sign-in started in the list for a provider with a card: its steps are on that card
      const panel = content.querySelector<HTMLElement>(`[data-signin-for="${CSS.escape(reveal)}"]`);
      if (panel && !panel.closest('.login-row')) panel.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
      if (panel || !login) reveal = null;
    }
    shownSig = dataSig();
    watchUsage();
  }

  /** A usage part is unfolded and on screen: now ask for the limits (and the account order, whose rows show them). */
  function wantUsage() {
    if (usageWanted || !modal) return;
    usageWanted = true;
    stopUsageWatch?.();
    stopUsageWatch = null;
    void loadUsage();
    void order.ensure();
    renderData();
  }

  /** (Re)watch the unfolded usage parts of what is drawn now (every render replaces the elements). Folded ones never
   *  ask: usage waits until one is unfolded. */
  function watchUsage() {
    stopUsageWatch?.();
    stopUsageWatch = null;
    if (usageWanted || !content) return;
    stopUsageWatch = whenSeen([...content.querySelectorAll('.usage-block.is-open')], wantUsage);
  }

  return {
    open() {
      if (modal) return;
      content = h('div', { class: 'providers' });
      usageWanted = false;
      renderNow();
      renderRefresh();
      void loadAccounts();
      google.open();
      local.open();
      offOrder = order.subscribe(() => renderData());
      ticker = setInterval(() => tickers.forEach((tick) => tick()), 30_000);
      modal = openModal(shell.root, shell.layers, {
        id: 'providers',
        className: 'modal-providers',
        title: 'Models & providers',
        // Each city is its own machine with its own omp sign-ins: with more than one city, say whose accounts these are.
        subtitle: ['Every model you can give a role. In the town, this is the Talent Agency building.', cityAccountsNote()],
        headerExtra: refreshBtn,
        body: content,
        onClose: () => {
          modal = null;
          content = null;
          stopUsageWatch?.();
          stopUsageWatch = null;
          stopHeadWatch?.();
          stopHeadWatch = null;
          usageWanted = false;
          if (frame) cancelAnimationFrame(frame);
          frame = 0;
          shownSig = '';
          tickers = [];
          if (ticker) clearInterval(ticker);
          ticker = null;
          if (modelsTimer) clearTimeout(modelsTimer);
          modelsTimer = null;
          offer = null;
          reveal = null;
          google.close();
          keys.close();
          local.close();
          offOrder?.();
          offOrder = null;
          editors.clear();
          if (login && (login.phase === 'done' || login.phase === 'failed')) login = null;
        },
      });
      watchUsage(); // now that the page is in the document
      const dialog = content?.closest<HTMLElement>('.modal');
      if (dialog) stopHeadWatch = watchTallHead(dialog);
    },
    /** A step of the running sign-in (broadcast by the server to every tab). */
    onLogin(l: LoginState) {
      if (l.phase === 'done') afterSignIn(l.provider); // whoever signed in: the accounts changed
      if (l.phase === 'cancelled') {
        if (login?.loginId === l.loginId) login = null;
      } else if (!login || login.loginId === l.loginId || l.phase === 'starting' || (!login.loginId && login.provider === l.provider)) {
        login = l; // a new sign-in (from this or another tab) takes over; updates of older attempts are ignored
        loginDeadline = l.timeLeftMs === undefined ? null : { loginId: l.loginId, at: Date.now() + l.timeLeftMs };
      } else {
        return;
      }
      render();
    },
    /** Models/providers changed (also after a sign-in or sign-out, here or elsewhere — even one cancelled while verifying). */
    onModels() {
      if (refreshing && !store.state.hello?.agents?.checking) {
        refreshing = false;
        renderRefresh();
      }
      renderData();
      if (!modal) return; // re-read when the page opens
      const seen = { accounts: accountsSeq, usage: usageSeq };
      if (modelsTimer) clearTimeout(modelsTimer);
      modelsTimer = setTimeout(() => {
        modelsTimer = null;
        if (!modal) return;
        if (accountsSeq === seen.accounts) void loadAccounts();
        if (usageSeq === seen.usage && usageWanted) void loadUsage();
      }, 1000);
    },
    get isOpen() {
      return !!modal;
    },
  };
}
