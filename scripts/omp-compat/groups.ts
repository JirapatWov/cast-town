// The checks, grouped by the omp process they run in. Each check names the CAST code that relies on the behaviour.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { deflateSync } from 'node:zlib';
import { T, type Report, type Spec } from './checks';
import type { MockLlm, MockRequest } from './mock-llm';
import { castArgs, Omp, type CastSpec, type Frame } from './omp-rpc';

export interface HostToolDef {
  name: string;
  label?: string;
  description: string;
  parameters: Record<string, unknown>;
  loadMode?: 'essential' | 'discoverable';
}

export interface Ctx {
  bin: string;
  work: string;
  project: string;
  extDir: string;
  logs: string;
  env: Record<string, string>;
  emptyAgentEnv: Record<string, string>;
  mock: MockLlm;
  r: Report;
  leadTools: HostToolDef[];
  leadOverlay: string;
  advisorOverlay: string;
  persona: string;
  /** Handed from the lead group to the resume group. */
  lead: { sessionDir?: string; sessionFile?: string; goalObjective?: string; marker?: string };
}

/** The flags CAST passes (process-pool.ts, provider-accounts.ts) — `omp --help` must still list them. */
const CAST_FLAGS = ['--mode', '--model', '--approval-mode', '--append-system-prompt', '--session-dir', '--no-title', '--thinking', '--extension', '--config', '--resume', '--no-session', '--no-tools'];

const RESPONSE_OK = (command: string): Spec => ({ type: 'response', command, success: true });
const isUser = (f: Frame) => f.type === 'message_start' && f.message?.role === 'user';
const isAssistantEnd = (f: Frame) => f.type === 'message_end' && f.message?.role === 'assistant';
const contentText = (c: unknown): string =>
  typeof c === 'string' ? c : Array.isArray(c) ? c.filter((b: { type?: string }) => b?.type === 'text').map((b: { text?: string }) => b.text ?? '').join('\n') : '';
const textOfEnd = (f: Frame | undefined): string => (f ? contentText(f.message?.content) : '');
const toolText = (f: Frame | undefined): string => contentText(f?.result?.content);
const sleep = (ms: number) => Bun.sleep(ms);

/** A small valid PNG (w×h RGB gradient), base64 — what a browser upload looks like to CAST. */
function pngBase64(w = 64, h = 48): string {
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(Bun.hash.crc32(td) >>> 0);
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr.set([8, 2, 0, 0, 0], 8); // 8-bit RGB
  const rows: number[] = [];
  for (let y = 0; y < h; y++) {
    rows.push(0);
    for (let x = 0; x < w; x++) rows.push((x * 4) & 255, (y * 5) & 255, 128);
  }
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  return Buffer.concat([sig, chunk('IHDR', ihdr), chunk('IDAT', deflateSync(Buffer.from(rows))), chunk('IEND', Buffer.alloc(0))]).toString('base64');
}

async function run(cmd: string[], env: Record<string, string>, cwd: string, timeoutMs = 60_000): Promise<{ code: number | null; out: string; err: string; ms: number }> {
  const t0 = Date.now();
  const p = Bun.spawn(cmd, { env, cwd, stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' });
  const timer = setTimeout(() => p.kill('SIGKILL'), timeoutMs);
  const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
  clearTimeout(timer);
  return { code, out, err, ms: Date.now() - t0 };
}

/** Run one check body; a thrown error (usually a timeout) is a FAIL and the group goes on. */
async function step(c: Ctx, name: string, body: () => Promise<void>, o?: Omp): Promise<boolean> {
  if (o?.wedged || (o && o.exitCode !== null)) {
    c.r.fail(name, 'the scenario runs', o.wedged ? 'skipped: omp stopped answering after an earlier failure' : `skipped: omp exited (${o.exitCode})`);
    return false;
  }
  try {
    await body();
    return true;
  } catch (err) {
    c.r.fail(name, 'the scenario runs to the end', err instanceof Error ? err.message : String(err));
    if (o?.alive) await recover(o);
    return false;
  }
}

/** After a failed step: close open dialogs and stop whatever omp is doing (as CAST's Stop does) so the next step
 *  starts from idle. An omp that doesn't answer the abort is marked wedged. */
async function recover(o: Omp) {
  o.uiHook = undefined;
  o.hostHook = undefined;
  for (const id of [...o.openDialogs.keys()]) o.respondUi(id, { cancelled: true });
  const m = o.mark();
  const r = await o.request({ type: 'abort_and_restore_queue' }, 15_000).catch(() => null);
  if (!r) o.wedged = true;
  else await o.settled(m, 5000).catch(() => {});
}

/** Spawn like CAST's ProcessPool and run its boot sequence, checking every answer. Returns get_state's data. */
async function bootLikeCast(c: Ctx, o: Omp, opts: { hostTools?: HostToolDef[]; model: string }): Promise<any> {
  const t0 = Date.now();
  await o.start();
  c.r.ok('spawn → ready frame (CAST waits ≤ 45 s)', o.readyAt <= 45_000, 'ready ≤ 45 s', `ready after ${o.readyAt} ms`);
  c.r.shape('negotiate_protocol v2', await o.request({ type: 'negotiate_protocol', protocolVersion: 2 }), RESPONSE_OK('negotiate_protocol'));
  c.r.shape('set_event_filter {events:null, messageUpdates:"delta"}', await o.request({ type: 'set_event_filter', events: null, messageUpdates: 'delta' }), RESPONSE_OK('set_event_filter'));
  c.r.shape('set_subagent_subscription {level:"progress"}', await o.request({ type: 'set_subagent_subscription', level: 'progress' }), RESPONSE_OK('set_subagent_subscription'));
  c.r.shape('set_ask_dialog {enabled:true}', await o.request({ type: 'set_ask_dialog', enabled: true }), RESPONSE_OK('set_ask_dialog'));
  c.r.shape('set_interrupt_mode {mode:"wait"}', await o.request({ type: 'set_interrupt_mode', mode: 'wait' }), RESPONSE_OK('set_interrupt_mode'));
  if (opts.hostTools?.length) {
    c.r.shape(`set_host_tools (CAST's ${opts.hostTools.length} lead tools, loadMode essential)`, await o.request({ type: 'set_host_tools', tools: opts.hostTools }), RESPONSE_OK('set_host_tools'));
  }
  const st = await o.request({ type: 'get_state' }, 20_000);
  const [provider, id] = [opts.model.slice(0, opts.model.indexOf('/')), opts.model.slice(opts.model.indexOf('/') + 1)];
  c.r.shape('get_state: exactly the requested model + sessionFile + contextUsage (strict model check)', st, {
    success: true,
    data: { model: { provider, id }, sessionFile: T.absJsonl, contextUsage: { tokens: T.num, contextWindow: T.pos, percent: T.num } },
  });
  c.r.note(`boot: ready after ${o.readyAt} ms, boot sequence done after ${Date.now() - t0} ms`);
  return st.data;
}

// ───────────────────────────────────────────────────────────────── cli ──
export async function cliGroup(c: Ctx): Promise<{ version?: string }> {
  c.r.group = 'cli';
  let version: string | undefined;
  await step(c, '--version', async () => {
    const v = await run([c.bin, '--version'], c.env, c.project, 30_000);
    // models.ts detectOmpVersion: first N.N.N in stdout
    version = v.out.trim().match(/(\d+\.\d+\.\d+\S*)/)?.[1];
    c.r.ok('--version exits 0 and stdout has N.N.N (models.ts detectOmpVersion)', v.code === 0 && !!version, 'exit 0, stdout like "omp/18.13.2"', `exit ${v.code}, stdout ${JSON.stringify(v.out.trim().slice(0, 80))}`);
  });
  await step(c, '--help', async () => {
    const h = await run([c.bin, '--help'], c.env, c.project, 30_000);
    const missing = CAST_FLAGS.filter((f) => !new RegExp(`${f}\\b`).test(h.out));
    c.r.ok('--help lists every flag CAST passes', h.code === 0 && missing.length === 0, CAST_FLAGS.join(' '), missing.length ? `missing: ${missing.join(' ')} (exit ${h.code})` : `all present (exit ${h.code})`);
    c.r.ok('--mode offers rpc-ui', /rpc-ui/.test(h.out), '"rpc-ui" in --mode help', /rpc-ui/.test(h.out) ? 'present' : 'absent');
    const modes = ['always-ask', 'write', 'yolo'].filter((m) => !h.out.includes(m));
    c.r.ok('--approval-mode offers always-ask|write|yolo (CAST ApprovalMode, auto → always-ask)', modes.length === 0, 'always-ask, write, yolo', modes.length ? `missing: ${modes.join(', ')}` : 'all present');
  });
  await step(c, 'models --json', async () => {
    const m = await run([c.bin, 'models', '--json'], c.env, c.project, 60_000);
    let json: any;
    try {
      json = JSON.parse(m.out);
    } catch {
      json = m.out.slice(0, 200);
    }
    const model: Spec = {
      provider: T.nonEmpty,
      id: T.nonEmpty,
      selector: T.nonEmpty,
      name: T.str,
      contextWindow: T.pos,
      maxTokens: T.pos,
      reasoning: T.bool,
      input: T.arr(T.oneOf('text', 'image'), 1),
      cost: { input: T.num, output: T.num, cacheRead: T.num, cacheWrite: T.num },
    };
    c.r.shape(`models --json → {models:[…]} (models.ts OmpModelEntry; exit ${m.code}, ${m.ms} ms)`, json, { models: T.arr(model, 1) });
    const a = json?.models?.find?.((x: any) => x.selector === 'mockp/mock-a');
    const t = json?.models?.find?.((x: any) => x.selector === 'mockp/mock-t');
    c.r.shape('models --json: a reasoning model has its thinking ladder (models.ts ladder())', a, { reasoning: true, thinking: T.arr(T.oneOf('minimal', 'low', 'medium', 'high', 'xhigh', 'max'), 2), input: T.some('image') });
    c.r.shape('models --json: input says which models take images (models.ts takesImages())', t, { input: T.not(T.some('image')) });
  });
  await step(c, 'login --help', async () => {
    const h = await run([c.bin, 'login', '--help'], c.env, c.project, 30_000);
    c.r.ok('login --help: `omp login [PROVIDER]` (provider-login.ts runs `omp login <provider>`)', h.code === 0 && /omp login \[PROVIDER\]/i.test(h.out), 'exit 0, usage "omp login [PROVIDER]"', `exit ${h.code}, ${JSON.stringify(h.out.trim().split('\n').slice(0, 4).join(' | ').slice(0, 160))}`);
  });
  await step(c, 'usage --help', async () => {
    const h = await run([c.bin, 'usage', '--help'], c.env, c.project, 30_000);
    const ok = h.code === 0 && /--json/.test(h.out) && /invalidate/.test(h.out);
    c.r.ok('usage --help: --json flag and the invalidate action (provider-accounts.ts)', ok, 'exit 0, "--json" and "invalidate"', `exit ${h.code}, --json ${/--json/.test(h.out)}, invalidate ${/invalidate/.test(h.out)}`);
  });
  return { version };
}

// ──────────────────────────────────────────────────────────── accounts ──
export async function accountsGroup(c: Ctx) {
  c.r.group = 'accounts';
  // provider-accounts.ts: a short-lived rpc-ui omp with these args (no protocol negotiation) for get_logout_accounts.
  const o = new Omp('accounts', { bin: c.bin, cwd: c.env.HOME!, args: ['--no-session', '--no-tools', '--no-title'], env: { ...c.env, NO_COLOR: '1' }, logDir: c.logs });
  await step(
    c,
    'get_logout_accounts',
    async () => {
      await o.start(30_000);
      c.r.ok('rpc-ui --no-session --no-tools --no-title → ready', true, 'ready', `ready after ${o.readyAt} ms`);
      const r = await o.request({ type: 'get_logout_accounts', providerId: 'anthropic' }, 15_000);
      c.r.shape('get_logout_accounts {providerId} → data.accounts[] (provider-accounts.ts #accountsOf)', r, { success: true, data: { accounts: T.arr() } });
    },
    o,
  );
  await o.stop(1000);
  await step(c, 'no credentials', async () => {
    const e = new Omp('accounts-empty', { bin: c.bin, cwd: c.env.HOME!, args: ['--no-session', '--no-tools', '--no-title'], env: { ...c.emptyAgentEnv, NO_COLOR: '1' }, logDir: c.logs });
    let started = false;
    try {
      await e.start(30_000);
      started = true;
    } catch {
      /* expected */
    }
    await e.stop(500);
    const re = /No default model selected|No model available matching enabledModels|No models available/i;
    c.r.ok('store without credentials: rpc-ui exits before ready with a message CAST recognises (NO_CREDENTIALS)', !started && re.test(e.stderr), `exit before ready, stderr ~ ${re}`, `${started ? 'became ready' : `exited ${e.exitCode}`}; stderr ${JSON.stringify(e.stderr.trim().slice(-160))}`);
  });
}

// ──────────────────────────────────────────────────────────────── lead ──
export async function leadGroup(c: Ctx) {
  c.r.group = 'lead';
  const sessionDir = join(c.work, 'sessions', 'lead');
  const spec: CastSpec = { model: 'mockp/mock-a', approvalMode: 'write', systemPrompt: c.persona, sessionDir, thinking: 'medium', extensionDir: c.extDir, configFile: c.leadOverlay };
  const o = new Omp('lead', { bin: c.bin, cwd: c.project, args: castArgs(spec), env: c.env, logDir: c.logs });
  c.lead.sessionDir = sessionDir;
  try {
    const ok = await step(c, 'boot', async () => void (await bootLikeCast(c, o, { hostTools: c.leadTools, model: spec.model })), o);
    if (!ok) return;
    await leadChat(c, o);
    await leadApprovals(c, o);
    await leadHostTools(c, o);
    await leadQueue(c, o);
    await leadSubagents(c, o);
    await leadGoal(c, o);
    await leadSessions(c, o);
    await step(c, 'graceful stop', async () => {
      const s = await o.stop(3000);
      c.r.ok('closing stdin ends omp (exit 0) before CAST sends SIGTERM (omp-process.ts stop())', s.graceful && o.exitCode === 0, 'exit code 0 within 3 s', `exit ${o.exitCode}${o.exitSignal ? ` ${o.exitSignal}` : ''} after ${s.ms} ms`);
    });
  } finally {
    await o.stop(1000);
  }
}

async function leadChat(c: Ctx, o: Omp) {
  await step(
    c,
    'chat turn',
    async () => {
      const m = o.mark();
      const q = c.mock.requests.length;
      const ack = await o.prompt('p-hello', 'THINK Say hello-compat');
      c.r.shape('prompt {streamingBehavior:"followUp"} while idle → ack (omp-process.ts prompt())', ack, RESPONSE_OK('prompt'));
      c.r.ok('ack does not say agentInvoked:false', ack.data?.agentInvoked !== false, 'data.agentInvoked !== false', ack.data);
      const pr = await o.promptResult('p-hello', m);
      await o.settled(m);
      const fs = o.since(m);
      const user = fs.find(isUser);
      c.r.shape('user message_start = delivery (normalize.ts user_message)', user, { message: { role: 'user', content: T.pred('text containing "hello-compat"', (v) => contentText(v).includes('hello-compat')) } });
      c.r.ok('user message_start is not marked synthetic', user?.message?.synthetic !== true, 'message.synthetic !== true', user?.message?.synthetic);
      const start = fs.find((f) => f.type === 'message_start' && f.message?.role === 'assistant');
      c.r.shape('assistant message_start carries messageId (normalize.ts #msgKey)', start, { messageId: T.pred('string|number', (v) => typeof v === 'string' || typeof v === 'number') });
      const updates = fs.filter((f) => f.type === 'message_update');
      const ev = updates.map((f) => f.assistantMessageEvent);
      c.r.shape('message_update.assistantMessageEvent text_delta {delta:string} (delta mode)', ev.find((e) => e?.type === 'text_delta'), { type: 'text_delta', delta: T.str });
      c.r.shape('message_update.assistantMessageEvent thinking_delta {delta:string} (--thinking)', ev.find((e) => e?.type === 'thinking_delta'), { type: 'thinking_delta', delta: T.str });
      const end = fs.find(isAssistantEnd);
      const finalText = textOfEnd(end);
      const streamed = ev.filter((e) => e?.type === 'text_delta').map((e) => e.delta).join('');
      c.r.ok('text_deltas add up to message_end text (FrameNormalizer assembly)', streamed === finalText && finalText.length > 0, JSON.stringify(finalText), JSON.stringify(streamed));
      c.r.shape('assistant message_end: content, usage, stopReason, provider, model (normalize.ts #messageEnd)', end, {
        message: {
          role: 'assistant',
          content: T.some({ type: 'text', text: T.has('hello-compat') }),
          usage: { input: T.num, output: T.num, cacheRead: T.opt(T.num), cost: { total: T.pos } },
          stopReason: 'stop',
          provider: 'mockp',
          model: 'mock-a',
        },
      });
      c.r.shape('message_end thinking block {type:"thinking", thinking}', end?.message?.content, T.some({ type: 'thinking', thinking: T.nonEmpty }));
      const order = ['agent_start', 'agent_end', 'prompt_result', 'session_settled'].map((t) => fs.findIndex((f) => f.type === t));
      c.r.ok('agent_start → agent_end → prompt_result → session_settled', order.every((i, k) => i >= 0 && (k === 0 || i > order[k - 1]!)), 'all four, in that order', `indexes ${order.join(', ')}`);
      c.r.shape('prompt_result (normalize.ts prompt_result)', pr, { type: 'prompt_result', id: 'p-hello', status: 'completed', sessionSettled: T.bool });
      const main = c.mock.since(q).find((x) => x.caller === 'main');
      c.r.ok('--append-system-prompt text reaches the model', !!main?.system.includes('[rlt-role:assistant]'), 'system prompt contains the persona marker', main ? 'mock saw a main request without it' : 'no main request seen');
      c.r.ok('--thinking medium reaches the provider (reasoning_effort)', main?.reasoningEffort === 'medium', 'reasoning_effort "medium"', String(main?.reasoningEffort));
      const last = await o.request({ type: 'get_last_assistant_text' }, 5000);
      c.r.shape('get_last_assistant_text → {text} (agent-runtime.ts lastText)', last, { success: true, data: { text: finalText } });
      const stats = await o.request({ type: 'get_session_stats' }, 10_000);
      c.r.shape('get_session_stats → contextUsage {tokens, contextWindow, percent} (agent-runtime.ts #refreshContext)', stats, { success: true, data: { contextUsage: { tokens: T.pos, contextWindow: 1_000_000, percent: T.num } } });
      c.lead.marker = 'hello-compat';
    },
    o,
  );
  await step(
    c,
    'image prompt',
    async () => {
      const m = o.mark();
      const q = c.mock.requests.length;
      // agent-runtime.ts prompt(): images: [{type:'image', mimeType, data}] beside the text (ack may take longer)
      const ack = await o.prompt('p-img', 'Describe IMAGE-COMPAT', 'followUp', { images: [{ type: 'image', mimeType: 'image/png', data: pngBase64() }] });
      c.r.shape('prompt with images [{type:"image", mimeType, data}] → ack', ack, RESPONSE_OK('prompt'));
      const user = await o.waitFor((f) => isUser(f) && contentText(f.message.content).includes('IMAGE-COMPAT'), 30_000, m, 'user message with image');
      c.r.shape('user message_start carries the image blocks (normalize.ts user_message images)', user.message?.content, T.some({ type: 'image', mimeType: /^image\//, data: T.nonEmpty }));
      await o.promptResult('p-img', m);
      await o.settled(m);
      const main = c.mock.since(q).find((x) => x.caller === 'main');
      c.r.ok('the image reaches an image-capable model', (main?.images ?? 0) >= 1, '≥ 1 image_url part in the user message', `${main?.images ?? 'no request'} part(s)`);
    },
    o,
  );
}

async function leadApprovals(c: Ctx, o: Omp) {
  await step(
    c,
    'approve',
    async () => {
      const m = o.mark();
      await o.prompt('p-bash', 'BASH:echo compat-approved');
      const ask = await o.waitFor((f) => f.type === 'extension_ui_request' && f.method === 'select', 30_000, m, 'approval select');
      c.r.shape('write mode: bash asks → extension_ui_request select "Allow tool: bash\\n…" (approvals.ts offer)', ask, {
        id: T.nonEmpty,
        method: 'select',
        title: /^Allow tool: bash\n[\s\S]*echo compat-approved/,
        options: T.some(/^approve( once)?$/i),
      });
      c.r.shape('approval options include a Deny (approvals.ts answer() falls back to /deny|no/)', ask.options, T.some(/deny/i));
      const fs = o.since(m);
      const start = fs.find((f) => f.type === 'tool_execution_start' && f.toolName === 'bash');
      c.r.shape('tool_execution_start {toolCallId, toolName, args} (normalize.ts #toolStart)', start, { toolCallId: T.nonEmpty, toolName: 'bash', args: { command: 'echo compat-approved' } });
      c.r.ok('tool_execution_start comes before its approval request (agent-runtime.ts #argsAsked)', !!start && fs.indexOf(start) < fs.indexOf(ask), 'start index < approval index', `start ${start ? fs.indexOf(start) : 'missing'}, approval ${fs.indexOf(ask)}`);
      const composing = fs.find((f) => f.type === 'message_update' && f.assistantMessageEvent?.type === 'toolcall_start');
      c.r.shape('toolcall_start names the tool in block.name (normalize.ts composing)', composing?.assistantMessageEvent, { type: 'toolcall_start', block: { name: 'bash' } });
      const end = await o.waitFor((f) => f.type === 'tool_execution_end' && f.toolCallId === start?.toolCallId, 30_000, m, 'bash tool_execution_end');
      c.r.shape('approved → tool_execution_end {result.content[].text, isError:false}', end, { toolCallId: T.nonEmpty, toolName: 'bash', isError: false, result: { content: T.some({ type: 'text', text: T.has('compat-approved') }) } });
      const upd = o.since(m).find((f) => f.type === 'tool_execution_update' && f.toolCallId === start?.toolCallId);
      c.r.shape('tool_execution_update {toolCallId, partialResult.content[].text} (normalize.ts #toolUpdate)', upd, { toolCallId: T.nonEmpty, partialResult: { content: T.some({ type: 'text', text: T.str }) } });
      const pr = await o.promptResult('p-bash', m);
      c.r.shape('prompt_result completed after the tool turn', pr, { status: 'completed' });
      await o.settled(m);
    },
    o,
  );
  await step(
    c,
    'deny',
    async () => {
      const m = o.mark();
      o.uiHook = (f) => {
        if (f.method !== 'select' || !String(f.title).startsWith('Allow tool: bash')) return false;
        const deny = (f.options as string[]).find((x) => /deny/i.test(x)) ?? 'Deny';
        o.respondUi(f.id, { value: deny });
        return true;
      };
      await o.prompt('p-deny', 'BASH:echo compat-denied');
      const end = await o.waitFor((f) => f.type === 'tool_execution_end' && f.toolName === 'bash', 30_000, m, 'denied bash end');
      c.r.shape('answering the Deny option → tool_execution_end isError:true', end, { isError: true });
      await o.promptResult('p-deny', m);
      await o.settled(m);
      o.uiHook = undefined;
    },
    o,
  );
  await step(
    c,
    'ask dialog',
    async () => {
      const m = o.mark();
      o.uiHook = (f) => {
        if (f.method !== 'ask') return false;
        const qs = (f.questions ?? []) as { id: string }[];
        o.respondUi(f.id, { answers: qs.map((q, i) => ({ id: q.id, selectedOptions: i === 0 ? ['Blue'] : [] })) });
        return true;
      };
      await o.prompt('p-ask', 'ASK');
      const req = await o.waitFor((f) => f.type === 'extension_ui_request' && f.method === 'ask', 30_000, m, 'ask dialog');
      c.r.shape('set_ask_dialog → ask tool as extension_ui_request {method:"ask", questions[]} (approvals.ts ask)', req, {
        id: T.nonEmpty,
        method: 'ask',
        questions: T.some({ id: 'color', question: 'Which color?', header: 'Color', options: T.some({ label: T.has('Blue') }) }),
      });
      const end = await o.waitFor((f) => f.type === 'tool_execution_end' && f.toolName === 'ask', 30_000, m, 'ask tool end');
      c.r.shape('answers [{id, selectedOptions}] reach the tool result', end, { isError: false, result: { content: T.some({ type: 'text', text: T.has('Blue') }) } });
      await o.promptResult('p-ask', m);
      await o.settled(m);
      o.uiHook = undefined;
    },
    o,
  );
  await step(
    c,
    'stop with an approval open',
    async () => {
      const m = o.mark();
      let held: Frame | undefined;
      o.uiHook = (f) => {
        if (f.method === 'select' && String(f.title).startsWith('Allow tool: bash')) {
          held = f;
          return true; // leave it open
        }
        return false;
      };
      await o.prompt('p-cancel', 'BASH:echo compat-never');
      await o.waitFor((f) => f.type === 'extension_ui_request' && f.method === 'select', 30_000, m, 'approval to leave open');
      // CAST's Stop (agent-runtime.ts abort): approvals.dismissForAgent answers {cancelled:true}, then abort_and_restore_queue.
      o.respondUi(held!.id, { cancelled: true });
      const r = await o.request({ type: 'abort_and_restore_queue' }, 15_000);
      c.r.shape('Stop = {cancelled:true} to the open approval + abort_and_restore_queue → answered', r, RESPONSE_OK('abort_and_restore_queue'));
      const end = o.since(m).find((f) => f.type === 'tool_execution_end' && f.toolName === 'bash');
      c.r.shape('the cancelled approval does not run the command', end, T.opt({ isError: true }));
      const pr = await o.promptResult('p-cancel', m, 15_000);
      c.r.shape('the stopped prompt settles (prompt_result)', pr, { status: T.oneOf('aborted', 'completed') });
      o.uiHook = undefined;
      await o.settled(m, 5000).catch(() => {});
    },
    o,
  );
  await step(
    c,
    'dialog withdrawn',
    async () => {
      const m = o.mark();
      let held: Frame | undefined;
      o.uiHook = (f) => {
        if (f.method !== 'ask') return false;
        held = f;
        return true; // leave it open
      };
      await o.prompt('p-askstop', 'ASK');
      await o.waitFor((f) => f.type === 'extension_ui_request' && f.method === 'ask', 30_000, m, 'ask dialog to leave open');
      const r = await o.request({ type: 'abort_and_restore_queue' }, 15_000);
      c.r.shape('abort_and_restore_queue while an ask dialog is open → answered', r, RESPONSE_OK('abort_and_restore_queue'));
      const cancel = await o.waitFor((f) => f.type === 'extension_ui_request' && f.method === 'cancel', 10_000, m, 'dialog cancel');
      c.r.shape('omp withdraws the dialog: {method:"cancel", targetId} (normalize.ts ui_cancel → approvals.dismiss)', cancel, { method: 'cancel', targetId: held?.id ?? '(no held dialog)' });
      const pr = await o.promptResult('p-askstop', m, 15_000);
      c.r.shape('the stopped prompt reports status "aborted"', pr, { status: 'aborted' });
      o.uiHook = undefined;
      await o.settled(m, 5000).catch(() => {});
    },
    o,
  );
}

async function leadHostTools(c: Ctx, o: Omp) {
  await step(
    c,
    'host tools',
    async () => {
      const lastMain = [...c.mock.requests].reverse().find((x) => x.caller === 'main' && x.model === 'mock-a');
      const want = c.leadTools.map((t) => t.name);
      const missing = want.filter((n) => !lastMain?.tools.includes(n));
      c.r.ok('loadMode "essential" host tools are in the model\'s tool list (lead-tools.ts)', !!lastMain && missing.length === 0, want.join(', '), lastMain ? (missing.length ? `missing: ${missing.join(', ')}` : 'all offered') : 'no main request seen');
      const m = o.mark();
      o.hostHook = (f) => {
        o.respondHostTool(f.id, 'HOST-RESULT-7731 workflows: none');
        return true;
      };
      await o.prompt('p-host', 'HOST');
      const call = await o.waitFor((f) => f.type === 'host_tool_call', 30_000, m, 'host_tool_call');
      c.r.shape('host_tool_call {id, toolCallId, toolName, arguments} (agent-system.ts HostToolQueue)', call, { id: T.nonEmpty, toolCallId: T.nonEmpty, toolName: 'workflow_list', arguments: T.pred('object', (v) => !!v && typeof v === 'object') });
      const end = await o.waitFor((f) => f.type === 'tool_execution_end' && f.toolName === 'workflow_list', 30_000, m, 'host tool end');
      c.r.shape('host_tool_result {result:{content}, isError} becomes the tool result (omp-process.ts respondHostTool)', end, { isError: false, result: { content: T.some({ type: 'text', text: T.has('HOST-RESULT-7731') }) } });
      await o.promptResult('p-host', m);
      const reply = o.since(m).filter(isAssistantEnd).pop();
      c.r.ok('the model got the host tool result', textOfEnd(reply).includes('HOST-RESULT-7731'), 'final reply quotes HOST-RESULT-7731', JSON.stringify(textOfEnd(reply).slice(0, 100)));
      await o.settled(m);
      o.hostHook = undefined;
    },
    o,
  );
  await step(
    c,
    'host tool cancel',
    async () => {
      const m = o.mark();
      let held: Frame | undefined;
      o.hostHook = (f) => {
        held = f;
        return true; // never answer
      };
      await o.prompt('p-host2', 'HOST');
      await o.waitFor((f) => f.type === 'host_tool_call', 30_000, m, 'host_tool_call to hold');
      await o.request({ type: 'abort_and_restore_queue' }, 15_000);
      const cancel = await o.waitFor((f) => f.type === 'host_tool_cancel', 10_000, m, 'host_tool_cancel');
      c.r.shape('Stop during a host tool → host_tool_cancel {id, targetId} (agent-system.ts)', cancel, { id: T.nonEmpty, targetId: held?.id ?? '(no held call)' });
      await o.promptResult('p-host2', m, 15_000).catch(() => undefined);
      await o.settled(m, 5000).catch(() => {});
      o.hostHook = undefined;
    },
    o,
  );
}

async function waitBusy(o: Omp, m: number) {
  await o.waitFor((f) => f.type === 'message_update' && f.assistantMessageEvent?.type === 'text_delta', 20_000, m, 'the slow reply to stream');
}

async function leadQueue(c: Ctx, o: Omp) {
  await step(
    c,
    'steer',
    async () => {
      const m = o.mark();
      const q = c.mock.requests.length;
      await o.prompt('s0', 'SLOW steer test');
      await waitBusy(o, m);
      const before = o.mark();
      const ack = await o.prompt('s1', 'STEER-ONE now', 'steer');
      c.r.shape('prompt {streamingBehavior:"steer"} while busy → ack', ack, RESPONSE_OK('prompt'));
      const qu = o.since(before).find((f) => f.type === 'queue_update');
      c.r.shape('queue_update {steering[], followUp[], liveSteered} (normalize.ts queue)', qu, { type: 'queue_update', steering: ['STEER-ONE now'], followUp: [], liveSteered: T.num });
      const fs = o.since(before);
      c.r.ok('queue_update comes before the ack (ack = queued)', !!qu && fs.indexOf(qu) < fs.findIndex((f) => f.type === 'response' && f.id === 's1'), 'queue_update index < ack index', `queue_update ${qu ? fs.indexOf(qu) : 'missing'}, ack ${fs.findIndex((f) => f.type === 'response' && f.id === 's1')}`);
      const delivered = await o.waitFor((f) => isUser(f) && contentText(f.message.content).includes('STEER-ONE'), 30_000, m, 'steer delivery');
      c.r.shape('delivered steer: user message_start with steering:true (agent-runtime.ts #delivered)', delivered, { message: { role: 'user', steering: true } });
      const [r0, r1] = await Promise.all([o.promptResult('s0', m), o.promptResult('s1', m)]);
      c.r.shape('both prompts complete (prompt_result per prompt id)', [r0, r1], [{ status: 'completed' }, { status: 'completed' }]);
      c.r.ok('the model saw the steer', c.mock.since(q).some((x) => x.caller === 'main' && x.allText.includes('STEER-ONE now')), 'a main request containing "STEER-ONE now"', 'see mock requests');
      await o.settled(m);
    },
    o,
  );
  await step(
    c,
    'follow-up, promote, remove',
    async () => {
      const m = o.mark();
      const q = c.mock.requests.length;
      await o.prompt('f0', 'SLOW followup test');
      await waitBusy(o, m);
      await o.prompt('f1', 'FOLLOW-ONE please', 'followUp');
      await o.prompt('f2', 'FOLLOW-TWO please', 'followUp');
      const qu = [...o.since(m)].reverse().find((f) => f.type === 'queue_update');
      c.r.shape('two follow-ups queued → queue_update.followUp (oldest first)', qu, { steering: [], followUp: ['FOLLOW-ONE please', 'FOLLOW-TWO please'] });
      let mk = o.mark();
      const pro = await o.request({ type: 'promote_queued_message', message: 'FOLLOW-TWO please' }, 10_000);
      c.r.shape('promote_queued_message {message} → data.promoted true (agent-runtime.ts queueAction steer)', pro, { success: true, data: { promoted: true } });
      c.r.shape('…and queue_update moves it to steering', o.since(mk).find((f) => f.type === 'queue_update'), { steering: ['FOLLOW-TWO please'], followUp: ['FOLLOW-ONE please'] });
      mk = o.mark();
      const rem = await o.request({ type: 'remove_queued_message', message: 'FOLLOW-ONE please', queue: 'followUp' }, 10_000);
      c.r.shape('remove_queued_message {message, queue} → data.removed true (agent-runtime.ts queueAction remove)', rem, { success: true, data: { removed: true } });
      c.r.shape('…and queue_update drops it', o.since(mk).find((f) => f.type === 'queue_update'), { followUp: [] });
      const pro2 = await o.request({ type: 'promote_queued_message', message: 'NOT-QUEUED-XYZ' }, 10_000);
      const rem2 = await o.request({ type: 'remove_queued_message', message: 'NOT-QUEUED-XYZ', queue: 'steering' }, 10_000);
      c.r.shape('unknown text → promoted:false / removed:false ("Too late" in CAST)', [pro2.data, rem2.data], [{ promoted: false }, { removed: false }]);
      const delivered = await o.waitFor((f) => isUser(f) && contentText(f.message.content).includes('FOLLOW-TWO'), 30_000, m, 'promoted delivery');
      c.r.shape('promoted follow-up arrives as steering:true', delivered, { message: { steering: true } });
      await o.promptResult('f0', m);
      await o.settled(m);
      c.r.ok('the removed follow-up never reached the model', !c.mock.since(q).some((x) => x.allText.includes('FOLLOW-ONE please')), 'no request contains "FOLLOW-ONE please"', 'checked mock requests');
    },
    o,
  );
  await step(
    c,
    'abort_and_restore_queue',
    async () => {
      const m = o.mark();
      await o.prompt('a0', 'SLOW abort test');
      await waitBusy(o, m);
      await o.prompt('a1', 'STEER-AB', 'steer');
      await o.prompt('a2', 'FOLLOW-AB', 'followUp');
      const subs = await o.request({ type: 'get_subagents' }, 5000);
      c.r.shape('get_subagents → {subagents:[]} (agent-runtime.ts abort)', subs, { success: true, data: { subagents: T.arr() } });
      const r = await o.request({ type: 'abort_and_restore_queue' }, 15_000);
      c.r.shape('abort_and_restore_queue → data {steering:[{text}], followUp:[{text}]} (agent-runtime.ts #restore)', r, { success: true, data: { steering: [{ text: 'STEER-AB' }], followUp: [{ text: 'FOLLOW-AB' }] } });
      const end = await o.waitFor(isAssistantEnd, 10_000, m, 'aborted message_end');
      c.r.shape('the cut reply ends with stopReason "aborted"', end, { message: { stopReason: 'aborted' } });
      const pr = await o.promptResult('a0', m, 15_000);
      c.r.shape('prompt_result status "aborted"', pr, { status: 'aborted' });
      await o.settled(m, 5000).catch(() => {});
    },
    o,
  );
  await step(
    c,
    'interrupt mode wait',
    async () => {
      const m = o.mark();
      await o.prompt('w0', 'BASH:sleep 2; echo waited-ok');
      const start = await o.waitFor((f) => f.type === 'tool_execution_start' && f.toolName === 'bash', 30_000, m, 'bash start');
      await sleep(300);
      await o.prompt('w1', 'STEER-WAIT', 'steer');
      const end = await o.waitFor((f) => f.type === 'tool_execution_end' && f.toolCallId === start.toolCallId, 30_000, m, 'bash end');
      const text = toolText(end);
      c.r.ok('set_interrupt_mode wait: a steer lets the running command finish in the foreground', text.includes('waited-ok') && !/Backgrounded/i.test(text), 'result has "waited-ok", no "Backgrounded"', JSON.stringify(text.slice(0, 120)));
      await Promise.all([o.promptResult('w0', m), o.promptResult('w1', m)]);
      await o.settled(m);
    },
    o,
  );
}

async function leadSubagents(c: Ctx, o: Omp) {
  await step(
    c,
    'helper lifecycle',
    async () => {
      const st = await o.call({ type: 'get_state' }, 20_000);
      const parent = String(st.sessionFile ?? '');
      const m = o.mark();
      await o.prompt('p-spawn', 'SPAWN SLOWHELPER');
      const life = await o.waitFor((f) => f.type === 'subagent_lifecycle' && f.payload?.status === 'started', 60_000, m, 'subagent_lifecycle started');
      c.r.shape('subagent_lifecycle started {id, agent, status, parentToolCallId, sessionFile} (normalize.ts)', life, {
        payload: { id: T.nonEmpty, agent: 'rlt-mock-b', status: 'started', parentToolCallId: T.nonEmpty, sessionFile: T.absJsonl },
      });
      const id = String(life.payload?.id ?? '');
      const task = o.since(m).find((f) => f.type === 'tool_execution_start' && f.toolName === 'task');
      c.r.ok('parentToolCallId is the lead\'s task tool call', !!task && task.toolCallId === life.payload?.parentToolCallId, `task toolCallId ${task?.toolCallId}`, `parentToolCallId ${life.payload?.parentToolCallId}`);
      const derived = parent.endsWith('.jsonl') ? join(parent.slice(0, -'.jsonl'.length), `${id}.jsonl`) : '(no parent session)';
      c.r.ok('helper sessionFile = <lead session without .jsonl>/<id>.jsonl (subagents.ts helperSessionFile)', life.payload?.sessionFile === derived, derived, String(life.payload?.sessionFile));
      const prog = await o.waitFor((f) => f.type === 'subagent_progress' && f.payload?.progress?.id === id, 30_000, m, 'subagent_progress');
      c.r.shape('subagent_progress {progress:{id,…}, sessionFile, parentToolCallId} (normalize.ts)', prog, {
        payload: { progress: { id, status: T.opt(T.oneOf('pending', 'running', 'completed', 'failed', 'aborted')), toolCount: T.opt(T.num), tokens: T.opt(T.num) }, sessionFile: T.absJsonl, parentToolCallId: T.nonEmpty },
      });
      c.r.shape('subagent_progress: agent, assignment, resolvedModel = the helper file\'s model (subagents.ts #checkFallback)', prog, {
        payload: { agent: 'rlt-mock-b', assignment: T.has('HELPERTASK'), progress: { resolvedModel: T.has('mock-b'), modelOverride: T.pred('string or string[]', (v) => typeof v === 'string' || Array.isArray(v)) } },
      });
      const subs = await o.request({ type: 'get_subagents' }, 5000);
      c.r.shape('get_subagents while it runs → {subagents:[{id}]}', subs, { success: true, data: { subagents: T.some({ id }) } });
      const steer = await o.request({ type: 'steer_subagent', subagentId: id, message: 'compat: keep going' }, 15_000);
      c.r.shape('steer_subagent {subagentId, message} → success (agent-runtime.ts steerHelper)', steer, RESPONSE_OK('steer_subagent'));
      const done = await o.waitFor((f) => f.type === 'subagent_lifecycle' && f.payload?.id === id && f.payload?.status !== 'started', 60_000, m, 'subagent_lifecycle end');
      const progs = o.since(m).filter((f) => f.type === 'subagent_progress' && f.payload?.progress?.id === id).map((f) => f.payload.progress);
      c.r.shape('a progress frame names the running tool {currentTool, currentToolArgs, currentToolArgsKey} (subagents.ts station)', progs, T.some({ currentTool: 'read', currentToolArgs: T.has('a.txt'), currentToolArgsKey: T.str }));
      c.r.shape('the last progress has tokens, cost, recentOutput (subagents.ts spend + card)', progs[progs.length - 1], { tokens: T.pos, cost: T.pos, recentOutput: T.some(T.has('HELPER-RESULT')) });
      c.r.ok('the helper ran on its own model (--extension agents/*.md model)', c.mock.requests.some((x) => x.caller === 'helper' && x.model === 'mock-b'), 'requests for model mock-b', 'checked mock requests');
      c.r.shape('subagent_lifecycle completed, same sessionFile', done, { payload: { id, status: 'completed', sessionFile: life.payload?.sessionFile ?? T.absJsonl } });
      const file = String(done.payload?.sessionFile ?? '');
      const head = existsSync(file) ? readFileSync(file, 'utf8').split('\n').slice(0, 6) : [];
      c.r.ok('helper session file on disk starts with a {type:"session"} header (session-import.ts)', head.some((l) => l.includes('"type":"session"')), 'file exists with a session header', existsSync(file) ? head.map((l) => l.slice(0, 40)).join(' | ') : `missing: ${file}`);
      const wake = await o.waitFor((f) => f.type === 'message_start' && f.message?.customType === 'async-result', 30_000, m, 'async-result');
      c.r.shape('helper result wakes the lead: custom async-result with details.jobs[] (normalize.ts wake)', wake, { message: { role: 'custom', customType: 'async-result', details: { jobs: T.arr(T.any, 1) } } });
      await o.settled(m, 60_000);
    },
    o,
  );
  await step(
    c,
    'helper cancel',
    async () => {
      const m = o.mark();
      await o.prompt('p-spawn2', 'SPAWN SLOWHELPER cancel me');
      const life = await o.waitFor((f) => f.type === 'subagent_lifecycle' && f.payload?.status === 'started', 60_000, m, 'second helper start');
      const id = String(life.payload?.id ?? '');
      const r = await o.request({ type: 'cancel_subagent', subagentId: id }, 10_000);
      c.r.shape('cancel_subagent {subagentId} → success (agent-runtime.ts abort)', r, RESPONSE_OK('cancel_subagent'));
      const end = await o.waitFor((f) => f.type === 'subagent_lifecycle' && f.payload?.id === id && f.payload?.status !== 'started', 30_000, m, 'cancelled lifecycle');
      c.r.shape('cancelled helper ends with status aborted|failed (SubagentLifecyclePayload)', end, { payload: { status: T.oneOf('aborted', 'failed') } });
      await o.settled(m, 30_000).catch(() => {});
    },
    o,
  );
}

const goalShape = (objective: string, status: string): Spec => ({ id: T.nonEmpty, objective, status, tokensUsed: T.num });

async function leadGoal(c: Ctx, o: Omp) {
  await step(
    c,
    'goal create → complete',
    async () => {
      const m = o.mark();
      const q = c.mock.requests.length;
      const r = await o.request({ type: 'goal', op: 'create', objective: 'Finish the compat goal', token_budget: 500000 }, 30_000);
      c.r.shape('goal {op:"create", objective, token_budget} → data.goal (agent-runtime.ts goal; parseOmpGoal)', r, { success: true, data: { goal: { ...(goalShape('Finish the compat goal', 'active') as object), tokenBudget: 500000 } } });
      const gu = await o.waitFor((f) => f.type === 'goal_updated', 10_000, m, 'goal_updated');
      c.r.shape('goal_updated {goal:{objective, status}} (normalize.ts goal)', gu, { goal: { objective: 'Finish the compat goal', status: 'active' } });
      await o.waitFor((f) => f.type === 'goal_updated' && f.goal?.status === 'complete', 60_000, m, 'goal complete');
      const cont = c.mock.since(q).some((x) => x.caller === 'main' && x.lastUser.includes('Continue active goal.'));
      c.r.ok('--config overlay goal.continuationModes [rpc]: omp starts goal turns on its own', cont, 'a main request with "Continue active goal."', cont ? 'seen' : 'no continuation request');
      c.r.ok('goal turns run without a prompt_result', !o.since(m).some((f) => f.type === 'prompt_result'), 'no prompt_result', `${o.since(m).filter((f) => f.type === 'prompt_result').length} prompt_result(s)`);
      await o.settled(m);
      const st = await o.call({ type: 'get_state' });
      c.r.shape('after completion get_state.goal is empty', st.goal ?? null, null);
    },
    o,
  );
  await step(
    c,
    'goal pause / resume / drop',
    async () => {
      let m = o.mark();
      const obj = 'SLOWGOAL keep going';
      await o.call({ type: 'goal', op: 'create', objective: obj }, 30_000);
      await o.settled(m, 30_000);
      m = o.mark();
      const p = await o.request({ type: 'goal', op: 'pause' }, 30_000);
      c.r.shape('goal {op:"pause"} → data.goal.status paused', p, { success: true, data: { goal: goalShape(obj, 'paused') } });
      c.r.shape('…with goal_updated paused', await o.waitFor((f) => f.type === 'goal_updated' && f.goal?.status !== 'active', 10_000, m, 'goal_updated paused'), { goal: { status: 'paused' } });
      const st = await o.call({ type: 'get_state' });
      c.r.shape('get_state.goal = {goal:{objective, status}} (process-pool.ts BootState.goal)', st.goal, { goal: { objective: obj, status: 'paused' } });
      m = o.mark();
      const res = await o.request({ type: 'goal', op: 'resume' }, 30_000);
      c.r.shape('goal {op:"resume"} → status active', res, { success: true, data: { goal: goalShape(obj, 'active') } });
      await o.settled(m, 30_000);
      m = o.mark();
      const d = await o.request({ type: 'goal', op: 'drop' }, 30_000);
      c.r.shape('goal {op:"drop"} → success, no active goal in the answer', d, { success: true, data: { goal: T.pred('null or a non-active goal', (v) => v == null || (v as { status?: string }).status !== 'active') } });
      const gu = await o.waitFor((f) => f.type === 'goal_updated' && f.goal?.status !== 'active', 10_000, m, 'goal_updated drop');
      c.r.shape('…with goal_updated (dropped / null)', gu, { goal: T.pred('null or status "dropped"', (v) => v == null || (v as { status?: string }).status === 'dropped') });
      const st2 = await o.call({ type: 'get_state' });
      c.r.shape('after drop get_state.goal is empty', st2.goal ?? null, null);
      await o.settled(m, 5000).catch(() => {});
    },
    o,
  );
}

async function leadSessions(c: Ctx, o: Omp) {
  await step(
    c,
    'session file',
    async () => {
      const st = await o.call({ type: 'get_state' });
      const file = String(st.sessionFile ?? '');
      c.lead.sessionFile = file;
      c.r.ok('get_state.sessionFile is inside --session-dir', file.startsWith(`${c.lead.sessionDir}/`), `${c.lead.sessionDir}/…`, file);
      const lines = existsSync(file) ? readFileSync(file, 'utf8').split('\n').filter(Boolean) : [];
      const entries = lines.map((l) => {
        try {
          return JSON.parse(l);
        } catch {
          return {};
        }
      });
      const header = entries.slice(0, 6).find((e: any) => e.type === 'session');
      c.r.shape('session header {type:"session", cwd} in the first lines (process-pool.ts sessionCwd)', header, { type: 'session', cwd: c.project });
      const msgs = entries.filter((e: any) => e.type === 'message').map((e: any) => e.message);
      c.r.shape('message entries: user text (session-import.ts)', msgs, T.some({ role: 'user', content: T.pred('text', (v) => contentText(v).length > 0) }));
      c.r.shape('message entries: assistant toolCall {id, name, arguments}', msgs, T.some({ role: 'assistant', content: T.some({ type: 'toolCall', id: T.nonEmpty, name: 'bash', arguments: { command: T.str } }) }));
      c.r.shape('message entries: toolResult {toolCallId, isError, content}', msgs, T.some({ role: 'toolResult', toolCallId: T.nonEmpty, isError: T.bool, content: T.arr() }));
      c.r.ok('entries carry ISO timestamps', entries.filter((e: any) => e.type === 'message').every((e: any) => Number.isFinite(Date.parse(e.timestamp))), 'Date.parse(timestamp) finite', 'checked every message entry');
    },
    o,
  );
  await step(
    c,
    'new_session / switch_session',
    async () => {
      const before = await o.call({ type: 'get_state' });
      const lastText = (await o.call({ type: 'get_last_assistant_text' })).text;
      const ns = await o.request({ type: 'new_session' }, 20_000);
      c.r.shape('new_session → {cancelled:false} (agent-runtime.ts newThread)', ns, { success: true, data: { cancelled: false } });
      const fresh = await o.call({ type: 'get_state' });
      c.r.ok('new_session → a different sessionFile', !!fresh.sessionFile && fresh.sessionFile !== before.sessionFile, `≠ ${before.sessionFile}`, String(fresh.sessionFile));
      const cmp = await o.request({ type: 'compact' }, 60_000);
      c.r.ok('compact on an empty chat → error CAST reads as "nothing to compact"', cmp.success === false && /nothing to compact|already compacted/i.test(String(cmp.error)), 'success:false, error ~ /nothing to compact|already compacted/i', `success ${cmp.success}, error ${JSON.stringify(cmp.error)}`);
      const m = o.mark();
      await o.prompt('p-new', 'Say NEW-CHAT');
      await o.promptResult('p-new', m);
      await o.settled(m);
      const sw = await o.request({ type: 'switch_session', sessionPath: before.sessionFile, provider: 'mockp', modelId: 'mock-a' }, 30_000);
      c.r.shape('switch_session {sessionPath, provider, modelId} → {cancelled:false} (agent-runtime.ts switchThread)', sw, { success: true, data: { cancelled: false } });
      const back = await o.call({ type: 'get_state' });
      c.r.shape('…get_state is on that file with the same model', back, { sessionFile: before.sessionFile, model: { provider: 'mockp', id: 'mock-a' } });
      const lt = await o.call({ type: 'get_last_assistant_text' });
      c.r.ok('…and the old chat is back', lt.text === lastText, JSON.stringify(lastText), JSON.stringify(lt.text));
    },
    o,
  );
  await step(
    c,
    'goal to resume',
    async () => {
      const m = o.mark();
      c.lead.goalObjective = 'SLOWGOAL survive a restart';
      await o.call({ type: 'goal', op: 'create', objective: c.lead.goalObjective }, 30_000);
      await o.settled(m, 30_000);
      c.lead.sessionFile = String((await o.call({ type: 'get_state' })).sessionFile);
    },
    o,
  );
}

// ────────────────────────────────────────────────────────────── resume ──
export async function resumeGroup(c: Ctx) {
  c.r.group = 'resume';
  if (!c.lead.sessionFile || !existsSync(c.lead.sessionFile)) {
    c.r.fail('--resume <session file>', 'the lead group left a session file', String(c.lead.sessionFile));
    return;
  }
  const spec: CastSpec = { model: 'mockp/mock-a', approvalMode: 'write', systemPrompt: c.persona, sessionDir: c.lead.sessionDir!, thinking: 'medium', extensionDir: c.extDir, configFile: c.leadOverlay, resumeFile: c.lead.sessionFile };
  const o = new Omp('resume', { bin: c.bin, cwd: c.project, args: castArgs(spec), env: c.env, logDir: c.logs });
  try {
    let st: any;
    const ok = await step(c, 'boot', async () => void (st = await bootLikeCast(c, o, { hostTools: c.leadTools, model: spec.model })), o);
    if (!ok) return;
    c.r.ok('--resume reopens that file (get_state.sessionFile)', st.sessionFile === c.lead.sessionFile, c.lead.sessionFile, String(st.sessionFile));
    c.r.shape('the goal comes back in get_state.goal.goal (agent-runtime.ts #booted)', st.goal, { goal: { objective: c.lead.goalObjective, status: T.oneOf('paused', 'active') } });
    await step(
      c,
      'history',
      async () => {
        const m = o.mark();
        const q = c.mock.requests.length;
        await o.prompt('r1', 'Say AFTER-RESUME');
        await o.promptResult('r1', m);
        await o.settled(m);
        const main = c.mock.since(q).find((x) => x.caller === 'main');
        c.r.ok('the resumed chat keeps its history (the model sees the earlier turns)', !!main?.allText.includes(c.lead.marker ?? 'hello-compat'), `request contains "${c.lead.marker}"`, main ? `request of ${main.bytes} bytes without it` : 'no main request');
      },
      o,
    );
    await step(
      c,
      'rpc_chunk',
      async () => {
        const m = o.mark();
        const big = `BIGPROMPT ${'lorem ipsum dolor sit amet '.repeat(48_000)}`; // ~1.3 MB: omp's echo exceeds 1 MiB
        await o.prompt('r-big', big);
        const user = await o.waitFor((f) => isUser(f) && contentText(f.message.content).startsWith('BIGPROMPT'), 60_000, m, 'big user message_start');
        c.r.shape('a frame over 1 MiB comes as rpc_chunk {chunkId, index, count, data} (omp-process.ts reassembly)', o.chunks[0], { type: 'rpc_chunk', chunkId: T.nonEmpty, index: 0, count: T.pred('count > 1', (v) => typeof v === 'number' && v > 1) });
        c.r.ok('reassembled chunks are the whole frame', user.__chunked === true && contentText(user.message.content).length === big.length, `user message_start (chunked) with ${big.length} chars`, `chunked ${user.__chunked === true}, ${contentText(user.message.content).length} chars`);
        await o.promptResult('r-big', m, 60_000);
        await o.settled(m, 30_000).catch(() => {});
      },
      o,
    );
  } finally {
    await o.stop(1000);
  }
}

// ───────────────────────────────────────────────────────────── advisor ──
export async function advisorGroup(c: Ctx) {
  c.r.group = 'advisor';
  const sessionDir = join(c.work, 'sessions', 'advisor');
  const spec: CastSpec = { model: 'mockp/mock-a', approvalMode: 'write', systemPrompt: c.persona, sessionDir, extensionDir: c.extDir, configFile: c.advisorOverlay };
  const o = new Omp('advisor', { bin: c.bin, cwd: c.project, args: castArgs(spec), env: c.env, logDir: c.logs });
  try {
    let st: any;
    const ok = await step(c, 'boot', async () => void (st = await bootLikeCast(c, o, { hostTools: c.leadTools, model: spec.model })), o);
    if (!ok) return;
    await step(
      c,
      'review',
      async () => {
        const m = o.mark();
        const q = c.mock.requests.length;
        await o.prompt('adv1', 'Say ADVISED');
        const card = await o.waitFor((f) => f.type === 'message_end' && f.message?.customType === 'advisor', 60_000, m, 'advisor card');
        c.r.shape('advisor card: message_end custom/advisor with details.notes[{note, severity}] (normalize.ts advisor)', card, {
          message: { role: 'custom', customType: 'advisor', details: { notes: T.some({ note: T.has('ADVISOR-NOTE-1'), severity: 'concern' }) } },
        });
        const y = await o.waitFor((f) => f.type === 'advisor_yielded', 60_000, m, 'advisor_yielded');
        c.r.shape('advisor_yielded after a review (agent-runtime.ts #advisorSpend)', y, { type: 'advisor_yielded' });
        await o.promptResult('adv1', m, 60_000);
        await o.settled(m, 60_000);
        await sleep(1500); // the last review's card may come after session_settled
        const reqs = c.mock.since(q).filter((x) => x.caller === 'advisor');
        c.r.ok('modelRoles.advisor from the --config overlay picks the advisor model', reqs.length > 0 && reqs.every((x) => x.model === 'mock-b'), 'advisor requests on mock-b', reqs.map((x) => x.model).join(',') || 'no advisor request');
        const session = String(st.sessionFile ?? '');
        const file = session.endsWith('.jsonl') ? join(session.slice(0, -'.jsonl'.length), '__advisor.jsonl') : '';
        const lines = file && existsSync(file) ? readFileSync(file, 'utf8').split('\n').filter(Boolean) : [];
        const costs = lines
          .map((l) => {
            try {
              return JSON.parse(l);
            } catch {
              return {};
            }
          })
          .filter((e: any) => e.type === 'message' && e.message?.role === 'assistant')
          .map((e: any) => e.message?.usage?.cost?.total);
        c.r.ok('<session>/__advisor.jsonl holds the advisor\'s assistant messages with usage.cost.total (agent-runtime.ts #advisorFile)', costs.length > 0 && costs.every((x) => typeof x === 'number' && x > 0), 'file exists, cost.total > 0 on each assistant message', file && existsSync(file) ? `costs ${JSON.stringify(costs)}` : `missing: ${file || '(no session file)'}`);
      },
      o,
    );
    await step(
      c,
      'builtin slash command',
      async () => {
        const m = o.mark();
        const ack = await o.prompt('slash', '/advisor status');
        c.r.shape('a builtin slash command is answered locally: ack data.agentInvoked false (omp-process.ts prompt())', ack, { success: true, data: { agentInvoked: false } });
        await sleep(300);
        c.r.ok('…and starts no turn', !o.since(m).some((f) => f.type === 'agent_start'), 'no agent_start', `${o.since(m).filter((f) => f.type === 'agent_start').length} agent_start`);
      },
      o,
    );
  } finally {
    await o.stop(1000);
  }
}

// ────────────────────────────────────────────────────────── compaction ──
export async function compactionGroup(c: Ctx) {
  c.r.group = 'compaction';
  const sessionDir = join(c.work, 'sessions', 'worker');
  // a team member: no host tools, no overlay, the 'auto' approval mode (= always-ask), a text-only model
  const spec: CastSpec = { model: 'mockp/mock-t', approvalMode: 'always-ask', systemPrompt: 'You are a worker of the omp compat suite. [rlt-role:worker]', sessionDir, extensionDir: c.extDir };
  const o = new Omp('worker', { bin: c.bin, cwd: c.project, args: castArgs(spec), env: c.env, logDir: c.logs });
  const turn = async (id: string, text: string, timeout = 60_000) => {
    const m = o.mark();
    await o.prompt(id, text);
    const pr = await o.promptResult(id, m, timeout);
    await o.settled(m, timeout);
    return { m, pr };
  };
  try {
    const ok = await step(c, 'boot', async () => void (await bootLikeCast(c, o, { model: spec.model })), o);
    if (!ok) return;
    await step(
      c,
      'always-ask',
      async () => {
        const { m } = await turn('w-write', 'WRITE:compat-out/written.txt');
        const ask = o.since(m).find((f) => f.type === 'extension_ui_request' && f.method === 'select');
        c.r.shape('--approval-mode always-ask: a write asks with an Approve option (CAST "auto" mode, auto-review.ts)', ask, { title: /^Allow tool: write/, options: T.some(/^approve( once)?$/i) });
      },
      o,
    );
    await step(
      c,
      'manual compact',
      async () => {
        for (let i = 1; i <= 4; i++) await turn(`w-long${i}`, `Question ${i}: WORDS:4000`);
        const before = (await o.call({ type: 'get_session_stats' })).contextUsage;
        const r = await o.request({ type: 'compact' }, 120_000);
        c.r.shape('compact → data.tokensBefore (agent-runtime.ts compact)', r, { success: true, data: { tokensBefore: T.pos } });
        const after = (await o.call({ type: 'get_session_stats' })).contextUsage;
        c.r.ok('context shrinks after compact (get_session_stats)', typeof after?.tokens === 'number' && after.tokens < before?.tokens, `< ${before?.tokens}`, String(after?.tokens));
        const again = await o.request({ type: 'compact' }, 60_000);
        c.r.ok('compact again → error CAST reads as "nothing to compact"', again.success === false && /nothing to compact|already compacted/i.test(String(again.error)), 'success:false, error ~ /nothing to compact|already compacted/i', `success ${again.success}, error ${JSON.stringify(again.error)}`);
      },
      o,
    );
    await step(
      c,
      'auto compaction',
      async () => {
        // omp compacts at the end of the turn that crossed the threshold, or before the next prompt: both count.
        const { m } = await turn('w-full', 'Fill the window TOKENS:92000');
        await sleep(2500);
        await turn('w-next', 'Say after-threshold', 90_000);
        const s = o.since(m).find((f) => f.type === 'auto_compaction_start');
        const e = o.since(m).find((f) => f.type === 'auto_compaction_end');
        c.r.shape('auto_compaction_start {reason, action} (normalize.ts compaction_start)', s, { reason: T.str, action: T.str });
        c.r.shape('auto_compaction_end {aborted, willRetry, result.tokensBefore?} (normalize.ts compaction_end)', e, { aborted: T.bool, willRetry: T.bool, result: T.opt({ tokensBefore: T.opt(T.num) }) });
      },
      o,
    );
    await step(
      c,
      'retry',
      async () => {
        // 25 × HTTP 500: more than omp's transport retries (≈11 in 18.13), so its turn recovery takes over and says so.
        const { m, pr } = await turn('w-retry', 'FAIL500x25:k1 Say retried', 90_000);
        const s = o.since(m).find((f) => f.type === 'auto_retry_start');
        c.r.shape('repeated HTTP 500 → auto_retry_start {attempt, maxAttempts, errorMessage} (normalize.ts retry)', s, { attempt: T.num, maxAttempts: T.num, errorMessage: T.str });
        c.r.shape('…and the prompt still completes', pr, { status: 'completed' });
      },
      o,
    );
    await step(
      c,
      'provider error',
      async () => {
        const { m, pr } = await turn('w-400', 'FAIL400 please', 90_000);
        const end = o.since(m).find(isAssistantEnd);
        c.r.shape('HTTP 400 → assistant message_end stopReason "error" + errorMessage (normalize.ts error item)', end, { message: { stopReason: 'error', errorMessage: T.nonEmpty } });
        c.r.shape('…prompt_result settles with a status CAST knows', pr, { status: T.oneOf('completed', 'error', 'aborted') });
      },
      o,
    );
  } finally {
    await o.stop(1000);
  }
}

export type { MockRequest };
