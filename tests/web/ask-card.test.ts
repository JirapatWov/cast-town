// The ask card's logic without a DOM (web/src/ui/ask-draft.ts, approval-text.ts): what the user picked on the card,
// whether every question is answered, the answers in omp's shape, and what the notification and the screen reader
// say. Before, a card showed only an ask's header ("ตั้งค่า") and the notification said "ask: ตั้งค่า".
// Run: bun test tests/web/ask-card.test.ts
import { describe, expect, test } from 'bun:test';
import type { ApprovalRequest, AskQuestion } from '../../shared/protocol';
import { askState, draftAnswers, newDraft, pick, setOwnWords, toggleOwnWords } from '../../web/src/ui/ask-draft';
import { approvalAnnouncement, approvalNotice } from '../../web/src/ui/approval-text';

const CONFIG: AskQuestion = {
  id: 'config',
  header: 'ตั้งค่า',
  question: 'เก็บค่าตั้งค่าไว้ที่ไหนดีครับ? ตอนนี้ทุกค่าอยู่ใน config.json ที่รากโปรเจกต์ ปนกับคีย์ API',
  options: [
    { label: 'แยกคีย์ API ไปไว้ใน .env', description: 'ค่าทั่วไปอยู่ใน config.json ตามเดิม ส่วนคีย์ย้ายไป .env ที่ไม่ขึ้น git และเพิ่ม .env.example ไว้เป็นตัวอย่าง' },
    { label: 'settings.ts (ค่าเริ่มต้นในโค้ด อ่านค่าทับจากตัวแปรแวดล้อม)', description: 'ลบ config.json ทิ้ง ค่าเริ่มต้นอยู่ในโค้ด ส่วนคีย์อ่านจากตัวแปรแวดล้อม โปรเจกต์จะไม่มีไฟล์ตั้งค่าแยก' },
  ],
  recommended: 0,
};
const ROOMS: AskQuestion = { id: 'rooms', question: 'Which rooms get storage?', options: [{ label: 'Hall' }, { label: 'Stairs' }], multi: true };

describe('the ask card’s draft', () => {
  test('nothing is picked for the user: a single-choice question must be answered before Send', () => {
    const d = newDraft();
    expect(askState([CONFIG, ROOMS], d)).toEqual({ ok: false, problem: 'Answer question 1 first.', questionId: 'config' });
    pick(d, CONFIG, CONFIG.options[1].label);
    expect(askState([CONFIG, ROOMS], d).ok).toBe(true); // the multi question may stay empty
  });

  test('single choice: a new pick replaces the old one, and own words replace a pick', () => {
    const d = newDraft();
    pick(d, CONFIG, CONFIG.options[0].label);
    pick(d, CONFIG, CONFIG.options[1].label);
    expect(draftAnswers([CONFIG], d)).toEqual([{ id: 'config', selectedOptions: ['settings.ts (ค่าเริ่มต้นในโค้ด อ่านค่าทับจากตัวแปรแวดล้อม)'] }]);
    toggleOwnWords(d, CONFIG);
    expect(askState([CONFIG], d)).toMatchObject({ ok: false }); // own words chosen but still empty
    setOwnWords(d, CONFIG, '  เก็บใน secrets manager ของเซิร์ฟเวอร์ ');
    expect(draftAnswers([CONFIG], d)).toEqual([{ id: 'config', selectedOptions: [], customInput: 'เก็บใน secrets manager ของเซิร์ฟเวอร์' }]);
    pick(d, CONFIG, CONFIG.options[0].label); // back to an option: the words are kept for later but not sent
    expect(draftAnswers([CONFIG], d)).toEqual([{ id: 'config', selectedOptions: ['แยกคีย์ API ไปไว้ใน .env'] }]);
  });

  test('several: picks toggle, own words come along, all in omp’s shape and question order', () => {
    const d = newDraft();
    pick(d, ROOMS, 'Stairs');
    pick(d, ROOMS, 'Hall');
    pick(d, ROOMS, 'Stairs');
    pick(d, ROOMS, 'Stairs');
    toggleOwnWords(d, ROOMS);
    setOwnWords(d, ROOMS, 'the attic');
    pick(d, CONFIG, CONFIG.options[0].label);
    expect(draftAnswers([CONFIG, ROOMS], d)).toEqual([
      { id: 'config', selectedOptions: ['แยกคีย์ API ไปไว้ใน .env'] },
      { id: 'rooms', selectedOptions: ['Hall', 'Stairs'], customInput: 'the attic' },
    ]);
  });
});

describe('what the notification and the screen reader say', () => {
  const ask: ApprovalRequest = { id: 'ui-1', agentId: 'a', projectId: 'p', ts: 1, tool: 'ask', title: CONFIG.question, detail: 'ตั้งค่า', options: CONFIG.options.map((o) => o.label), questions: [CONFIG] };

  test('an ask: the person asks, the body is the question (not just its header)', () => {
    const n = approvalNotice(ask, 'Assistant');
    expect(n.title).toBe('Assistant asks you');
    expect(n.body).toBe('ตั้งค่า: เก็บค่าตั้งค่าไว้ที่ไหนดีครับ? ตอนนี้ทุกค่าอยู่ใน config.json ที่รากโปรเจกต์ ปนกับคีย์ API');
    expect(approvalAnnouncement(ask, 'Assistant', 'Home')).toBe(`Assistant in Home asks: ${n.body}. Answer on the card or in the Inbox.`);
  });

  test('a tool approval reads as before', () => {
    const tool: ApprovalRequest = { id: 'ui-2', agentId: 'a', projectId: 'p', ts: 1, tool: 'bash', title: 'Allow tool: bash', detail: 'Command: ls -la', options: ['Approve', 'Deny'] };
    expect(approvalNotice(tool, 'Assistant')).toEqual({ title: 'Assistant needs your OK', body: 'bash: Command: ls -la' });
    expect(approvalNotice({ ...tool, autoReason: 'it deletes files' }, 'Assistant').body).toBe('Auto mode: it deletes files\nbash: Command: ls -la');
    expect(approvalAnnouncement(tool, 'Assistant', undefined)).toBe('Assistant needs your approval to use bash. Answer on the card or in the Inbox.');
  });

  test('a tool omp says nothing about (browser inside an eval cell) names the step it comes from', () => {
    const browser: ApprovalRequest = { id: 'ui-3', agentId: 'a', projectId: 'p', ts: 1, tool: 'browser', title: 'Allow tool: browser', options: ['Approve', 'Deny'], from: { tool: 'eval', intent: 'Wait for redirect and render', code: "await browser.open('http://localhost:3000')" } };
    expect(approvalNotice(browser, 'Assistant').body).toBe('browser: From the eval step “Wait for redirect and render”');
  });
});
