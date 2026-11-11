// Find in this chat (chat-find.ts): what the chat keeps folded away until asked. Pure (no DOM).
import type { TranscriptItem } from '../../../shared/protocol';
import { toolArgsText } from './tool-args';

/** The text of a transcript item that the chat keeps folded away until asked: a tool's input and output, a reply's
 *  thinking. Which items have the query only there (pure, for tests). */
export function foldedMatches(items: TranscriptItem[], query: string): { tools: string[]; thinking: string[] } {
  const q = query.trim().toLowerCase();
  const out = { tools: [] as string[], thinking: [] as string[] };
  if (!q) return out;
  for (const it of items) {
    if (it.kind === 'tool') {
      const hidden = `${it.result ?? ''}\n${toolArgsText(it.args) ?? ''}`.toLowerCase(); // as the card shows it
      if (hidden.includes(q)) out.tools.push(it.id);
    } else if (it.kind === 'assistant' && it.thinking?.toLowerCase().includes(q)) out.thinking.push(it.id);
  }
  return out;
}
