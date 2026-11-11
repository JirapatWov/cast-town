// The local demo LLM: an OpenAI-compatible chat-completions server (SSE streaming, tool calls, reasoning)
// that omp talks to through the `rlt-demo` provider in data/omp-demo-agent/models.yml.
//
// What to say comes from demo-scripts.ts (role scripts that read the real project and call real omp tools);
// this file only makes it *feel* like a model: time-to-first-token, thinking at ~110 chars/s, text at a
// readable 45–75 chars/s with jitter and small pauses after sentences, tool-call arguments streamed fast,
// and plausible token usage (cached prompt tokens after the first turn) so cost meters move.
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { demoTurn, parseConversation, type Conversation, type TurnPlan } from './demo-scripts';
import { callId } from './demo/script';
import { errorText, log, truncate } from './util';

export interface MockLlmOptions {
  port: number;
  hostname?: string;
  /** Pacing multiplier: 2 = twice as fast (tests use 10+). */
  speed?: number;
  /** Append one JSON line per request here (debugging). */
  logFile?: string;
  /** Write every raw request body to <dumpDir>/req-<n>.json (debugging). */
  dumpDir?: string;
}

export interface MockLlm {
  readonly port: number;
  readonly url: string;
  /** Requests served so far. */
  readonly requests: number;
  stop(): void;
}

const enc = new TextEncoder();
const rand = (a: number, b: number) => a + Math.random() * (b - a);

/** omp's own side jobs that no person's script covers: an advisor's review (a second model reading the lead's turns,
 *  recognized by its `advise` tool) gives one short note; a goal turn (omp's hidden "Continue active goal." steer)
 *  marks the goal met — the demo can't really work toward one, and would otherwise keep going until the budget ends;
 *  a compaction gets a summary. */
function sideTurn(conv: Conversation): TurnPlan | null {
  if (conv.tools.has('advise')) {
    if (conv.turn.length) return { text: '' };
    return { calls: [{ name: 'advise', args: { note: 'Looks reasonable — check the result against the brief before calling it done.' } }] };
  }
  if (conv.tools.has('goal') && /^(<!--[\s\S]*?-->\s*)?Continue active goal\./.test(conv.userText)) {
    if (conv.turn.some((c) => c.name === 'goal')) return { text: 'The goal is met.' };
    return { calls: [{ name: 'goal', args: { op: 'complete' } }] };
  }
  // omp compacting a chat with the model (no tools): a short summary instead of a person's script.
  if (!conv.tools.size && /Summarize user/i.test(conv.system)) {
    return { text: '## Summary\nThe user asked about the project; the assistant read its files and explained them. Nothing is left open.' };
  }
  // A goal set while the person worked arrives as a note in the running turn: not a new ask.
  if (/^<goal_context>/.test(conv.userText) && !conv.turn.length) return { text: 'Noted — I’ll work toward the goal once this is done.' };
  return null;
}

/** Thai packs ~2 chars per token, Latin text ~4. */
function estimateTokens(s: string): number {
  const thai = (s.match(/[฀-๿]/g) ?? []).length;
  return Math.max(1, Math.ceil(thai / 1.8 + (s.length - thai) / 3.8));
}

interface Chunker {
  /** Send one SSE chunk; false once the client went away. */
  emit(delta: Record<string, unknown>, finish?: string | null, usage?: Record<string, unknown>): boolean;
  /** Sleep; resolves false if the client went away meanwhile. */
  wait(ms: number): Promise<boolean>;
}

/** Stream `text` in small pieces at ~`cps` chars/s, pausing a little after sentences. */
async function streamText(c: Chunker, field: 'content' | 'reasoning_content', text: string, cps: number, speed: number): Promise<boolean> {
  const chars = Array.from(text);
  let i = 0;
  while (i < chars.length) {
    const tick = 45;
    let n = Math.max(1, Math.round(((cps * speed * tick) / 1000) * rand(0.6, 1.4)));
    // Prefer to break after a space so words appear whole.
    const space = chars.slice(i + n, i + n + 6).indexOf(' ');
    if (space >= 0) n += space + 1;
    const piece = chars.slice(i, i + n).join('');
    i += n;
    if (!c.emit({ [field]: piece })) return false;
    let pause = tick * rand(0.7, 1.3);
    if (/[.!?。]\s*$|\n\n$/.test(piece) && Math.random() < 0.6) pause += rand(80, 260);
    if (!(await c.wait(pause / speed))) return false;
  }
  return true;
}

async function streamPlan(c: Chunker, plan: TurnPlan, conv: Conversation, speed: number): Promise<void> {
  c.emit({ role: 'assistant', content: '' });
  if (!(await c.wait(rand(450, 1000) / speed))) return;

  let produced = '';
  if (plan.thinking) {
    if (!(await streamText(c, 'reasoning_content', plan.thinking, 110, speed))) return;
    produced += plan.thinking;
    if (!(await c.wait(rand(150, 320) / speed))) return;
  }
  if (plan.text) {
    const len = plan.text.length;
    const cps = len > 3000 ? 170 : len > 1200 ? 130 : rand(45, 75);
    if (!(await streamText(c, 'content', plan.text, cps, speed))) return;
    produced += plan.text;
  }
  const calls = plan.calls ?? [];
  for (const [index, call] of calls.entries()) {
    if (!(await c.wait(rand(100, 220) / speed))) return;
    const args = JSON.stringify(call.args);
    if (!c.emit({ tool_calls: [{ index, id: callId(call, index), type: 'function', function: { name: call.name, arguments: '' } }] })) return;
    for (let i = 0; i < args.length; ) {
      const n = Math.round(rand(20, 90) * Math.max(1, speed / 2));
      if (!c.emit({ tool_calls: [{ index, function: { arguments: args.slice(i, i + n) } }] })) return;
      i += n;
      if (!(await c.wait(25 / speed))) return;
    }
    produced += args;
  }

  const prompt = Math.ceil(conv.promptChars / 3.6);
  const cached = conv.turn.length > 0 || conv.userTexts.length > 1 ? Math.floor(prompt * 0.8) : 0;
  const completion = estimateTokens(produced);
  c.emit({}, calls.length ? 'tool_calls' : 'stop', {
    prompt_tokens: prompt,
    completion_tokens: completion,
    total_tokens: prompt + completion,
    prompt_tokens_details: { cached_tokens: cached },
  });
}

function sseResponse(conv: Conversation, plan: TurnPlan, speed: number, signal: AbortSignal): Response {
  const id = `chatcmpl-rlt-${Date.now().toString(36)}`;
  const created = Math.floor(Date.now() / 1000);
  let closed = false;
  const timers = new Set<ReturnType<typeof setTimeout>>();
  const close = () => {
    closed = true;
    for (const t of timers) clearTimeout(t);
    timers.clear();
  };
  signal.addEventListener('abort', close, { once: true });

  const stream = new ReadableStream<Uint8Array>({
    async start(ctrl) {
      const chunker: Chunker = {
        emit(delta, finish = null, usage) {
          if (closed) return false;
          const body = { id, object: 'chat.completion.chunk', created, model: conv.model, choices: [{ index: 0, delta, finish_reason: finish }], ...(usage ? { usage } : {}) };
          try {
            ctrl.enqueue(enc.encode(`data: ${JSON.stringify(body)}\n\n`));
            return true;
          } catch {
            close();
            return false;
          }
        },
        wait(ms) {
          if (closed) return Promise.resolve(false);
          return new Promise((resolve) => {
            const t = setTimeout(() => {
              timers.delete(t);
              resolve(!closed);
            }, Math.max(0, ms));
            timers.add(t);
          });
        },
      };
      try {
        await streamPlan(chunker, plan, conv, speed);
        if (!closed) ctrl.enqueue(enc.encode('data: [DONE]\n\n'));
      } catch (err) {
        log('mock-llm', `stream failed: ${errorText(err)}`);
      } finally {
        if (!closed) {
          close();
          try {
            ctrl.close();
          } catch {
            /* already closed */
          }
        }
      }
    },
    cancel() {
      close();
    },
  });
  return new Response(stream, { headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' } });
}

/** Non-streaming fallback (omp always streams; kept for curl and other clients). */
function jsonResponse(conv: Conversation, plan: TurnPlan): Response {
  const calls = (plan.calls ?? []).map((c, i) => ({ id: callId(c, i), type: 'function', function: { name: c.name, arguments: JSON.stringify(c.args) } }));
  const prompt = Math.ceil(conv.promptChars / 3.6);
  const completion = estimateTokens(`${plan.thinking ?? ''}${plan.text ?? ''}`);
  return Response.json({
    id: `chatcmpl-rlt-${Date.now().toString(36)}`,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model: conv.model,
    choices: [{ index: 0, message: { role: 'assistant', content: plan.text ?? '', reasoning_content: plan.thinking, ...(calls.length ? { tool_calls: calls } : {}) }, finish_reason: calls.length ? 'tool_calls' : 'stop' }],
    usage: { prompt_tokens: prompt, completion_tokens: completion, total_tokens: prompt + completion },
  });
}

export function startMockLlm(o: MockLlmOptions): MockLlm {
  const speed = o.speed && o.speed > 0 ? o.speed : 1;
  let requests = 0;

  const record = (conv: Conversation, plan: TurnPlan, ms: number) => {
    if (!o.logFile) return;
    try {
      const entry = {
        t: new Date().toISOString(),
        n: requests,
        model: conv.model,
        role: conv.role ?? (conv.isJudgment ? 'judgment' : 'subagent'),
        cwd: conv.cwd,
        user: truncate(conv.userText, 120),
        turn: conv.turn.map((c) => `${c.name}:${c.step ?? '-'}${c.result === null ? '?' : ''}`),
        plan: { thinking: plan.thinking?.length ?? 0, text: plan.text?.length ?? 0, calls: (plan.calls ?? []).map((c) => c.name) },
        planMs: ms,
      };
      appendFileSync(o.logFile, `${JSON.stringify(entry)}\n`);
    } catch {
      /* logging is best-effort */
    }
  };

  const server = Bun.serve({
    port: o.port,
    hostname: o.hostname ?? '127.0.0.1',
    idleTimeout: 120,
    async fetch(req) {
      const url = new URL(req.url);
      if (req.method === 'GET' && url.pathname.endsWith('/models')) return Response.json({ object: 'list', data: [] });
      if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/health')) return new Response('rlt demo llm\n');
      if (req.method !== 'POST' || !url.pathname.endsWith('/chat/completions')) return new Response('not found', { status: 404 });

      let body: Parameters<typeof parseConversation>[0] & { stream?: boolean };
      try {
        body = (await req.json()) as typeof body;
      } catch {
        return Response.json({ error: { message: 'invalid JSON body' } }, { status: 400 });
      }
      requests++;
      if (o.dumpDir) {
        try {
          mkdirSync(o.dumpDir, { recursive: true });
          writeFileSync(join(o.dumpDir, `req-${requests}.json`), JSON.stringify(body, null, 2));
        } catch {
          /* debugging aid only */
        }
      }
      const started = performance.now();
      const conv = parseConversation(body);
      let plan: TurnPlan;
      try {
        plan = sideTurn(conv) ?? demoTurn(conv);
      } catch (err) {
        log('mock-llm', `script error (${conv.role ?? 'subagent'}): ${errorText(err)}`);
        plan = { text: `(The demo model tripped over its own script: ${truncate(errorText(err), 160)})` };
      }
      record(conv, plan, Math.round(performance.now() - started));
      return body.stream === false ? jsonResponse(conv, plan) : sseResponse(conv, plan, speed, req.signal);
    },
  });

  return {
    port: server.port ?? o.port,
    url: `http://${o.hostname ?? '127.0.0.1'}:${server.port ?? o.port}/v1`,
    get requests() {
      return requests;
    },
    stop() {
      server.stop(true);
    },
  };
}
