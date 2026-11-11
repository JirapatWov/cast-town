// Finding #28: tool cards showed their input as JSON (`Input { "path": "." }`). web/src/ui/tool-args.ts turns simple
// inputs into lines of words and keeps JSON only for nested or long ones. Run: bun test tests/chat/tool-args.test.ts
import { describe, expect, test } from 'bun:test';
import { keyWords, toolArgsText } from '../../web/src/ui/tool-args';

describe('a tool card’s input in words', () => {
  test('the project folder reads as “this folder”, keys as words', () => {
    expect(toolArgsText({ path: '.' })).toBe('Path: this folder');
    expect(toolArgsText({ file_path: 'src/app.ts', limit: 40, recursive: true })).toBe('File path: src/app.ts\nLimit: 40\nRecursive: yes');
    expect(keyWords('maxResults')).toBe('Max results');
  });

  test('a command on several lines starts on its own line; short lists are joined', () => {
    expect(toolArgsText({ command: 'npm test\nnpm run lint' })).toBe('Command:\nnpm test\nnpm run lint');
    expect(toolArgsText({ paths: ['a.md', 'b.md'] })).toBe('Paths: a.md, b.md');
  });

  test('nested or long input stays JSON; nothing stays nothing; text stays text', () => {
    expect(toolArgsText({ edits: [{ old: 'a', new: 'b' }] })).toBe(JSON.stringify({ edits: [{ old: 'a', new: 'b' }] }, null, 2));
    expect(toolArgsText({ content: 'x'.repeat(500) })!.startsWith('{')).toBe(true);
    expect(toolArgsText(undefined)).toBeNull();
    expect(toolArgsText({})).toBeNull();
    expect(toolArgsText('ls -la')).toBe('ls -la');
  });
});
