// A tiny scripted OpenAI-compatible chat-completions server (SSE) for the omp compatibility suite.
//
// omp reaches it through a keyless provider in the scratch agent dir's models.yml (same shape as CAST's demo
// provider, server/agents/demo-agent-dir.ts). What it answers depends on who asks and on directives in the last user
// message, so every scenario is deterministic:
//
//   caller   advisor  — the request offers the `advise` tool        → advise {note, severity: concern first, then none}
//            helper   — model mock-b (the task-tool helper)         → read a.txt → yield/text
//            summary  — no tools (compaction, summaries)            → a short markdown summary
//            main     — everything else, by directive:
//   directives (anywhere in the last user message):
//     THINK            stream reasoning_content before the text
//     SLOW             stream the reply slowly (~2.4 s)
//     BASH:<cmd>       call bash {command}            WRITE:<path>  call write {path, content}
//     HOST             call the host tool workflow_list {}
//     ASK              call ask with one question (Red / Blue)
//     SPAWN[ SLOWHELPER]  call task with the rlt-mock-b helper (SLOWHELPER: the helper takes ~2.5 s per step)
//     WORDS:<n>        a long reply of n words      TOKENS:<n>   report n prompt tokens
//     FAIL500x<n>:<k>  HTTP 500 the first n times key k is seen (with retry-after-ms, so omp retries at once)
//     FAIL400          HTTP 400
// Prompt tokens are reported as request bytes / 4 (roughly what a real provider counts) unless TOKENS says otherwise.
//   goal turns ("Continue active goal."): call goal {op:"complete"}, then "GOAL DONE"; an objective with SLOWGOAL
//   answers with text only (the goal stays active).
// After a tool result the main caller answers "DONE(<tools>): <last tool result text>".

export interface MockRequest {
  n: number;
  model: string;
  caller: 'main' | 'helper' | 'advisor' | 'summary';
  tools: string[];
  system: string;
  lastUser: string;
  /** Every message's text, joined (to look for history and steering wrappers). */
  allText: string;
  bytes: number;
  aborted: boolean;
  /** The thinking level omp asked for (openai-completions reasoning_effort). */
  reasoningEffort?: string;
  /** Image parts in the last user message. */
  images: number;
}

type Msg = { role: string; content?: unknown; tool_calls?: { id: string; function: { name: string; arguments: string } }[]; tool_call_id?: string };
type Call = { name: string; args: unknown };
interface Plan {
  text?: string;
  thinking?: string;
  calls?: Call[];
  slowMs?: number; // spread the text over this long
  delayMs?: number; // before the first chunk
  promptTokens?: number;
  status?: number; // HTTP error instead of a stream
  retryAfterMs?: number;
}

const enc = new TextEncoder();
const textOf = (c: unknown): string => {
  if (typeof c === 'string') return c;
  if (Array.isArray(c)) return c.map((p: { type?: string; text?: string }) => (p?.type === 'text' ? (p.text ?? '') : p?.type === 'image_url' ? '[image]' : '')).join('');
  return '';
};

const WORDS = ['alpha', 'beta', 'gamma', 'delta', 'river', 'stone', 'cloud', 'maple', 'orbit', 'pixel', 'quartz', 'saddle', 'tundra', 'violet', 'walnut', 'zephyr'];
const words = (n: number) => Array.from({ length: n }, (_, i) => WORDS[(i * 7 + (i >> 3)) % WORDS.length] + (i % 13 === 12 ? '.' : '')).join(' ');

export class MockLlm {
  requests: MockRequest[] = [];
  #server?: ReturnType<typeof Bun.serve>;
  #failures = new Map<string, number>();
  #advisorReviews = 0;

  get port(): number {
    return this.#server?.port ?? 0;
  }

  start(): void {
    this.#server = Bun.serve({
      port: 0,
      hostname: '127.0.0.1',
      idleTimeout: 0,
      fetch: (req) => this.#fetch(req),
    });
  }

  stop(): void {
    this.#server?.stop(true);
  }

  /** Requests since index `from` (requests.length before an action). */
  since(from: number): MockRequest[] {
    return this.requests.slice(from);
  }

  async #fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);
    if (req.method === 'GET' && url.pathname.endsWith('/models')) return Response.json({ object: 'list', data: [{ id: 'mock-a' }, { id: 'mock-b' }, { id: 'mock-t' }] });
    if (req.method !== 'POST' || !url.pathname.endsWith('/chat/completions')) return new Response('not found', { status: 404 });
    const raw = await req.text();
    const body = JSON.parse(raw) as { model?: string; reasoning_effort?: string; messages?: Msg[]; tools?: { function?: { name?: string; parameters?: { properties?: Record<string, unknown> } } }[] };
    const msgs = body.messages ?? [];
    const tools = (body.tools ?? []).map((t) => t.function?.name ?? '').filter(Boolean);
    const system = msgs.filter((x) => x.role === 'system' || x.role === 'developer').map((x) => textOf(x.content)).join('\n');
    const lastUserIdx = msgs.map((x) => x.role).lastIndexOf('user');
    const lastUser = lastUserIdx >= 0 ? textOf(msgs[lastUserIdx]!.content) : '';
    const after = msgs.slice(lastUserIdx + 1);
    const model = String(body.model ?? '');
    const caller: MockRequest['caller'] = tools.includes('advise') ? 'advisor' : model === 'mock-b' ? 'helper' : tools.length === 0 ? 'summary' : 'main';
    const rec: MockRequest = {
      n: this.requests.length + 1,
      model,
      caller,
      tools,
      system,
      lastUser,
      allText: msgs.map((x) => textOf(x.content)).join('\n'),
      bytes: raw.length,
      aborted: false,
      reasoningEffort: body.reasoning_effort,
      images: lastUserIdx >= 0 && Array.isArray(msgs[lastUserIdx]!.content) ? (msgs[lastUserIdx]!.content as { type?: string }[]).filter((p) => p?.type === 'image_url').length : 0,
    };
    this.requests.push(rec);
    const plan = this.#decide(rec, after, body);
    if (plan.status) {
      const hint = plan.retryAfterMs !== undefined ? ` retry-after-ms=${plan.retryAfterMs}` : '';
      const headers: Record<string, string> = plan.retryAfterMs !== undefined ? { 'retry-after-ms': String(plan.retryAfterMs) } : {};
      return Response.json({ error: { message: `mock HTTP ${plan.status} (compat suite)${hint}`, type: 'mock_error' } }, { status: plan.status, headers });
    }
    plan.promptTokens ??= Math.ceil(raw.length / 4);
    return this.#sse(plan, model, req.signal, rec);
  }

  #decide(r: MockRequest, after: Msg[], body: { tools?: { function?: { name?: string; parameters?: { properties?: Record<string, unknown> } } }[] }): Plan {
    const toolsAfter = after.flatMap((x) => (x.tool_calls ?? []).map((t) => t.function.name));
    const results = after.filter((x) => x.role === 'tool');
    if (r.caller === 'advisor') {
      if (results.length) return { text: '' };
      this.#advisorReviews++;
      const first = this.#advisorReviews === 1;
      return { calls: [{ name: 'advise', args: first ? { note: `ADVISOR-NOTE-${this.#advisorReviews}`, severity: 'concern' } : { note: `ADVISOR-NOTE-${this.#advisorReviews}` } }] };
    }
    if (r.caller === 'helper') {
      const slow = r.allText.includes('SLOWHELPER') ? 2500 : 300;
      if (toolsAfter.includes('yield')) return { text: 'yielded' };
      if (!toolsAfter.length) return { calls: [{ name: 'read', args: { path: 'a.txt' } }], delayMs: slow };
      if (r.tools.includes('yield')) return { calls: [{ name: 'yield', args: { data: 'HELPER-RESULT: a.txt says alpha' } }], delayMs: slow };
      return { text: 'HELPER-RESULT: a.txt says alpha', delayMs: slow };
    }
    if (r.caller === 'summary') return { text: '## Summary\nThe compat suite chatted with the agent. Nothing is left open.' };

    // main
    const u = r.lastUser;
    const tokens = Number(/TOKENS:(\d+)/.exec(u)?.[1] ?? 0) || undefined;
    if (u.includes('Continue active goal.')) {
      if (/SLOWGOAL/.test(u)) return { text: 'Working toward the goal, nothing more to do right now.', slowMs: 800 };
      if (toolsAfter.includes('goal')) return { text: 'GOAL DONE: objective met.' };
      if (r.tools.includes('goal')) return { calls: [{ name: 'goal', args: { op: 'complete' } }] };
      return { text: 'GOAL: no goal tool offered.' };
    }
    if (results.length) {
      const last = results[results.length - 1]!;
      return { text: `DONE(${toolsAfter.join(',')}): ${textOf(last.content).slice(0, 400)}`, promptTokens: tokens };
    }
    const fail = /FAIL500x(\d+):(\w+)/.exec(u);
    if (fail) {
      const seen = this.#failures.get(fail[2]!) ?? 0;
      if (seen < Number(fail[1])) {
        this.#failures.set(fail[2]!, seen + 1);
        return { status: 500, retryAfterMs: 20 };
      }
    }
    if (u.includes('FAIL400')) return { status: 400 };
    const bash = /BASH:([^\n]+)/.exec(u)?.[1];
    if (bash) return { calls: [{ name: 'bash', args: { command: bash.trim() } }] };
    const write = /WRITE:(\S+)/.exec(u)?.[1];
    if (write) return { calls: [{ name: 'write', args: { path: write, content: 'written by the omp compat suite\n' } }] };
    if (/\bHOST\b/.test(u)) return { calls: [{ name: 'workflow_list', args: {} }] };
    if (/\bASK\b/.test(u)) {
      return { calls: [{ name: 'ask', args: { questions: [{ id: 'color', question: 'Which color?', header: 'Color', options: [{ label: 'Red' }, { label: 'Blue' }], recommended: 0 }] } }] };
    }
    if (/\bSPAWN\b/.test(u)) {
      const task = body.tools?.find((t) => t.function?.name === 'task');
      const batch = !!task?.function?.parameters?.properties?.tasks;
      const slow = u.includes('SLOWHELPER') ? ' SLOWHELPER' : '';
      const item = { name: 'CompatScout', agent: 'rlt-mock-b', task: `HELPERTASK${slow}: read a.txt and report`, solutionSpace: 'read a.txt' };
      return { calls: [{ name: 'task', args: batch ? { context: 'omp compat suite', tasks: [item] } : item }] };
    }
    const n = Number(/WORDS:(\d+)/.exec(u)?.[1] ?? 0);
    if (n) return { text: `Long answer: ${words(n)}`, promptTokens: tokens };
    const line = u.split('\n').map((s) => s.trim()).filter(Boolean).pop() ?? '';
    const slow = /\bSLOW\b/.test(u);
    const text = `ECHO: ${line.slice(0, 120)}${slow ? ` ${words(60)}` : ''}`;
    return {
      text,
      thinking: u.includes('THINK') ? 'Thinking about the compat check before answering.' : undefined,
      slowMs: slow ? 2400 : undefined,
      promptTokens: tokens,
    };
  }

  #sse(plan: Plan, model: string, signal: AbortSignal, rec: MockRequest): Response {
    const id = `chatcmpl-compat-${rec.n}`;
    let closed = false;
    signal.addEventListener(
      'abort',
      () => {
        closed = true;
        rec.aborted = true;
      },
      { once: true },
    );
    const stream = new ReadableStream<Uint8Array>({
      async start(ctrl) {
        const emit = (delta: unknown, finish: string | null = null, usage?: unknown) => {
          if (closed) return;
          try {
            const chunk = { id, object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model, choices: [{ index: 0, delta, finish_reason: finish }], ...(usage ? { usage } : {}) };
            ctrl.enqueue(enc.encode(`data: ${JSON.stringify(chunk)}\n\n`));
          } catch {
            closed = true;
          }
        };
        const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
        emit({ role: 'assistant', content: '' });
        if (plan.delayMs) await wait(plan.delayMs);
        if (plan.thinking) {
          for (const p of plan.thinking.match(/.{1,16}/gs) ?? []) {
            emit({ reasoning_content: p });
            await wait(3);
          }
        }
        if (plan.text) {
          const parts = plan.text.match(/.{1,48}/gs) ?? [plan.text];
          const gap = plan.slowMs ? Math.max(5, Math.floor(plan.slowMs / parts.length)) : 2;
          for (const p of parts) {
            if (closed) break;
            emit({ content: p });
            await wait(gap);
          }
        }
        (plan.calls ?? []).forEach((call, index) => {
          emit({ tool_calls: [{ index, id: `call_${rec.n}_${index}`, type: 'function', function: { name: call.name, arguments: JSON.stringify(call.args) } }] });
        });
        const prompt = plan.promptTokens ?? 1200;
        emit({}, plan.calls?.length ? 'tool_calls' : 'stop', { prompt_tokens: prompt, completion_tokens: 30, total_tokens: prompt + 30, prompt_tokens_details: { cached_tokens: 0 } });
        if (!closed) {
          try {
            ctrl.enqueue(enc.encode('data: [DONE]\n\n'));
            ctrl.close();
          } catch {
            /* client went away */
          }
        }
      },
    });
    return new Response(stream, { headers: { 'content-type': 'text/event-stream' } });
  }
}

/** The scratch agent dir's models.yml: CAST's demo-provider shape (keyless openai-completions) with three models. */
export function mockModelsYml(port: number): string {
  return [
    '# omp compat suite: keyless models served by the suite\'s own mock LLM',
    'providers:',
    '  mockp:',
    `    baseUrl: http://127.0.0.1:${port}/v1`,
    '    auth: none',
    '    api: openai-completions',
    '    compat:',
    '      reasoningContentField: reasoning_content',
    '      supportsUsageInStreaming: true',
    '    models:',
    '      - id: "mock-a"',
    '        name: "Mock A (lead)"',
    '        reasoning: true',
    '        input: [text, image]',
    '        cost: { input: 4, output: 20, cacheRead: 0.4, cacheWrite: 5 }',
    '        contextWindow: 1000000',
    '        maxTokens: 32000',
    '      - id: "mock-b"',
    '        name: "Mock B (helper, advisor)"',
    '        reasoning: false',
    '        input: [text, image]',
    '        cost: { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 }',
    '        contextWindow: 200000',
    '        maxTokens: 32000',
    '      - id: "mock-t"',
    '        name: "Mock T (text only, small window)"',
    '        reasoning: false',
    '        input: [text]',
    '        cost: { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 1 }',
    '        contextWindow: 100000',
    '        maxTokens: 8000',
    '',
  ].join('\n');
}
