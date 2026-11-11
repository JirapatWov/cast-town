// FINDING (owner, ask cards): an agent's `ask` showed as a card that said only "Details: ตั้งค่า" — the header chip. The
// question itself, every option's description and which option was recommended were dropped by ApprovalBook.offer,
// only the first question of a call was shown, and the others were answered silently with their recommended option.
// omp's rpc `ask` frame (AskUiRequest) carries every question: {id, question, header?, options[{label,
// description?}], multi?, recommended?}; the answer is {answers: [{id, selectedOptions, customInput?}]}, one per
// question in question order (omp's rpc-mode.ts parseAskDialogResponse refuses anything else).
// Run: bun test tests/chat/approval-ask.test.ts
import { describe, expect, test } from 'bun:test';
import type { ApprovalRequest, ServerMsg } from '../../shared/protocol';
import { ApprovalBook } from '../../server/agents/approvals';
import { buildStatus } from '../../server/app-routes';
import { parseClientMsg } from '../../server/validate';

/** A Thai question with a header chip, option descriptions and a recommended option. */
const CONFIG = {
  id: 'config',
  header: 'ตั้งค่า',
  question: 'เก็บค่าตั้งค่าไว้ที่ไหนดีครับ? ตอนนี้ทุกค่าอยู่ใน config.json ที่รากโปรเจกต์ ปนกับคีย์ API',
  options: [
    {
      label: 'แยกคีย์ API ไปไว้ใน .env',
      description: 'ค่าทั่วไปอยู่ใน config.json ตามเดิม ส่วนคีย์ย้ายไป .env ที่ไม่ขึ้น git และเพิ่ม .env.example ไว้เป็นตัวอย่าง',
    },
    {
      label: 'settings.ts (ค่าเริ่มต้นในโค้ด อ่านค่าทับจากตัวแปรแวดล้อม)',
      description: 'ลบ config.json ทิ้ง ค่าเริ่มต้นอยู่ในโค้ด ส่วนคีย์อ่านจากตัวแปรแวดล้อม โปรเจกต์จะไม่มีไฟล์ตั้งค่าแยก',
    },
  ],
  recommended: 0,
};

/** A second question that takes several answers. */
const ROOMS = {
  id: 'rooms',
  header: 'Rooms',
  question: 'Which rooms should get built-in storage?',
  options: [{ label: 'Hall' }, { label: 'Guest bath', description: 'Under the basin' }, { label: 'Stairs', description: 'Drawers in the steps' }],
  multi: true,
};

function world() {
  const sent: ServerMsg[] = [];
  const replies: unknown[] = [];
  const book = new ApprovalBook({ broadcast: (m) => void sent.push(m), clients: () => [] }, { added: () => {}, resolved: () => {} });
  const offer = (frame: Record<string, unknown>) => book.offer({ id: 'ui-1', ...frame }, 'house:assistant', 'house', (p) => void replies.push(p));
  const card = () => sent.findLast((m): m is Extract<ServerMsg, { t: 'approval' }> => m.t === 'approval')?.approval as ApprovalRequest;
  return { book, sent, replies, offer, card };
}

describe('an ask card keeps the whole question', () => {
  test('the owner’s question: its text, header, both options with their descriptions, and the recommended one', () => {
    const w = world();
    expect(w.offer({ method: 'ask', questions: [CONFIG] })).toBe(true);
    const a = w.card();
    expect(a.tool).toBe('ask');
    expect(a.title).toBe(CONFIG.question);
    expect(a.questions).toEqual([CONFIG]);
  });
});

describe('the user answers every question', () => {
  test('two questions, the second multi: both are on the card and both answers reach omp in question order', () => {
    const w = world();
    w.offer({ method: 'ask', questions: [CONFIG, ROOMS] });
    expect(w.card().questions).toEqual([CONFIG, ROOMS]);
    expect(w.replies).toEqual([]); // nothing answered on the user's behalf
    // the page may list them in any order; omp gets them in its own, own words trimmed
    w.book.answer('ui-1', '', [
      { id: 'rooms', selectedOptions: ['Hall', 'Stairs'], customInput: '  the attic too ' },
      { id: 'config', selectedOptions: [CONFIG.options[1].label] },
    ]);
    expect(w.replies).toEqual([
      {
        answers: [
          { id: 'config', selectedOptions: ['settings.ts (ค่าเริ่มต้นในโค้ด อ่านค่าทับจากตัวแปรแวดล้อม)'] },
          { id: 'rooms', selectedOptions: ['Hall', 'Stairs'], customInput: 'the attic too' },
        ],
      },
    ]);
    expect(w.book.get('ui-1')).toBeUndefined();
    expect(w.sent.at(-1)).toEqual({ t: 'approval_resolved', id: 'ui-1' });
  });

  test('own words instead of an option, and a multi question left empty (omp takes "none of these")', () => {
    const w = world();
    w.offer({ method: 'ask', questions: [CONFIG, ROOMS] });
    w.book.answer('ui-1', '', [
      { id: 'config', selectedOptions: [], customInput: 'เก็บใน secrets manager ของเซิร์ฟเวอร์' },
      { id: 'rooms', selectedOptions: [] },
    ]);
    expect(w.replies).toEqual([{ answers: [{ id: 'config', selectedOptions: [], customInput: 'เก็บใน secrets manager ของเซิร์ฟเวอร์' }, { id: 'rooms', selectedOptions: [] }] }]);
  });
});

describe('answers that don’t fit are refused, never guessed', () => {
  const cases: [string, { id: string; selectedOptions: string[]; customInput?: string }[], string][] = [
    ['a single-choice question left open', [{ id: 'rooms', selectedOptions: ['Hall'] }], 'Answer question 1 first.'],
    ['two answers to a single-choice question', [{ id: 'config', selectedOptions: [CONFIG.options[0].label], customInput: 'or both' }, { id: 'rooms', selectedOptions: [] }], 'Pick one answer to question 1.'],
    ['a label the question doesn’t have', [{ id: 'config', selectedOptions: [CONFIG.options[0].label] }, { id: 'rooms', selectedOptions: ['Attic'] }], '“Attic” is not one of the answers to question 2.'],
  ];
  for (const [what, answers, problem] of cases) {
    test(`${what}: the user is told, omp hears nothing and the card stays`, () => {
      const w = world();
      w.offer({ method: 'ask', questions: [CONFIG, ROOMS] });
      expect(() => w.book.answer('ui-1', '', answers)).toThrow(problem);
      expect(w.replies).toEqual([]);
      expect(w.book.get('ui-1')?.questions).toHaveLength(2);
    });
  }
});

describe('a page from before whole questions (it sends one option label as value)', () => {
  test('a one-question ask is answered with that label', () => {
    const w = world();
    w.offer({ method: 'ask', questions: [CONFIG] });
    w.book.answer('ui-1', CONFIG.options[0].label);
    expect(w.replies).toEqual([{ answers: [{ id: 'config', selectedOptions: ['แยกคีย์ API ไปไว้ใน .env'] }] }]);
  });

  test('an ask with more questions is not answered for the user: they are told to reload', () => {
    const w = world();
    w.offer({ method: 'ask', questions: [CONFIG, ROOMS] });
    expect(() => w.book.answer('ui-1', CONFIG.options[0].label)).toThrow('This question has 2 parts — reload CAST to see and answer them all.');
    expect(w.replies).toEqual([]);
    expect(w.book.get('ui-1')).toBeDefined();
  });
});

describe('other dialogs', () => {
  test('a choice keeps its prompt and each option’s description; a tool approval stays as it was', () => {
    const w = world();
    w.offer({ method: 'select', title: 'Which plan should I follow?\nThe second one takes longer.', options: ['Fast', 'Thorough'], optionDetails: [{ description: ' Skips the review ' }, {}] });
    expect(w.card()).toMatchObject({ tool: 'choice', title: 'Which plan should I follow?', detail: 'The second one takes longer.', options: ['Fast', 'Thorough'], optionNotes: ['Skips the review', ''] });
    w.book.answer('ui-1', 'Thorough');
    expect(w.replies).toEqual([{ value: 'Thorough' }]);

    const t = world();
    t.offer({ method: 'select', title: 'Allow tool: bash\nCommand: ls', options: ['Approve', 'Deny'] });
    expect(t.card()).toEqual({ id: 'ui-1', agentId: 'house:assistant', projectId: 'house', ts: t.card().ts, tool: 'bash', title: 'Allow tool: bash', detail: 'Command: ls', options: ['Approve', 'Deny'] });
  });

  test('an ask omp sent without proper questions is cancelled at once, so omp never waits on it', () => {
    const w = world();
    expect(w.offer({ method: 'ask', questions: [CONFIG, { id: 'x' }] })).toBe(false);
    expect(w.replies).toEqual([{ cancelled: true }]);
    expect(w.book.list()).toEqual([]);
  });
});

describe('the approve message carries the answers', () => {
  test('answers (and a reqId for the reply) pass validation; unknown keys are dropped', () => {
    const r = parseClientMsg(JSON.stringify({ t: 'approve', reqId: 'r1', approvalId: 'ui-1', value: '', answers: [{ id: 'config', selectedOptions: [CONFIG.options[0].label], customInput: 'x', extra: 1 }] }));
    expect(r).toEqual({ ok: true, msg: { t: 'approve', reqId: 'r1', approvalId: 'ui-1', value: '', answers: [{ id: 'config', selectedOptions: ['แยกคีย์ API ไปไว้ใน .env'], customInput: 'x' }] } });
    // an older page: value only
    expect(parseClientMsg(JSON.stringify({ t: 'approve', approvalId: 'ui-1', value: 'Approve' }))).toEqual({ ok: true, msg: { t: 'approve', approvalId: 'ui-1', value: 'Approve' } });
  });

  test('answers of the wrong shape are refused', () => {
    for (const answers of [{}, [{ id: 'config' }], [{ id: 'config', selectedOptions: [1] }], [{ id: 'config', selectedOptions: [], customInput: 'x'.repeat(20_001) }]]) {
      expect(parseClientMsg(JSON.stringify({ t: 'approve', approvalId: 'ui-1', value: '', answers })).ok).toBe(false);
    }
  });
});

describe('the menu bar (/api/status attention) says what is asked', () => {
  const status = (approvals: ApprovalRequest[]) =>
    buildStatus({
      version: '0.1.0', cityName: 'Studio', url: 'http://127.0.0.1:4860/', uptimeSec: 1,
      snapshot: { agents: [], approvals, plans: [], runs: [], providers: [] },
      projects: [{ id: 'house', name: 'Home' }], ompVersion: null, demo: false, errorSince: new Map(), now: 1,
    }).attention.map((a) => [a.kind, a.title]);
  const card = (frame: Record<string, unknown>) => {
    const w = world();
    w.offer(frame);
    return w.card();
  };

  test('an ask: its header and question; with more questions, how many', () => {
    expect(status([card({ method: 'ask', questions: [CONFIG] })])).toEqual([['question', 'ตั้งค่า: เก็บค่าตั้งค่าไว้ที่ไหนดีครับ? ตอนนี้ทุกค่าอยู่ใน config.json ที่รากโปรเจกต์ ปนกับคีย์ API']]);
    const [[kind, title]] = status([card({ method: 'ask', questions: [CONFIG, ROOMS] })]);
    expect(kind).toBe('question');
    expect(title).toStartWith('2 questions · ตั้งค่า: เก็บค่าตั้งค่าไว้ที่ไหนดีครับ?');
  });

  test('a confirm and a choice are questions too, with their prompt; a tool approval is unchanged', () => {
    expect(status([card({ method: 'confirm', title: 'Delete the old config file?', message: 'It has no copy.' })])).toEqual([['question', 'Delete the old config file? — It has no copy.']]);
    expect(status([card({ method: 'select', title: 'Which plan should I follow?\nThe second one takes longer.', options: ['Fast', 'Thorough'] })])).toEqual([['question', 'Which plan should I follow?']]);
    expect(status([card({ method: 'select', title: 'Allow tool: bash\nCommand: ls', options: ['Approve', 'Deny'] })])).toEqual([['approval', 'Allow tool: bash']]);
  });

  test('an ask card without options (saved by an older CAST) still has its line: the menu bar and push never throw on it', () => {
    const old = { id: 'q1', agentId: 'a1', projectId: 'house', tool: 'ask', title: 'Which config file?', detail: 'ตั้งค่า', ts: 1 } as unknown as ApprovalRequest;
    expect(status([old])).toEqual([['question', 'ตั้งค่า: Which config file?']]);
  });
});
