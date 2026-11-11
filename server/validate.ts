// Shape validation for every ClientMsg. Returns a cleaned copy (unknown keys dropped) or a friendly error.
// Hand-rolled tiny combinators: each validator returns the cleaned value or throws ValidationError.
import { MAX_FLOORS } from '../shared/house-plan';
import { isLoginProvider } from '../shared/omp-logins';
import { LOCAL_SERVER_KINDS, MAX_PROMPT_IMAGES, MAX_WORKFLOW_STEPS, RUNS_PER_ASK_CEILING, THINKING_LEVELS, type ClientMsg } from '../shared/protocol';
import { UPLOAD_ID } from './uploads';

class ValidationError extends Error {
  constructor(
    readonly at: string,
    readonly what: string,
  ) {
    super(`${at} ${what}`);
  }
}

type V<T = unknown> = (v: unknown, at: string) => T;

const fail = (at: string, what: string): never => {
  throw new ValidationError(at, what);
};

// What a person reads when a message is refused: the field in words, not "place_project.name". A refusal normally means
// a client bug (the inputs keep to the limits), but when one shows it should still be a sentence.
const FIELD_WORDS: Record<string, string> = {
  name: 'The name',
  path: 'The folder path',
  text: 'The message',
  brief: 'The description',
  task: 'The task',
  objective: 'The goal',
  images: 'The pictures',
  GEMINI_API_KEY: 'The API key',
  ANTHROPIC_API_KEY: 'The API key',
  OPENAI_API_KEY: 'The API key',
  GOOGLE_CLOUD_PROJECT: 'The project ID',
  apiKey: 'The API key',
  baseUrl: 'The address',
};

function friendlyError(err: ValidationError): string {
  const field = err.at.split('.').at(-1)!.replace(/\[\d+\]$/, '').replace(/ key$/, '');
  const words = FIELD_WORDS[field] ?? `The ${field.replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase()}`;
  const what = err.what.replace(/^is too long \(max (\d+)\)$/, 'is too long (at most $1 characters)');
  return `${words} ${what}.`;
}

const str = (max: number, min = 0): V<string> => (v, at) => {
  if (typeof v !== 'string') return fail(at, 'must be a string');
  if (v.length < min) return fail(at, min === 1 ? 'must not be empty' : `must be at least ${min} characters`);
  if (v.length > max) return fail(at, `is too long (max ${max})`);
  return v;
};

const oneOf = <T extends string>(...values: T[]): V<T> => (v, at) =>
  values.includes(v as T) ? (v as T) : fail(at, `must be one of ${values.join(', ')}`);

const bool: V<boolean> = (v, at) => (typeof v === 'boolean' ? v : fail(at, 'must be true or false'));

const int = (min: number, max: number): V<number> => (v, at) =>
  typeof v === 'number' && Number.isInteger(v) && v >= min && v <= max ? v : fail(at, `must be a whole number ${min}–${max}`);

const optional = <T>(inner: V<T>): V<T | undefined> => (v, at) => (v === undefined ? undefined : inner(v, at));

const nullable = <T>(inner: V<T>): V<T | null> => (v, at) => (v === null ? null : inner(v, at));

const arr = <T>(item: V<T>, min: number, max: number): V<T[]> => (v, at) => {
  if (!Array.isArray(v)) return fail(at, 'must be a list');
  if (v.length < min || v.length > max) return fail(at, `must have ${min}–${max} items`);
  return v.map((x, i) => item(x, `${at}[${i}]`));
};

type Shape = Record<string, V>;
const obj = <S extends Shape>(shape: S): V<{ [K in keyof S]: ReturnType<S[K]> }> => (v, at) => {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return fail(at, 'must be an object');
  const src = v as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const [key, check] of Object.entries(shape)) {
    const value = check(src[key], `${at}.${key}`);
    if (value !== undefined) out[key] = value;
  }
  return out as { [K in keyof S]: ReturnType<S[K]> };
};

// ───────────── field vocabulary ─────────────
const reqId = str(100, 1);
const id = str(200, 1);
const slug: V<string> = (v, at) => {
  const s = str(80, 1)(v, at);
  return /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(s) ? s : fail(at, 'may only use letters, digits, dot, dash and underscore');
};
const style = oneOf('house', 'office', 'cottage', 'studio');
const approvalMode = oneOf('always-ask', 'write', 'auto', 'yolo');
// Project names: projects.ts trims and clips them to MAX_PROJECT_NAME (a picked folder's name can be any length); this
// only keeps out the absurd.
const projectName = (min = 0) => str(1000, min);

// Jobs: the JobStore applies the real rules (trimmed name ≤ 60, room exists and is free, …) with friendlier errors.
const jobKind = oneOf('general', 'code', 'write', 'research');
const workStyle = oneOf('ask', 'auto', 'solo');
const room = obj({ floor: int(0, MAX_FLOORS - 1), slot: int(0, 3) });
const jobName = str(200, 1);
const brief = str(8000);
const model = str(200, 1);
// omp login provider ids ('anthropic', 'openai-codex', …); never starts with '-' so it can't become a CLI flag.
const providerId: V<string> = (v, at) => {
  const s = str(64, 1)(v, at);
  return /^[a-z0-9][a-z0-9.-]*$/.test(s) && !s.includes('..') ? s : fail(at, 'is not a provider id'); // 'llama.cpp'
};

// A sign-in `omp login` offers (shared/omp-login-providers.ts): nothing else reaches omp's command line.
const loginProviderId: V<string> = (v, at) => {
  const s = providerId(v, at);
  return isLoginProvider(s) ? s : fail(at, 'is not a sign-in the agent offers');
};

// omp's id of one stored credential (get_logout_accounts → logout).
const credentialId: V<number> = (v, at) =>
  typeof v === 'number' && Number.isSafeInteger(v) && v > 0 ? v : fail(at, 'must be a positive whole number');

// A provider's account order (set_account_order): distinct credential ids, first = preferred.
const MAX_ORDERED_ACCOUNTS = 32;
const credentialIds: V<number[]> = (v, at) => {
  const ids = arr(credentialId, 0, MAX_ORDERED_ACCOUNTS)(v, at);
  return new Set(ids).size === ids.length ? ids : fail(at, 'must not name an account twice');
};

// A path inside a person's folder (list_files): '/'-separated and relative ('' = the folder itself). The file service
// still resolves it for real (realpath, stays inside, no dot segments); this only refuses what is never valid.
const relPath: V<string> = (v, at) => {
  const s = str(4096)(v, at);
  if (s.includes('\0')) return fail(at, 'is not a valid path');
  if (s.startsWith('/')) return fail(at, 'must be relative to the folder');
  if (s.split('/').some((seg) => seg === '.' || seg === '..')) return fail(at, "must not contain '.' or '..'");
  return s;
};

// An image the browser uploaded (POST UPLOAD_PATH): "<sha256>.<ext>".
const uploadId: V<string> = (v, at) => {
  const s = str(80, 1)(v, at);
  return UPLOAD_ID.test(s) ? s : fail(at, 'is not an uploaded image');
};

/** A small map with slug keys, e.g. answer_plan's step id → model. */
const record = <T>(value: V<T>, max: number): V<Record<string, T>> => (v, at) => {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return fail(at, 'must be an object');
  const entries = Object.entries(v as Record<string, unknown>);
  if (entries.length > max) return fail(at, `has too many entries (max ${max})`);
  const out: Record<string, T> = {};
  for (const [k, x] of entries) out[slug(k, `${at} key`)] = value(x, `${at}.${k}`);
  return out;
};

const workflowStep = obj({
  id: slug,
  name: str(80, 1),
  model: str(200, 1),
  thinking: optional(oneOf(...THINKING_LEVELS)),
  persona: str(20_000),
  instruction: str(20_000),
  kind: oneOf('work', 'review'),
  loopBackTo: optional(slug),
  maxLoops: optional(int(0, 10)),
  parallel: optional(bool),
});

const workflow = obj({
  id: slug,
  name: str(120, 1),
  description: str(2000),
  icon: str(16),
  steps: arr(workflowStep, 1, MAX_WORKFLOW_STEPS),
  builtin: optional(bool),
});

// A change to a going run's plan (edit_run): step references are ids or names (any language); run-edit.ts checks them.
const stepRef = str(200, 1);
const runEditOp = obj({
  op: oneOf('update', 'add', 'remove', 'move', 'note'),
  step: optional(stepRef),
  after: optional(stepRef),
  person: optional(
    obj({
      id: optional(str(80)),
      name: str(80, 1),
      model: optional(str(200)),
      thinking: optional(oneOf(...THINKING_LEVELS)),
      persona: optional(str(20_000)),
      instruction: optional(str(20_000)),
      kind: optional(oneOf('work', 'review')),
      loopBackTo: optional(str(200)),
      maxLoops: optional(int(0, 10)),
      parallel: optional(bool),
    }),
  ),
  name: optional(str(80, 1)),
  model: optional(model),
  thinking: optional(oneOf('' as const, ...THINKING_LEVELS)),
  persona: optional(str(20_000)),
  instruction: optional(str(20_000)),
  add_to_instruction: optional(str(8000, 1)),
  kind: optional(oneOf('work', 'review')),
  loopBackTo: optional(str(200)),
  maxLoops: optional(int(0, 10)),
  parallel: optional(bool),
  text: optional(str(8000, 1)),
});

const SCHEMAS: { [K in ClientMsg['t']]: Shape } = {
  place_project: { reqId, path: str(4096, 1), name: projectName(), lotId: id, style, initGit: optional(bool) },
  init_git: { reqId, projectId: id },
  create_project: { reqId, name: projectName(1), lotId: id, style, template: oneOf('empty', 'node-api', 'novel') },
  move_project: { reqId, projectId: id, lotId: id },
  remove_project: { reqId, projectId: id, deleteHistory: optional(bool) },
  set_project: {
    reqId,
    projectId: id,
    patch: obj({
      name: optional(projectName(1)),
      style: optional(style),
      approvalMode: optional(approvalMode),
      workflowId: optional(nullable(str(80, 1))),
      path: optional(str(4096, 1)), // point the house at another folder (the old one is not touched)
      maxRunsPerAsk: optional(nullable(int(1, RUNS_PER_ASK_CEILING))),
    }),
  },
  enter_project: { projectId: id },
  create_job: {
    reqId,
    projectId: id,
    name: jobName,
    kind: jobKind,
    room,
    leadModel: optional(model),
    leadThinking: optional(oneOf(...THINKING_LEVELS)),
    workflowId: optional(nullable(str(80))),
    brief: optional(brief),
    workStyle: optional(workStyle),
    worktree: optional(bool),
    advisorModel: optional(model),
  },
  update_job: {
    reqId,
    projectId: id,
    jobId: id,
    patch: obj({
      name: optional(jobName),
      kind: optional(jobKind),
      room: optional(room),
      leadModel: optional(model),
      leadThinking: optional(nullable(oneOf(...THINKING_LEVELS))),
      workflowId: optional(nullable(str(80))),
      brief: optional(brief),
      workStyle: optional(workStyle),
      advisorModel: optional(nullable(model)),
    }),
  },
  delete_job: { reqId, projectId: id, jobId: id },
  add_floor: { reqId, projectId: id },
  remove_floor: { reqId, projectId: id },
  list_threads: { agentId: id },
  new_thread: { reqId, agentId: id },
  switch_thread: { reqId, agentId: id, threadId: id },
  delete_thread: { reqId, agentId: id, threadId: id },
  search_threads: { reqId, agentId: id, query: str(200, 1) },
  // text may be empty when images come along (the agent system says "Type a message first." otherwise)
  prompt: { agentId: id, text: str(100_000), reqId: optional(reqId), images: optional(arr(uploadId, 1, MAX_PROMPT_IMAGES)), mode: optional(oneOf('queue', 'steer')) },
  abort: { agentId: id, reqId: optional(reqId) },
  queue_action: { reqId, agentId: id, key: str(200, 1), action: oneOf('remove', 'steer') },
  compact: { reqId, agentId: id },
  goal: { reqId, agentId: id, op: oneOf('create', 'pause', 'resume', 'drop'), objective: optional(str(8000)), tokenBudget: optional(int(1, 1_000_000_000)) },
  get_helper_transcript: { reqId, agentId: id, itemId: str(300, 1) },
  get_transcript: { agentId: id },
  // answers: an ask's, one per question (approvals.ts checks them against the questions); reqId: the page waits for ack
  approve: {
    approvalId: id,
    value: str(500),
    reqId: optional(reqId),
    answers: optional(arr(obj({ id: str(200), selectedOptions: arr(str(2000), 0, 100), customInput: optional(str(20_000)) }), 1, 50)),
  },
  run_workflow: { reqId, projectId: id, jobId: optional(id), workflowId: id, task: str(20_000, 1) },
  abort_run: { runId: id },
  revert_run: { reqId, runId: id, preview: optional(bool) },
  continue_run: { reqId, runId: id, fromStepId: str(200, 1), note: optional(str(8000)), models: optional(record(model, MAX_WORKFLOW_STEPS)) },
  get_run_plan: { reqId, runId: id },
  edit_run: { reqId, runId: id, ops: arr(runEditOp, 1, 20), save: optional(bool), seen: optional(obj({ rev: int(0, 1_000_000), frozen: int(0, MAX_WORKFLOW_STEPS) })) },
  save_workflow: { reqId, projectId: optional(id), workflow },
  delete_workflow: { reqId, projectId: optional(id), workflowId: slug, clearTeams: optional(bool) },
  promote_workflow: { reqId, projectId: id, workflowId: slug, replace: optional(bool) },
  import_workflow: { reqId, projectId: id, workflowId: slug, replace: optional(bool) },
  delete_library_workflow: { reqId, workflowId: slug },
  save_run_team: { reqId, runId: id, name: str(80, 1) },
  answer_plan: { reqId, planId: id, run: bool, models: optional(record(model, MAX_WORKFLOW_STEPS)), thinking: optional(record(oneOf('' as const, ...THINKING_LEVELS), MAX_WORKFLOW_STEPS)) },
  get_git: { projectId: id, jobId: optional(id) },
  bring_job_changes: { reqId, projectId: id, jobId: id, preview: optional(bool), undo: optional(bool) },
  list_leftovers: { reqId, projectId: id },
  leftover_branch: { reqId, projectId: id, branch: str(300, 1), action: oneOf('bring', 'undo', 'delete'), preview: optional(bool) },
  // paths: as the Changes tab lists them (git.ts takes only paths git status lists for the house folder)
  discard_changes: { reqId, projectId: id, paths: arr(str(4096, 1), 1, 1000), preview: optional(bool) },
  list_undone: { reqId, projectId: id },
  bring_back_undone: { reqId, projectId: id, id: str(20, 1), preview: optional(bool) },
  undo_turn: { reqId, agentId: id, itemId: str(200, 1), preview: optional(bool) },
  fs_list: { reqId, path: str(4096) },
  refresh_models: {},
  login_start: { provider: loginProviderId },
  login_input: { loginId: id, value: str(16_384) }, // may be empty: some prompts are optional ("blank for github.com")
  login_cancel: { loginId: id },
  get_omp_env: { reqId },
  // values are checked (and cleaned) by omp-env.ts; here only their size — a key is never echoed in an error
  set_omp_env: {
    reqId,
    patch: obj({
      GOOGLE_CLOUD_PROJECT: optional(nullable(str(200))),
      GEMINI_API_KEY: optional(nullable(str(400))),
      ANTHROPIC_API_KEY: optional(nullable(str(400))),
      OPENAI_API_KEY: optional(nullable(str(400))),
    }),
  },
  // names, addresses and keys are checked (and cleaned) by local-models.ts; here only their size and the kind
  list_local_servers: { reqId },
  test_local_server: { reqId, kind: oneOf(...LOCAL_SERVER_KINDS), baseUrl: str(2048, 1), apiKey: optional(str(400)), name: optional(str(64)) },
  save_local_server: { reqId, name: str(64, 1), kind: oneOf(...LOCAL_SERVER_KINDS), baseUrl: str(2048, 1), apiKey: optional(nullable(str(400))) },
  remove_local_server: { reqId, name: str(64, 1) },
  list_accounts: { reqId },
  logout_account: { reqId, provider: providerId, credentialId },
  get_usage: { reqId, force: optional(bool) },
  get_account_order: { reqId, force: optional(bool) },
  set_account_order: { reqId, provider: providerId, credentialIds },
  set_chat_account: { reqId, agentId: id, threadId: optional(id), provider: providerId, credentialId: nullable(credentialId) },
  files_key: { reqId, projectId: id, jobId: optional(id) },
  list_files: { reqId, projectId: id, jobId: optional(id), dir: relPath },
  find_files: { reqId, projectId: id, jobId: optional(id), query: optional(str(200)) },
};

export type ParseResult = { ok: true; msg: ClientMsg } | { ok: false; error: string; reqId?: string };

export const MAX_FRAME_CHARS = 1024 * 1024;

export function parseClientMsg(raw: string): ParseResult {
  if (raw.length > MAX_FRAME_CHARS) return { ok: false, error: 'Message too large' };
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return { ok: false, error: 'Message is not valid JSON' };
  }
  if (typeof data !== 'object' || data === null || Array.isArray(data)) return { ok: false, error: 'Message must be a JSON object' };
  const rec = data as Record<string, unknown>;
  const maybeReqId = typeof rec.reqId === 'string' && rec.reqId.length <= 100 ? rec.reqId : undefined;
  const t = rec.t;
  if (typeof t !== 'string' || !Object.hasOwn(SCHEMAS, t)) {
    return { ok: false, error: `Unknown message type ${JSON.stringify(t)}`, reqId: maybeReqId };
  }
  try {
    const body = obj(SCHEMAS[t as ClientMsg['t']])(rec, t);
    return { ok: true, msg: { ...body, t } as ClientMsg };
  } catch (err) {
    if (err instanceof ValidationError) return { ok: false, error: friendlyError(err), reqId: maybeReqId };
    throw err;
  }
}
