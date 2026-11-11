// Tiny OpenAI-compatible streaming mock LLM used by cast/parity (no keys, no network).
// POST /v1/chat/completions (SSE). Responses come from a FIFO plan (POST /ctl/plan) or a default.
// Every request body is saved to <dir>/req/req-<n>.json and summarised in <dir>/requests.jsonl.
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const port = Number(process.env.MOCK_PORT ?? 5361);
const dir = process.env.MOCK_DIR ?? join(import.meta.dir, 'mockout');
mkdirSync(join(dir, 'req'), { recursive: true });
const enc = new TextEncoder();

type Plan = {
  when?: 'tools' | 'notools' | 'any'; // which requests may take it (tools = normal agent turn)
  text?: string;
  tool?: { name: string; args: unknown };
  delayMs?: number; // before first chunk
  chunkMs?: number; // between text chunks
  chunks?: number; // split text into this many chunks
  promptTokens?: number;
  completionTokens?: number;
  status?: number; // HTTP error instead
};
let plans: Plan[] = [];
let n = 0;
const t0 = Date.now();

function summarize(body: any) {
  const msgs = (body.messages ?? []) as any[];
  const parts = (m: any) =>
    typeof m.content === 'string'
      ? [{ type: 'text', text: m.content.slice(0, 160), len: m.content.length }]
      : (m.content ?? []).map((p: any) =>
          p.type === 'text'
            ? { type: 'text', text: String(p.text).slice(0, 160), len: String(p.text).length }
            : p.type === 'image_url'
              ? { type: 'image_url', urlPrefix: String(p.image_url?.url).slice(0, 40), urlLen: String(p.image_url?.url).length, detail: p.image_url?.detail }
              : { type: p.type, keys: Object.keys(p) },
        );
  return {
    model: body.model,
    stream: body.stream,
    nMessages: msgs.length,
    tools: (body.tools ?? []).map((t: any) => t.function?.name),
    roles: msgs.map((m) => m.role).join(','),
    tail: msgs.slice(-4).map((m) => ({ role: m.role, parts: parts(m), tool_calls: m.tool_calls?.map((c: any) => c.function?.name), tool_call_id: m.tool_call_id })),
    system0: typeof msgs[0]?.content === 'string' ? msgs[0].content.slice(0, 120) : undefined,
  };
}

function pick(hasTools: boolean): Plan | undefined {
  const i = plans.findIndex((p) => (p.when ?? 'tools') === 'any' || (p.when ?? 'tools') === (hasTools ? 'tools' : 'notools'));
  if (i < 0) return undefined;
  return plans.splice(i, 1)[0];
}

const sleep = (ms: number, signal: AbortSignal) =>
  new Promise<boolean>((res) => {
    if (signal.aborted) return res(false);
    const t = setTimeout(() => res(true), ms);
    signal.addEventListener('abort', () => {
      clearTimeout(t);
      res(false);
    }, { once: true });
  });

Bun.serve({
  port,
  hostname: '127.0.0.1',
  idleTimeout: 0,
  async fetch(req) {
    const url = new URL(req.url);
    if (url.pathname === '/ctl/plan' && req.method === 'POST') {
      const p = (await req.json()) as Plan[];
      plans.push(...p);
      return Response.json({ queued: plans.length });
    }
    if (url.pathname === '/ctl/reset') {
      plans = [];
      return Response.json({ ok: true });
    }
    if (url.pathname === '/ctl/state') return Response.json({ plans, n });
    if (url.pathname.endsWith('/models')) return Response.json({ object: 'list', data: [] });
    if (!url.pathname.endsWith('/chat/completions')) return new Response('nf', { status: 404 });
    const raw = await req.text();
    const k = ++n;
    writeFileSync(join(dir, 'req', `req-${k}.json`), raw);
    let body: any = {};
    try {
      body = JSON.parse(raw);
    } catch {}
    const hasTools = Array.isArray(body.tools) && body.tools.length > 0;
    const plan = pick(hasTools) ?? (hasTools ? { text: `MOCK-REPLY-${k}`, delayMs: 200 } : { text: `## Summary\nMOCK-SUMMARY-${k}: the user tested things.`, delayMs: 300 });
    const rec = { n: k, t: Date.now() - t0, bytes: raw.length, plan: { ...plan, text: plan.text?.slice(0, 60) }, ...summarize(body) };
    appendFileSync(join(dir, 'requests.jsonl'), `${JSON.stringify(rec)}\n`);
    if (plan.status) return new Response(JSON.stringify({ error: { message: `mock error ${plan.status}` } }), { status: plan.status, headers: { 'content-type': 'application/json' } });
    const signal = req.signal;
    signal.addEventListener('abort', () => appendFileSync(join(dir, 'requests.jsonl'), `${JSON.stringify({ n: k, t: Date.now() - t0, event: 'client-abort' })}\n`), { once: true });
    const id = `chatcmpl-mock-${k}`;
    const created = Math.floor(Date.now() / 1000);
    const stream = new ReadableStream<Uint8Array>({
      async start(ctrl) {
        let ok = true;
        const emit = (delta: any, finish: string | null = null, usage?: any) => {
          if (!ok) return false;
          try {
            ctrl.enqueue(enc.encode(`data: ${JSON.stringify({ id, object: 'chat.completion.chunk', created, model: body.model, choices: [{ index: 0, delta, finish_reason: finish }], ...(usage ? { usage } : {}) })}\n\n`));
          } catch {
            ok = false;
          }
          return ok;
        };
        emit({ role: 'assistant', content: '' });
        if (!(await sleep(plan.delayMs ?? 200, signal))) return;
        if (plan.text) {
          const pieces = Math.max(1, plan.chunks ?? 3);
          const size = Math.ceil(plan.text.length / pieces);
          for (let i = 0; i < plan.text.length; i += size) {
            if (!emit({ content: plan.text.slice(i, i + size) })) return;
            if (!(await sleep(plan.chunkMs ?? 30, signal))) return;
          }
        }
        if (plan.tool) {
          emit({ tool_calls: [{ index: 0, id: `call_${k}`, type: 'function', function: { name: plan.tool.name, arguments: '' } }] });
          emit({ tool_calls: [{ index: 0, function: { arguments: JSON.stringify(plan.tool.args) } }] });
        }
        // Realistic-ish prompt tokens: text bytes/4, ~800 tokens per image (not its base64 length).
        let imgChars = 0;
        let imgs = 0;
        for (const m of body.messages ?? []) if (Array.isArray(m.content)) for (const p of m.content) if (p.type === 'image_url') { imgs++; imgChars += String(p.image_url?.url ?? '').length; }
        const pt = plan.promptTokens ?? Math.ceil((raw.length - imgChars) / 4) + imgs * 800;
        const ct = plan.completionTokens ?? 20;
        emit({}, plan.tool ? 'tool_calls' : 'stop', { prompt_tokens: pt, completion_tokens: ct, total_tokens: pt + ct });
        try {
          ctrl.enqueue(enc.encode('data: [DONE]\n\n'));
          ctrl.close();
        } catch {}
        appendFileSync(join(dir, 'requests.jsonl'), `${JSON.stringify({ n: k, t: Date.now() - t0, event: 'done' })}\n`);
      },
    });
    return new Response(stream, { headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' } });
  },
});
console.log(`mock on ${port}, dir ${dir}`);
