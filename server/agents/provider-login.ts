// Provider sign-in from the browser (Models & providers → Sign in). Runs `omp login <provider>` on this machine
// and relays it step by step: the page to open, then omp's prompt — the code Claude shows after approving (omp's
// redirect is set to Claude Code's code page, so the user's browser never has to reach this server), the final
// redirect URL after other OAuth sign-ins (the provider sends the user's browser to http://localhost:<port>/callback,
// which is this server, not their computer, so it can't load and the user pastes the address back), or an API key.
// omp stores the credential itself (~/.omp/agent). What the user pastes goes straight to omp's stdin and is never
// logged or echoed back.
// Every sign-in of omp's menu (shared/omp-login-providers.ts) runs through here, and only those: a browser sign-in
// (Claude's code or the redirect address pasted back), a device code (the page and the code to enter on it), an API key, and the flows
// that ask something first — an endpoint choice, an account ID, a GitHub Enterprise domain (may be blank), an e-mail
// address and the code sent to it. Prompts may come before the page or several in a row.
// A failure is read from omp's whole "Login failed: …" text (Google's reason is a JSON body on the lines after it) and
// said in plain words where CAST knows the case (google-auth.ts for Google's refusals, login-failure.ts for every
// provider); omp's own words stay under "Details", redacted, and the whole reason goes to the log (redacted).
// A sign-in gives up after CAST_LOGIN_TIMEOUT seconds (default 15 minutes) and says so; omp's own wait for the browser
// is set a minute longer, so CAST's deadline — the one the page counts down — is the one that ends it.
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { isLoginProvider } from '../../shared/omp-logins';
import type { LoginState } from '../../shared/protocol';
import { explainGoogleLogin, redactSecrets } from './google-auth';
import { trackGroup } from '../child-groups';
import { explainLoginFailure } from './login-failure';
import { envSetting } from './omp-check';
import { log } from './util';

const DEFAULT_TIMEOUT_S = 15 * 60;
export const TIMED_OUT = 'This sign-in timed out — start again.';
/** Claude Code's manual redirect for the same OAuth client: the page shows a `code#state` to copy. */
export const CLAUDE_CODE_PAGE = 'https://platform.claude.com/oauth/code/callback';
const ANSI = /\x1b\[[0-9;?]*[A-Za-z]/g;
/** A line ending in ":" with nothing after it is a prompt only once omp has stopped writing for this long (a chunk may
 *  end in the middle of "Enter code: ABCD-1234"). */
const PROMPT_SETTLE_MS = 60;
/** omp's status lines ("Waiting for device authorization...", "Validating API key…"). */
const PROGRESS = /(?:\.\.\.|…)$/;
/** The prompt may be answered with nothing: omp says it is optional, what a blank answer means, or offers a default. */
const OPTIONAL = /\boptional\b|\bblank\b|leave (?:it )?empty|\(default\)/i;
/** The code a device sign-in asks for, in omp's instructions or status ("Enter code: ABCD-1234", "(code: ABCD-1234)"). */
const USER_CODE = /\bcode:\s*([A-Za-z0-9][A-Za-z0-9-]{3,})/i;

interface Active {
  state: LoginState;
  child: ChildProcessWithoutNullStreams;
  out: string; // stdout not yet split into lines (a prompt has no trailing newline)
  err: string;
  reading: 'text' | 'url' | 'instructions';
  submitted: boolean; // input was sent and no prompt came since
  answered?: string; // the prompt that input answered: the same one again means omp rejected it (no code in it)
  settle?: ReturnType<typeof setTimeout>; // a prompt-looking tail waiting for omp to stop writing
  loggedIn?: string;
  noCredentials?: string;
  timer: ReturnType<typeof setTimeout>;
  deadline: number; // Date.now() at which the timer fires
  done: boolean;
}

export interface ProviderLoginOptions {
  ompBin: string;
  env: Record<string, string | undefined>;
  emit: (state: LoginState) => void;
  /** omp stored a credential: re-detect models (people on that provider can work). */
  onConnected: (provider: string) => Promise<void>;
  /** How long omp must be quiet before a line ending in ":" counts as its prompt (default PROMPT_SETTLE_MS). */
  promptSettleMs?: number;
}

export class ProviderLogin {
  #active: Active | null = null;
  #seq = 0;

  constructor(private readonly o: ProviderLoginOptions) {}

  /** A sign-in is running (omp may be writing its store right now). */
  get active(): boolean {
    return !!this.#active && !this.#active.done;
  }

  /** Only one sign-in at a time: some providers use a fixed callback port. A new one cancels the previous. A provider
   *  omp's menu doesn't have never reaches omp's command line (the message validator refuses it already). */
  start(provider: string): void {
    if (this.#active) this.#finish(this.#active, 'cancelled', 'Another sign-in was started.');
    const loginId = `login-${Date.now().toString(36)}-${++this.#seq}`;
    if (!isLoginProvider(provider)) {
      log('login', `refused an unknown sign-in ${JSON.stringify(provider.slice(0, 64))}`);
      this.o.emit({ loginId, provider, phase: 'failed', message: 'The agent has no sign-in by that name. Pick one from the list in Models & providers.' });
      return;
    }
    // The Cloud project omp will use for this Google sign-in (the server's env or config.json ompEnv, see omp-env.ts).
    const project = provider === 'google-gemini-cli' ? this.o.env.GOOGLE_CLOUD_PROJECT?.trim() || this.o.env.GOOGLE_CLOUD_PROJECT_ID?.trim() || undefined : undefined;
    const timeoutMs = loginTimeoutMs(this.o.env);
    const child = spawn(this.o.ompBin, ['login', provider], {
      cwd: this.o.env.HOME ?? '/',
      env: {
        ...this.o.env,
        NO_COLOR: '1',
        PI_OAUTH_CALLBACK_TIMEOUT_MS: String(timeoutMs + 60_000),
        ...(provider === 'anthropic' ? { ANTHROPIC_OAUTH_REDIRECT_URI: CLAUDE_CODE_PAGE } : {}),
      } as NodeJS.ProcessEnv,
      stdio: 'pipe',
      detached: true, // own process group, so cancel also stops anything omp started
    });
    const untrack = trackGroup(child.pid);
    child.once('exit', untrack);
    child.once('error', untrack);
    const a: Active = {
      state: { loginId, provider, phase: 'starting', ...(project ? { project } : {}) },
      child,
      out: '',
      err: '',
      reading: 'text',
      submitted: false,
      timer: setTimeout(() => this.#finish(a, 'failed', TIMED_OUT, { timedOut: true }), timeoutMs),
      deadline: Date.now() + timeoutMs,
      done: false,
    };
    this.#active = a;
    log('login', `${provider}: started`);
    this.#emit(a);

    child.stdout.on('data', (chunk: Buffer) => this.#onStdout(a, chunk.toString('utf8')));
    child.stderr.on('data', (chunk: Buffer) => {
      a.err = (a.err + chunk.toString('utf8').replace(ANSI, '')).slice(-4000);
    });
    child.stdin.on('error', () => {}); // omp may exit before we write
    child.on('error', (err) => this.#finish(a, 'failed', `Could not run the agent: ${err.message}`));
    child.on('close', (code) => void this.#onExit(a, code));
  }

  /** The pasted redirect URL / code, or the API key. Returns false when that sign-in is no longer waiting. */
  input(loginId: string, value: string): boolean {
    const a = this.#active;
    if (!a || a.done || a.state.loginId !== loginId || !a.state.prompt) return false;
    a.child.stdin.write(`${value.replace(/[\r\n]+/g, '').trim()}\n`);
    a.submitted = true;
    a.answered = a.state.prompt;
    a.state = { ...a.state, phase: 'verifying', prompt: undefined, secret: undefined, allowEmpty: undefined, message: undefined, progress: undefined };
    this.#emit(a);
    return true;
  }

  cancel(loginId: string): void {
    const a = this.#active;
    if (a && a.state.loginId === loginId) this.#finish(a, 'cancelled');
  }

  shutdown(): void {
    if (this.#active) this.#finish(this.#active, 'cancelled', 'The server is shutting down.');
  }

  #onStdout(a: Active, text: string) {
    if (a.done) return;
    if (a.settle) clearTimeout(a.settle);
    a.settle = undefined;
    a.out += text.replace(ANSI, '');
    let nl: number;
    while ((nl = a.out.indexOf('\n')) >= 0) {
      const line = a.out.slice(0, nl).replace(/\r$/, '');
      a.out = a.out.slice(nl + 1);
      this.#onLine(a, line);
    }
    // omp's prompts end with ": " and no newline — once it stops writing, that's the moment it waits for us.
    const tail = a.out.trim();
    if (tail.endsWith(':') && !tail.startsWith('http') && !/^Open this URL/i.test(tail)) {
      a.settle = setTimeout(() => {
        a.settle = undefined;
        if (!a.done && a.out.trim() === tail) this.#onPrompt(a, tail.slice(0, -1).trim());
      }, this.o.promptSettleMs ?? PROMPT_SETTLE_MS);
    }
  }

  #onPrompt(a: Active, prompt: string) {
    a.out = '';
    const secret = /api key|token|secret|password/i.test(prompt);
    // the very prompt just answered, again: omp didn't take the answer (it loops until the pasted address has a code)
    const again = a.submitted && a.answered === prompt;
    const retry = !again
      ? undefined
      : a.state.pasteCode
        ? 'That code didn’t match this sign-in. Copy the code from the newest sign-in tab and paste it again.'
        : /redirect|authorization code/i.test(prompt)
          ? 'That didn’t match this sign-in. Paste the full address of the page you reached after approving in the newest sign-in tab — it contains code= and state=.'
          : 'The agent didn’t take that answer. Check it and try again.';
    a.submitted = false;
    a.state = { ...a.state, phase: 'waiting', prompt, secret, allowEmpty: OPTIONAL.test(prompt) || undefined, message: retry, progress: undefined };
    this.#emit(a);
  }

  #onLine(a: Active, raw: string) {
    const line = raw.trim();
    if (a.reading === 'url') {
      if (/^https?:\/\//.test(line)) {
        // a new page (a second one after an earlier prompt): its own instructions follow
        a.state = { ...a.state, url: line, instructions: undefined, userCode: undefined, pasteCode: redirectOf(line) === CLAUDE_CODE_PAGE || undefined };
        a.reading = 'instructions';
      }
      return;
    }
    if (a.reading === 'instructions') {
      if (!line) {
        a.reading = 'text';
        // the page is open to the user now; a prompt may follow (a key, the redirect address) or omp just waits
        if (a.state.phase === 'starting' || (a.state.phase === 'verifying' && !a.state.prompt)) a.state = { ...a.state, phase: 'waiting', progress: undefined };
        this.#emit(a);
      } else if (!/^Local shortcut/i.test(line)) {
        const instructions = a.state.instructions ? `${a.state.instructions} ${line}` : line;
        const code = USER_CODE.exec(line)?.[1];
        a.state = { ...a.state, instructions, ...(code ? { userCode: code } : {}) };
      }
      return;
    }
    if (/^Open this URL in your browser:?$/i.test(line)) a.reading = 'url';
    else if (/^Logged in to /.test(line)) a.loggedIn = line;
    else if (/^No credentials were stored/i.test(line)) a.noCredentials = line;
    else if (PROGRESS.test(line) && line.length <= 200 && a.state.phase !== 'done') {
      const code = a.state.userCode ? undefined : USER_CODE.exec(line)?.[1];
      a.state = { ...a.state, progress: line, ...(code ? { userCode: code } : {}) };
      this.#emit(a);
    }
  }

  async #onExit(a: Active, code: number | null) {
    if (a.done) return;
    if (code === 0 && a.loggedIn) {
      a.state = { ...a.state, phase: 'verifying', prompt: undefined, secret: undefined, allowEmpty: undefined, progress: undefined, message: 'Signed in — loading models…' };
      this.#emit(a);
      try {
        await this.o.onConnected(a.state.provider);
      } catch (err) {
        log('login', `${a.state.provider}: model refresh after sign-in failed`, err);
      }
      this.#finish(a, 'done', a.loggedIn);
      return;
    }
    if (code === 0) {
      this.#finish(a, 'failed', a.noCredentials ?? 'No credentials were stored.');
      return;
    }
    const reason = /Login failed:\s*([\s\S]+)/.exec(a.err)?.[1]?.trim();
    if (!reason) {
      // omp died some other way (a crash, a signal): what it printed last is all there is to go by
      const tail = redactSecrets(a.err.trim().split('\n').slice(-12).join('\n'));
      if (tail) log('login', `${a.state.provider}: the agent said: ${tail.replace(/\s+/g, ' ').slice(0, 2000)}`);
      // …unless those lines are a failure CAST knows (the callback port taken, the network down)
      const known = tail ? explainLoginFailure(a.state.provider, tail) : null;
      this.#finish(a, 'failed', known ?? `cast-agent login stopped with ${code === null ? 'a signal' : `exit code ${code}`} before the sign-in finished. Try again.`, tail ? { details: tail } : undefined);
      return;
    }
    // omp gave up waiting for the browser (an agent without PI_OAUTH_CALLBACK_TIMEOUT_MS, or a host clock jump)
    if (/OAuth callback cancelled: TimeoutError/.test(reason)) {
      this.#finish(a, 'failed', TIMED_OUT, { timedOut: true });
      return;
    }
    const failure = describeLoginFailure(a.state.provider, reason, a.state.project);
    log('login', `${a.state.provider}: the agent said: ${(failure.details ?? redactSecrets(reason)).replace(/\s+/g, ' ').slice(0, 2000)}`);
    this.#finish(a, 'failed', failure.message, failure);
  }

  #finish(a: Active, phase: 'done' | 'failed' | 'cancelled', message?: string, extra?: Pick<LoginState, 'fix' | 'link' | 'details' | 'timedOut'>) {
    if (a.done) return;
    a.done = true;
    clearTimeout(a.timer);
    if (a.settle) clearTimeout(a.settle);
    if (this.#active === a) this.#active = null;
    if (a.child.exitCode === null && a.child.signalCode === null) {
      killGroup(a.child, 'SIGTERM');
      setTimeout(() => killGroup(a.child, 'SIGKILL'), 2000).unref();
    }
    a.state = { ...a.state, phase, prompt: undefined, secret: undefined, allowEmpty: undefined, progress: undefined, message, ...(extra?.fix ? { fix: extra.fix } : {}), ...(extra?.link ? { link: extra.link } : {}), ...(extra?.details ? { details: extra.details } : {}), ...(extra?.timedOut ? { timedOut: true } : {}) };
    log('login', `${a.state.provider}: ${phase}${phase === 'failed' && message ? ` — ${message}` : ''}`);
    this.#emit(a);
  }

  /** A copy of the state (the listener may keep it), with the time left while the sign-in still runs. */
  #emit(a: Active) {
    this.o.emit(a.done ? { ...a.state } : { ...a.state, timeLeftMs: Math.max(0, a.deadline - Date.now()) });
  }
}

/** CAST_LOGIN_TIMEOUT (seconds), else 15 minutes. */
function loginTimeoutMs(env: Record<string, string | undefined>): number {
  const s = Number(envSetting(env, 'LOGIN_TIMEOUT'));
  return (Number.isFinite(s) && s > 0 ? s : DEFAULT_TIMEOUT_S) * 1000;
}

/** The redirect_uri an OAuth page sends the browser back to ('' when the URL has none). */
function redirectOf(url: string): string {
  try {
    return new URL(url).searchParams.get('redirect_uri') ?? '';
  } catch {
    return '';
  }
}

function killGroup(child: ChildProcessWithoutNullStreams, sig: NodeJS.Signals) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  try {
    if (child.pid) process.kill(-child.pid, sig);
  } catch {
    child.kill(sig);
  }
}

/** What a failed sign-in says: plain words (Google's refusals from google-auth.ts, every provider's common cases from
 *  login-failure.ts, else omp's first line), the fix the app can offer, and omp's whole text (redacted) when the words
 *  leave something out. */
export function describeLoginFailure(provider: string, reason: string, project?: string): Pick<LoginState, 'message' | 'fix' | 'link' | 'details'> {
  const google = provider.startsWith('google-') ? explainGoogleLogin(reason, project) : null;
  // Only Sign in with Google reads GOOGLE_CLOUD_PROJECT: Antigravity finds its project by itself.
  if (google && provider !== 'google-gemini-cli') delete google.fix;
  const message = google?.message ?? explainLoginFailure(provider, reason) ?? redactSecrets(reason.split('\n')[0]!.trim());
  const details = redactSecrets(reason);
  return { ...google, message, ...(details !== message ? { details } : {}) };
}
