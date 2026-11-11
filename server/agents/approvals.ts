// Approval cards: omp `extension_ui_request` dialogs that need the user (tool approvals, ask/confirm dialogs),
// surfaced as ApprovalRequest and answered with `extension_ui_response`. They wait for the user as long as it takes
// (like Claude Code) — only the person moving out or omp withdrawing the dialog clears one. In Auto mode tool
// approvals go through auto-review first and only the ones it doesn't clear become cards.
import { checkAskAnswers } from '../../shared/ask';
import type { ApprovalMode, ApprovalOrigin, ApprovalRequest, AskAnswer, AskQuestion } from '../../shared/protocol';
import type { Hub } from '../contracts';
import { UserError } from '../util';
import { approvalChange } from './approval-preview';
import { autoReview } from './auto-review';
import { LEAD_TOOL_NAMES } from './lead-tools';
import type { OmpFrame } from './omp-process';
import { ASSISTANT_ROLE } from './residents';
import { log } from './util';

type UiPayload = { value: string } | { confirmed: boolean } | { cancelled: true } | { answers: AskAnswer[] };

interface Pending {
  req: ApprovalRequest;
  /** omp's answer to the chosen option; an ask's carries the user's answers (checked by answer()). */
  reply: (value: string, answers?: AskAnswer[]) => UiPayload;
  send: (payload: UiPayload) => void;
  /** A tool approval ("Allow tool: …") with the call's arguments when RLT saw it start — Auto mode may answer it. */
  toolCall?: { args: unknown };
  /** Called when Auto mode's rules cleared this step without asking (the chat labels the step, #61). */
  onAuto?: () => void;
}

/** The project's approval mode and the folder this person works in (their job's own copy, or the house), for Auto mode. */
export type ApprovalPolicy = (projectId: string, agentId: string) => { mode: ApprovalMode; dir: string } | undefined;

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** The questions of omp's `ask` frame, kept whole (text, header, options with descriptions, multi, recommended).
 *  null when one of them is not a question: the answers must match omp's list one for one. */
function askQuestions(raw: unknown): AskQuestion[] | null {
  if (!Array.isArray(raw) || !raw.length) return null;
  const out: AskQuestion[] = [];
  for (const q of raw) {
    if (!isRecord(q) || typeof q.id !== 'string' || typeof q.question !== 'string') return null;
    const options = (Array.isArray(q.options) ? q.options : []).filter((o): o is Record<string, unknown> => isRecord(o) && typeof o.label === 'string').map((o) => {
      const description = typeof o.description === 'string' ? o.description.trim() : '';
      return { label: o.label as string, ...(description ? { description } : {}) };
    });
    const header = typeof q.header === 'string' ? q.header.trim() : '';
    const rec = q.recommended;
    out.push({
      id: q.id,
      question: q.question,
      ...(header ? { header } : {}),
      options,
      ...(q.multi === true ? { multi: true } : {}),
      ...(typeof rec === 'number' && Number.isInteger(rec) && rec >= 0 && rec < options.length ? { recommended: rec } : {}),
    });
  }
  return out;
}

export interface ApprovalEvents {
  added(req: ApprovalRequest): void;
  resolved(req: ApprovalRequest, value: string | null): void; // null = cancelled / timed out
}

/** A tool call that is running, as AgentRuntime keeps them (its arguments and what the agent said it is for). */
export interface RunningCall {
  tool: string;
  args: unknown;
  intent?: string;
}

/** An approval card shows the code of the step a tool is called from up to this many characters. */
const ORIGIN_CODE_MAX = 4000;

/** The running step whose code called the tool an "Allow tool: …" dialog names, when omp says nothing else about it
 *  and no call of that tool is running: a tool of eval's own (omp's preludes, e.g. `browser` used in an eval cell).
 *  The step whose code names the tool (the latest started), else the only step running code; none when unclear. */
export function approvalOrigin(title: string, running: RunningCall[]): ApprovalOrigin | undefined {
  const [first = '', ...rest] = title.split('\n');
  if (!first.startsWith('Allow tool: ') || rest.join('').trim()) return undefined;
  const tool = first.slice('Allow tool: '.length).trim();
  if (!tool || running.some((t) => t.tool === tool)) return undefined;
  const withCode = running.flatMap((t) => {
    const code = (t.args as { code?: unknown } | null)?.code;
    return typeof code === 'string' && code.trim() ? [{ ...t, code }] : [];
  });
  const step = withCode.filter((t) => t.code.includes(tool)).at(-1) ?? (withCode.length === 1 ? withCode[0] : undefined);
  if (!step) return undefined;
  const code = step.code.length > ORIGIN_CODE_MAX ? `${step.code.slice(0, ORIGIN_CODE_MAX)}\n…` : step.code;
  return { tool: step.tool, ...(step.intent ? { intent: step.intent } : {}), code };
}

export class ApprovalBook {
  #pending = new Map<string, Pending>();

  constructor(
    private readonly hub: Hub,
    private readonly events: ApprovalEvents,
    private readonly policy: ApprovalPolicy = () => undefined,
  ) {}

  list(): ApprovalRequest[] {
    return [...this.#pending.values()].map((p) => p.req);
  }
  get(id: string): ApprovalRequest | undefined {
    return this.#pending.get(id)?.req;
  }
  pendingFor(agentId: string): ApprovalRequest[] {
    return this.list().filter((r) => r.agentId === agentId);
  }

  /**
   * Turn a UI request into an approval card. Returns false when the dialog is not something the user can
   * answer from a card (free-text input/editor) — those are cancelled right away so omp never hangs. `from`: the
   * running step a tool with nothing to show of its own is called from (approvalOrigin).
   */
  offer(frame: OmpFrame, agentId: string, projectId: string, send: (payload: UiPayload) => void, args?: unknown, onAuto?: () => void, from?: ApprovalOrigin): boolean {
    const id = String(frame.id ?? '');
    const method = String(frame.method ?? '');
    if (!id) return false;
    const base = { id, agentId, projectId, ts: Date.now() };
    let req: ApprovalRequest;
    let reply: Pending['reply'];
    let toolCall: Pending['toolCall'];

    if (method === 'select') {
      const [first = '', ...rest] = String(frame.title ?? '').split('\n');
      const options = Array.isArray(frame.options) ? (frame.options as unknown[]).map(String) : [];
      const tool = first.startsWith('Allow tool: ') ? first.slice('Allow tool: '.length).trim() : 'choice';
      req = { ...base, tool, title: first || 'Choose an option', detail: rest.join('\n').trim() || undefined, options };
      reply = (value) => ({ value });
      if (first.startsWith('Allow tool: ')) {
        toolCall = { args };
        if (from && !req.detail) req.from = from;
      } else {
        // an extension's own choice may describe its options (omp's optionDetails, aligned with options)
        const details = Array.isArray(frame.optionDetails) ? (frame.optionDetails as unknown[]) : [];
        const notes = options.map((_, i) => {
          const d = details[i];
          return isRecord(d) && typeof d.description === 'string' ? d.description.trim() : '';
        });
        if (notes.some(Boolean)) req.optionNotes = notes;
      }
    } else if (method === 'confirm') {
      req = { ...base, tool: 'confirm', title: String(frame.title ?? 'Confirm'), detail: String(frame.message ?? '') || undefined, options: ['Yes', 'No'] };
      reply = (value) => ({ confirmed: value === 'Yes' });
    } else if (method === 'ask') {
      const qs = askQuestions(frame.questions);
      const q = qs?.[0];
      if (!qs || !q) {
        send({ cancelled: true });
        return false;
      }
      const labels = q.options.map((o) => o.label);
      // title / detail / options: the first question as cards showed it before (an older page still reads those)
      req = { ...base, tool: 'ask', title: q.question, detail: q.header, options: labels.length ? labels : ['OK'], questions: qs };
      reply = (_value, answers) => ({ answers: answers ?? [] });
    } else {
      send({ cancelled: true });
      return false;
    }

    const pending: Pending = { req, reply, send, toolCall, onAuto };
    if (this.#autoAnswer(pending)) return true;
    this.#preview(pending);
    this.#pending.set(id, pending);
    this.hub.broadcast({ t: 'approval', approval: pending.req }); // with Auto's reason, when it asked
    this.events.added(pending.req);
    return true;
  }

  /** The project's mode changed: answer what the new mode clears on its own (Auto: reviewed, Bypass: everything). */
  reconsider(projectId: string): void {
    for (const p of [...this.#pending.values()]) {
      if (p.req.projectId !== projectId) continue;
      if (this.#autoAnswer(p)) {
        this.#pending.delete(p.req.id);
        this.hub.broadcast({ t: 'approval_resolved', id: p.req.id });
        this.events.resolved(p.req, null);
      } else if (p.req.autoReason !== undefined && this.policy(projectId, p.req.agentId)?.mode !== 'auto') {
        p.req = { ...p.req, autoReason: undefined };
        this.hub.broadcast({ t: 'approval', approval: p.req });
      }
    }
  }

  /** What an edit / write would change, on the card before Approve (finding #12). Never fails the card. */
  #preview(p: Pending): void {
    if (p.toolCall?.args === undefined) return;
    try {
      const change = approvalChange(p.req.tool, p.toolCall.args, this.policy(p.req.projectId, p.req.agentId)?.dir);
      if (change) p.req = { ...p.req, change };
    } catch (e) {
      log('approve', `couldn't preview ${p.req.tool}: ${(e as Error).message}`);
    }
  }

  /** Answer a tool approval without the user when the project's mode allows it; otherwise note why Auto stopped. */
  #autoAnswer(p: Pending): boolean {
    if (!p.toolCall) return false;
    const approve = p.req.options.find((o) => /^approve( once)?$/i.test(o));
    if (!approve) return false;
    // The lead's team tools are RLT's own (workflows, the job's team, start/check/stop it): no card in any mode
    // — the team's people still ask about their own steps as the mode says. Only leads have them.
    const own = LEAD_TOOL_NAMES.has(p.req.tool) && p.req.agentId.endsWith(`:${ASSISTANT_ROLE}`);
    const policy = this.policy(p.req.projectId, p.req.agentId);
    if (!own && (!policy || (policy.mode !== 'auto' && policy.mode !== 'yolo'))) return false;
    if (!own && policy?.mode === 'auto') {
      const verdict = autoReview(p.req.tool, p.req.detail, p.toolCall.args, { projectDir: policy.dir });
      if (!verdict.allow) {
        p.req = { ...p.req, autoReason: verdict.reason };
        log('approve', `${p.req.agentId}: auto mode asks the user about ${p.req.tool} — ${verdict.reason}`);
        return false;
      }
    }
    try {
      p.send(p.reply(approve));
    } catch {
      /* process already gone */
    }
    // Only steps Auto's rules looked at: not the lead's own team tools, not Bypass (which never looks).
    if (!own && policy?.mode === 'auto') {
      try {
        p.onAuto?.();
      } catch (e) {
        log('approve', `couldn't label an auto-approved step: ${(e as Error).message}`);
      }
    }
    return true;
  }

  /** User answered. Unknown option labels deny (omp treats non-matching answers as deny anyway). An ask takes
   *  `answers`, one per question; answers that don't fit its questions throw (UserError) and the card stays. */
  answer(id: string, value: string, answers?: AskAnswer[]): boolean {
    const p = this.#pending.get(id);
    if (!p) return false;
    const qs = p.req.tool === 'ask' ? p.req.questions : undefined;
    if (qs) {
      // a page from before whole questions sends the label it showed for the first question as `value`
      if (!answers && qs.length > 1) throw new UserError(`This question has ${qs.length} parts — reload CAST to see and answer them all.`);
      const legacy = (q: AskQuestion): AskAnswer =>
        q.options.some((o) => o.label === value) ? { id: q.id, selectedOptions: [value] } : { id: q.id, selectedOptions: [], customInput: value };
      const checked = checkAskAnswers(qs, answers ?? [legacy(qs[0]!)]);
      if (!checked.ok) throw new UserError(checked.problem);
      this.#finish(id, value, true, checked.answers);
      return true;
    }
    const v = p.req.options.includes(value) ? value : (p.req.options.find((o) => /deny|no/i.test(o)) ?? value);
    this.#finish(id, v);
    return true;
  }

  /** omp withdrew the dialog (`cancel` UI request) or the process went away. */
  dismiss(id: string): void {
    this.#finish(id, null, false);
  }

  dismissForAgent(agentId: string, notifyOmp = false): void {
    for (const p of [...this.#pending.values()]) if (p.req.agentId === agentId) this.#finish(p.req.id, null, notifyOmp);
  }

  dispose(): void {
    this.#pending.clear();
  }

  #finish(id: string, value: string | null, notifyOmp = true, answers?: AskAnswer[]) {
    const p = this.#pending.get(id);
    if (!p) return;
    this.#pending.delete(id);
    if (notifyOmp) {
      try {
        p.send(value === null ? { cancelled: true } : p.reply(value, answers));
      } catch {
        /* process already gone */
      }
    }
    this.hub.broadcast({ t: 'approval_resolved', id });
    this.events.resolved(p.req, value);
  }
}
