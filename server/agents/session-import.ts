// Read an omp session file (<ISO-time>_<uuid>.jsonl) back into RLT transcript items. Used once per person to turn
// the omp sessions written before RLT kept its own chat history into reopenable threads. Best effort: entries RLT
// does not understand are skipped; a branched session is read in file order.
import { readFileSync } from 'node:fs';
import type { TranscriptItem } from '../../shared/protocol';
import { capArgs, resultText } from './normalize';
import { toolTitle } from './tool-display';
import { truncate } from './util';

const MAX_RESULT = 4096;

export interface ImportedSession {
  title: string | null; // omp's session title (set_session_name / auto title)
  items: TranscriptItem[];
  createdAt: number;
  updatedAt: number;
}

type Block = { type?: string; text?: string; thinking?: string; id?: string; name?: string; arguments?: unknown; narration?: boolean };
interface Entry {
  type?: string;
  id?: string;
  timestamp?: string;
  title?: string;
  message?: { role?: string; content?: string | Block[]; toolCallId?: string; isError?: boolean; timestamp?: number };
}

const stripReminders = (s: string) => s.replace(/<system-reminder\b[^>]*>[\s\S]*?<\/system-reminder>/g, '').trim();

function blocks(content: string | Block[] | undefined): Block[] {
  if (typeof content === 'string') return [{ type: 'text', text: content }];
  return Array.isArray(content) ? content : [];
}

export function importOmpSession(file: string, idPrefix: string): ImportedSession | null {
  let raw: string;
  try {
    raw = readFileSync(file, 'utf8');
  } catch {
    return null;
  }
  const items: TranscriptItem[] = [];
  const tools = new Map<string, TranscriptItem & { kind: 'tool' }>();
  let title: string | null = null;
  let createdAt = 0;
  let updatedAt = 0;
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    let e: Entry;
    try {
      e = JSON.parse(line) as Entry;
    } catch {
      continue; // a torn last line after a crash
    }
    const ts = e.timestamp ? Date.parse(e.timestamp) : NaN;
    if (Number.isFinite(ts)) {
      if (!createdAt) createdAt = ts;
      updatedAt = Math.max(updatedAt, ts);
    }
    if ((e.type === 'title' || e.type === 'session') && typeof e.title === 'string' && e.title.trim()) title = e.title.trim();
    if (e.type !== 'message' || !e.message) continue;
    const m = e.message;
    const at = Number.isFinite(ts) ? ts : (m.timestamp ?? Date.now());
    const id = `${idPrefix}:${e.id ?? items.length}`;
    if (m.role === 'user') {
      const text = stripReminders(blocks(m.content).filter((b) => b.type === 'text').map((b) => b.text ?? '').join('\n'));
      if (text) items.push({ kind: 'user', id, text, ts: at });
    } else if (m.role === 'assistant') {
      const bs = blocks(m.content);
      const text = bs.filter((b) => b.type === 'text' || (b.type === 'thinking' && b.narration)).map((b) => b.text ?? b.thinking ?? '').join('');
      const thinking = bs.filter((b) => b.type === 'thinking' && !b.narration).map((b) => b.thinking ?? '').join('\n\n');
      if (text.trim() || thinking.trim()) items.push({ kind: 'assistant', id, text, thinking: thinking || undefined, ts: at });
      for (const b of bs) {
        if (b.type !== 'toolCall' || !b.id) continue;
        const tool: TranscriptItem & { kind: 'tool' } = {
          kind: 'tool',
          id: `${idPrefix}:${b.id}`,
          tool: b.name ?? 'tool',
          title: toolTitle(b.name ?? 'tool', b.arguments),
          args: capArgs(b.arguments),
          status: 'done',
          ts: at,
        };
        tools.set(b.id, tool);
        items.push(tool);
      }
    } else if (m.role === 'toolResult' && m.toolCallId) {
      const tool = tools.get(m.toolCallId);
      if (!tool) continue;
      tool.result = truncate(resultText({ content: m.content }), MAX_RESULT);
      tool.isError = m.isError === true;
      tool.status = tool.isError ? 'error' : 'done';
    }
  }
  if (!items.some((i) => i.kind === 'user' || i.kind === 'assistant')) return null;
  return { title, items, createdAt: createdAt || Date.now(), updatedAt: updatedAt || createdAt || Date.now() };
}
