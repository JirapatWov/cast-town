// Parse an OpenAI chat-completions request (as omp sends it) into what the demo scripts need:
// who is talking (role marker / subagent / judgment call), the project cwd, the latest user ask, and the
// tool calls already made in the current turn (with their results).

export interface ToolCallRecord {
  id: string;
  name: string;
  args: Record<string, unknown>;
  step: string | null; // demo-script step that produced it (encoded in the tool-call id)
  result: string | null; // tool result text, null while missing
}

export interface Conversation {
  model: string; // e.g. "claude-opus-5-5" (the rlt-demo model id)
  system: string;
  role: string | null; // [rlt-role:…] marker → main persona; null → subagent / side request
  stepKind: string | null; // [rlt-step-kind:…]
  cwd: string | null;
  tools: Set<string>;
  /** How this model's `edit` tool takes changes: hashline patches, old/new string replacement, or not at all. */
  editMode: 'hashline' | 'replace' | 'none';
  isJudgment: boolean; // omp's auto-thinking classifier side request
  userText: string; // latest real user message (system reminders stripped)
  isWake: boolean; // latest user message is a "background jobs completed" notice
  wakeText: string;
  wakeTexts: string[]; // every "background jobs completed" notice in the session (oldest first)
  spawnedTasks: number; // helpers requested through `task` calls anywhere in the session
  userTexts: string[]; // every real user message in the session (oldest first)
  turn: ToolCallRecord[]; // tool calls since the latest user message
  /** Notes the user sent into the step working now (a running team's "Send a note", team_edit's note): they arrive
   *  mid-turn and don't start a new ask — the step goes on. */
  stepNotes: string[];
  promptChars: number; // rough size of the whole request (usage estimate)
}

const STEP_NOTE = /Note from the user for your current step:\n([\s\S]*?)(?:\n\nKeep going with your step\b|$)/;

type Part = { type?: string; text?: string };
interface Msg {
  role: string;
  content?: string | Part[] | null;
  tool_calls?: { id: string; function?: { name?: string; arguments?: string } }[];
  tool_call_id?: string;
}

export const STEP_ID = /^rlt_([a-z0-9-]+)_\w+$/i;

function contentText(c: Msg['content']): string {
  if (typeof c === 'string') return c;
  if (Array.isArray(c)) return c.map((p) => (typeof p === 'string' ? p : (p?.text ?? ''))).join('\n');
  return '';
}

function stripReminders(s: string): string {
  return s.replace(/<system-reminder\b[^>]*>[\s\S]*?<\/system-reminder>/g, '').trim();
}

interface ToolDef {
  function?: { name?: string; parameters?: { properties?: Record<string, unknown> } };
}

function editModeOf(tools: ToolDef[]): Conversation['editMode'] {
  const props = tools.find((t) => t.function?.name === 'edit')?.function?.parameters?.properties ?? null;
  if (!props) return 'none';
  if ('input' in props) return 'hashline';
  if ('old_string' in props) return 'replace';
  return 'none';
}

export function parseConversation(body: { model?: string; messages?: Msg[]; tools?: ToolDef[] }): Conversation {
  const messages = Array.isArray(body.messages) ? body.messages : [];
  const system = messages.filter((m) => m.role === 'system' || m.role === 'developer').map((m) => contentText(m.content)).join('\n');
  const tools = new Set((body.tools ?? []).map((t) => t.function?.name ?? '').filter(Boolean));
  const role = system.match(/\[rlt-role:([^\]\s]+)\]/)?.[1] ?? null;
  const stepKind = system.match(/\[rlt-step-kind:([^\]\s]+)\]/)?.[1] ?? null;

  let cwd: string | null = null;
  const userTexts: string[] = [];
  const wakeTexts: string[] = [];
  const stepNotes: string[] = [];
  let spawnedTasks = 0;
  let lastUser = -1;
  for (const [i, m] of messages.entries()) {
    if (m.role === 'assistant') {
      for (const tc of m.tool_calls ?? []) {
        if (tc.function?.name !== 'task') continue;
        try {
          const a = JSON.parse(tc.function.arguments ?? '{}') as { tasks?: unknown[] };
          spawnedTasks += Array.isArray(a.tasks) ? a.tasks.length : 1;
        } catch {
          spawnedTasks += 1;
        }
      }
    }
    if (m.role !== 'user') continue;
    const raw = contentText(m.content);
    cwd ??= raw.match(/current working directory: '([^']+)'/)?.[1] ?? null;
    const text = stripReminders(raw);
    // Reminder-only messages (omp's style-rule notes after a tool ran, …) continue the current turn, and so do omp's
    // own interrupts (`<system-interrupt reason="tool_call_loop_detected">`): read as a new ask, the script would start
    // over with the same call and loop forever.
    if (!text || /^<system-interrupt\b/.test(text)) continue;
    // A note steered into a workflow step continues that step's turn (read as a new ask, the step would start over).
    const note = STEP_NOTE.exec(text);
    if (note && lastUser >= 0) {
      stepNotes.push(note[1]!.trim());
      continue;
    }
    lastUser = i;
    if (/^<system-notice>/.test(text)) wakeTexts.push(text);
    else userTexts.push(text);
  }
  const lastRaw = lastUser >= 0 ? stripReminders(contentText(messages[lastUser].content)) : '';
  const isWake = /^<system-notice>/.test(lastRaw) && /background job|task-result/i.test(lastRaw);

  const results = new Map<string, string>();
  for (const m of messages.slice(lastUser + 1)) if (m.role === 'tool' && m.tool_call_id) results.set(m.tool_call_id, contentText(m.content));
  const turn: ToolCallRecord[] = [];
  for (const m of messages.slice(lastUser + 1)) {
    if (m.role !== 'assistant') continue;
    for (const tc of m.tool_calls ?? []) {
      let args: Record<string, unknown> = {};
      try {
        args = JSON.parse(tc.function?.arguments ?? '{}') as Record<string, unknown>;
      } catch {
        /* keep {} */
      }
      turn.push({ id: tc.id, name: tc.function?.name ?? '', args, step: tc.id.match(STEP_ID)?.[1] ?? null, result: results.get(tc.id) ?? null });
    }
  }

  return {
    model: body.model ?? 'demo',
    system,
    role,
    stepKind,
    cwd,
    tools,
    editMode: editModeOf(body.tools ?? []),
    isJudgment: /Choose the reasoning effort|judgment question|submit_judgment/i.test(system) || tools.has('submit_judgment'),
    userText: isWake ? (userTexts.at(-1) ?? '') : lastRaw,
    isWake,
    wakeText: isWake ? lastRaw : '',
    wakeTexts,
    spawnedTasks,
    userTexts,
    turn,
    stepNotes,
    promptChars: JSON.stringify(body.messages ?? []).length + JSON.stringify(body.tools ?? []).length,
  };
}
