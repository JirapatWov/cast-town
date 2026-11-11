// Saved workflow definitions, each in one house (project) or in the shared library, persisted to data/workflows.json.
// CAST has no workflows of its own: a house starts with none.
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { MAX_WORKFLOW_STEPS, THINKING_LEVELS, type LibraryWorkflow, type Workflow, type WorkflowStep } from '../../shared/protocol';
import { LEGACY_EXAMPLES } from './legacy-examples';
import { errorText, log } from './util';

/** A workflow or step id. */
export const SLUG = /^[a-z0-9][a-z0-9-]{0,47}$/;
const THINKING = new Set<string>(THINKING_LEVELS);

export class WorkflowValidationError extends Error {}

export const slugify = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48);

/** Step ids that can't be role ids: the folder / agent id segments of other jobs and helpers, and `x-…` — the
 *  people of a run that isn't the job's own team (agent-system: temporary people `x-<step id>`). */
const RESERVED_STEP_IDS = new Set(['jobs', 'sub']);

/** A step id that is safe as a role id: `x-ray` (and `x-x-ray`) → `ray`, `sub` → `sub-role` (the lead's own
 *  `assistant` is refused). */
export function safeStepId(id: string): string {
  let out = id;
  while (out.startsWith('x-')) out = out.slice(2).replace(/^-+/, '');
  if (out !== id) out ||= 'step';
  return RESERVED_STEP_IDS.has(out) ? `${out}-role` : out;
}

/** The parallel group each step belongs to (the index of the group's first step): a step plus the consecutive
 *  steps after it with parallel: true work at the same time. */
export function groupStarts(steps: Pick<WorkflowStep, 'parallel'>[]): number[] {
  const out: number[] = [];
  for (const [i, s] of steps.entries()) out.push(i > 0 && s.parallel ? out[i - 1]! : i);
  return out;
}

/** Validate + normalize an untrusted workflow from the client. Throws WorkflowValidationError. */
export function normalizeWorkflow(raw: unknown): Workflow {
  const fail = (m: string): never => {
    throw new WorkflowValidationError(m);
  };
  if (!raw || typeof raw !== 'object') fail('Workflow must be an object');
  const w = raw as Record<string, unknown>;
  const name = typeof w.name === 'string' ? w.name.trim().slice(0, 80) : '';
  if (!name) fail('Give the workflow a name');
  const id = typeof w.id === 'string' && SLUG.test(w.id) ? w.id : slugify(name) || fail('Workflow id must be a short slug');
  if (!Array.isArray(w.steps) || w.steps.length === 0) fail('A workflow needs at least one step');
  const stepsIn = w.steps as unknown[];
  if (stepsIn.length > MAX_WORKFLOW_STEPS) fail(`A workflow can have at most ${MAX_WORKFLOW_STEPS} steps`);
  const steps: WorkflowStep[] = [];
  const renamed = new Map<string, string>(); // given id → stored id (reserved ids get another one)
  // Ids kept as given: a renamed one never takes them (`x-ray` beside `ray` becomes `ray-2`, not a clash).
  const givenIds = stepsIn.map((s) => (s && typeof s === 'object' ? (s as Record<string, unknown>).id : undefined));
  const kept = new Set(givenIds.filter((id): id is string => typeof id === 'string' && SLUG.test(id) && safeStepId(id) === id));
  for (const [i, s] of stepsIn.entries()) {
    if (!s || typeof s !== 'object') fail(`Step ${i + 1} is invalid`);
    const st = s as Record<string, unknown>;
    const sname = typeof st.name === 'string' ? st.name.trim().slice(0, 40) : '';
    if (!sname) fail(`Step ${i + 1} needs a name`);
    const given = typeof st.id === 'string' && SLUG.test(st.id) ? st.id : slugify(sname);
    if (!given) fail(`Step "${sname}" needs an id`);
    if (given === 'assistant') fail('"assistant" is reserved for the house Assistant');
    let sid = safeStepId(given);
    if (sid !== given) {
      const base = sid;
      for (let n = 2; kept.has(sid) || steps.some((x) => x.id === sid); n++) sid = `${base.slice(0, 45)}-${n}`;
    }
    if (steps.some((x) => x.id === sid)) fail(`Two steps share the id "${sid}"`);
    renamed.set(given, sid);
    const model = typeof st.model === 'string' ? st.model.trim() : '';
    if (!/^[\w.-]+\/[\w./:@-]+$/.test(model)) fail(`Step "${sname}" needs a model like provider/model-id`);
    const kind = st.kind === 'review' ? 'review' : 'work';
    const step: WorkflowStep = {
      id: sid,
      name: sname,
      model,
      kind,
      persona: typeof st.persona === 'string' ? st.persona.slice(0, 4000) : '',
      instruction: typeof st.instruction === 'string' && st.instruction.trim() ? st.instruction.slice(0, 8000) : '{{task}}',
    };
    if (typeof st.thinking === 'string' && THINKING.has(st.thinking)) step.thinking = st.thinking as WorkflowStep['thinking'];
    if (st.parallel === true) {
      if (i === 0) fail(`"${sname}" is the first step, so it can't work at the same time as the step before it`);
      step.parallel = true;
    }
    if (kind === 'review' && typeof st.loopBackTo === 'string' && st.loopBackTo) {
      const target = renamed.get(st.loopBackTo) ?? st.loopBackTo;
      if (!steps.some((x) => x.id === target)) fail(`Step "${sname}" can only loop back to an earlier step`);
      step.loopBackTo = target;
      const ml = Number(st.maxLoops ?? 2);
      step.maxLoops = Number.isFinite(ml) ? Math.max(0, Math.min(5, Math.round(ml))) : 2;
    }
    steps.push(step);
  }
  // A review can't send the work back into its own parallel group (the group runs again as a whole).
  const groups = groupStarts(steps);
  for (const [i, step] of steps.entries()) {
    const t = step.loopBackTo ? steps.findIndex((x) => x.id === step.loopBackTo) : -1;
    if (t >= 0 && groups[t] === groups[i]) fail(`"${step.name}" works at the same time as "${steps[t]!.name}", so it can't send the work back to them — loop back to a step before their group`);
  }
  return {
    id,
    name,
    description: typeof w.description === 'string' ? w.description.slice(0, 400) : '',
    icon: typeof w.icon === 'string' && w.icon.trim() ? [...w.icon.trim()].slice(0, 2).join('') : '⚙️',
    steps,
  };
}

/** What workflow-merge.ts needs of a workflow besides itself: its base — what a lead last sent for it (workflow_save),
 *  or its first version; hand edits never move it — and when the user last set a person's model or effort by hand. */
interface ChatBase {
  workflow: Workflow;
  /** When it became the base (0: seeded). */
  at: number;
  /** Seeded from what was stored when CAST started keeping bases: hand edits made before are in it, unseen. */
  seeded?: true;
  /** step id → when the user last set that person's model / effort by hand (the Workflow tab, a run card). */
  handSet?: Record<string, { model?: number; thinking?: number }>;
}

/** A base row from workflow-bases.json: normalized when it can be, else as it was written (a base is only compared
 *  with, never run — dropping it would lose its hand-edit times and make it seeded again). */
function asBase(raw: unknown): Workflow | null {
  try {
    return normalizeWorkflow(raw);
  } catch {
    const w = raw as Partial<Workflow> | null;
    const ok = !!w && typeof w.id === 'string' && typeof w.name === 'string' && Array.isArray(w.steps) && w.steps.every((s) => s && typeof s === 'object' && typeof s.id === 'string');
    return ok ? (w as Workflow) : null;
  }
}

/** A workflow in the shared library, and where it came from (shared/protocol.ts). */
export type LibraryEntry = LibraryWorkflow;

/** A promote or import that would replace a workflow with the same id there (the caller asks first: replace). */
export class WorkflowExistsError extends WorkflowValidationError {}

/** The moves of an older workflows.json, which read the city: v1 (one list every house saw) → v2 (each workflow in
 *  the houses that use it), and v2 → v3 (the two teams older CAST versions had in every house, legacy-examples.ts,
 *  become each using house's own). */
export interface WorkflowMigration {
  /** Every house there is now. */
  houses(): string[];
  /** The houses that use this workflow: the house's or a job's team, or a run of it (on disk). */
  usersOf(workflowId: string): string[];
}

/** The version of workflows.json this CAST writes. */
const VERSION = 3;

const baseKey = (projectId: string, id: string) => `${projectId}/${id}`;

/** Keep a copy of a file from before a move next to it (once: the first copy is the one from before), written whole. */
function backup(file: string, name: string): void {
  const to = join(dirname(file), name);
  if (!existsSync(file) || existsSync(to)) return;
  const tmp = `${to}.tmp-${process.pid}`;
  writeFileSync(tmp, readFileSync(file));
  renameSync(tmp, to);
}
const isLegacyExampleId = (id: string) => LEGACY_EXAMPLES.some((b) => b.id === id);
/** JSON with object keys in order: the same content whatever order it was written in. */
const canonical = (v: unknown): string =>
  JSON.stringify(v, (_k, x: unknown) => (x && typeof x === 'object' && !Array.isArray(x) ? Object.fromEntries(Object.entries(x).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) : x));
/** An old example team as stored unchanged (e.g. written back by an older CAST): not one a house edited. */
const isUnchangedExample = (w: Workflow): boolean => {
  const ex = LEGACY_EXAMPLES.find((b) => b.id === w.id);
  return !!ex && canonical(normalizeWorkflow(structuredClone(ex))) === canonical(w);
};

/** Move a file that couldn't be read out of the way (<file>.corrupt-<time>) before a new one is written, so it can
 *  still be fixed by hand. Throws when it can't: then nothing may be written over it. */
function moveAside(file: string, at: number, why: string): void {
  if (!existsSync(file)) return;
  const to = `${file}.corrupt-${at}`;
  renameSync(file, to);
  log('flows', `${file} ${why}; moved it to ${to} before writing a new one`);
}

/** What #load found. */
interface Loaded {
  /** A file from before houses was moved: workflow id → the houses each went to. */
  moved: Map<string, string[]> | null;
  /** The file's version: 0 = no file, 1 = from before houses. */
  version: number;
  /** The file is there but can't be read: it isn't moved, and the first write moves it aside first (#aside). */
  unreadable: boolean;
}

/** A copy of an old example team the v3 move gave a house. */
interface Given {
  projectId: string;
  workflow: Workflow;
}

/** Saved workflows. Each one belongs to one house (project): made there (the Workflow tab, a lead, a run card) or
 *  imported there from the library, and only that house lists or runs it. The library is shared: a house's workflow
 *  is promoted into it (a copy), and any house imports a copy from it. Ids are unique per house and in the library,
 *  not overall. */
export class WorkflowStore {
  #houses = new Map<string, Map<string, Workflow>>();
  #library = new Map<string, LibraryEntry>();
  readonly file: string;
  /** Keyed by house + workflow id (baseKey). */
  #bases = new Map<string, ChatBase & { projectId: string }>();
  /** data/workflow-bases.json: the bases outlive a restart, as the leads' chats do. */
  readonly basesFile: string;
  /** The version #persist writes: 2 until the v3 move ran (a stop between the v1 and v3 moves leaves a file that is
   *  moved again), 3 once the file is v3. */
  #version = 2;
  /** Files that were there but couldn't be read: the first write of each moves it aside (moveAside), never over it.
   *  The bases of an unreadable workflows.json go aside with it (they are its workflows'). */
  #aside = { workflows: false, bases: false, at: 0, basesWhy: "couldn't be read when CAST started" };

  constructor(dataDir: string, o: { migrate?: WorkflowMigration } = {}) {
    this.file = join(dataDir, 'workflows.json');
    this.basesFile = join(dataDir, 'workflow-bases.json');
    const loaded = this.#load(o.migrate);
    if (loaded.version >= VERSION) this.#version = VERSION;
    if (loaded.unreadable) this.#aside = { workflows: true, bases: existsSync(this.basesFile), at: Date.now(), basesWhy: "goes with workflows.json, which couldn't be read" };
    this.#loadBases(loaded.moved);
    // v3: the old example teams are no longer in every house; a house that uses one gets its own copy, before any
    // house's people are placed (agents/index.ts), so no team goes missing. Only the real server passes `migrate`.
    const given = o.migrate && !loaded.unreadable && loaded.version < VERSION ? this.#keepExamplesInUse(o.migrate) : null;
    // a given copy starts from a fresh base (a seeded one would make the lead's first save over it refuse once)
    for (const g of given ?? []) this.#bases.set(baseKey(g.projectId, g.workflow.id), { projectId: g.projectId, workflow: structuredClone(g.workflow), at: Date.now() });
    // a workflow saved before CAST kept bases (or whose base was lost) starts from what is stored now
    let seeded = 0;
    for (const [projectId, house] of this.#houses)
      for (const w of house.values())
        if (!this.#bases.has(baseKey(projectId, w.id))) {
          this.#bases.set(baseKey(projectId, w.id), { projectId, workflow: structuredClone(w), at: 0, seeded: true });
          seeded++;
        }
    // the bases first: a stop before workflows.json is written leaves a v2 file, moved again on the next start
    if (seeded || loaded.moved || given?.length) this.#persistBases();
    if (given) this.#finishExamplesMove(given, loaded.version > 0);
  }

  /** What this house can see and run: its own workflows. */
  list(projectId: string): Workflow[] {
    return this.own(projectId);
  }

  get(projectId: string, id: string | null | undefined): Workflow | undefined {
    if (!id) return undefined;
    return this.#houses.get(projectId)?.get(id);
  }

  /** This house's own workflows. */
  own(projectId: string): Workflow[] {
    return [...(this.#houses.get(projectId)?.values() ?? [])];
  }

  /** Every house's own workflows, for the page: house id → its workflows. */
  byHouse(): Record<string, Workflow[]> {
    const out: Record<string, Workflow[]> = {};
    for (const [projectId, house] of this.#houses) if (house.size) out[projectId] = [...house.values()];
    return out;
  }

  /** Every workflow CAST has: every house's, the library's (e.g. the models they name). */
  all(): Workflow[] {
    return [...[...this.#houses.values()].flatMap((h) => [...h.values()]), ...[...this.#library.values()].map((e) => e.workflow)];
  }

  /** Store a workflow in this house (any save: the Workflow tab, a lead, a run card). Its base is set only when it
   *  has none. */
  save(projectId: string, raw: unknown): Workflow {
    const w = normalizeWorkflow(raw);
    this.#house(projectId).set(w.id, w);
    this.#persist();
    if (!this.#bases.has(baseKey(projectId, w.id))) {
      this.#bases.set(baseKey(projectId, w.id), { projectId, workflow: structuredClone(w), at: Date.now() });
      this.#persistBases();
    }
    return w;
  }

  /** Forget a house's workflow. Its base goes too: a new workflow with its id is another one. */
  remove(projectId: string, id: string): boolean {
    const house = this.#houses.get(projectId);
    if (!house?.delete(id)) return false;
    if (!house.size) this.#houses.delete(projectId);
    this.#persist();
    if (this.#bases.delete(baseKey(projectId, id))) this.#persistBases();
    return true;
  }

  /** The house is gone: so are its workflows (its jobs went too). The library keeps what it promoted. */
  removeHouse(projectId: string): number {
    const n = this.#houses.get(projectId)?.size ?? 0;
    if (!this.#houses.delete(projectId)) return 0;
    this.#persist();
    let dropped = false;
    for (const [k, b] of this.#bases) if (b.projectId === projectId) dropped = this.#bases.delete(k) || dropped;
    if (dropped) this.#persistBases();
    return n;
  }

  /** The shared library, oldest first. */
  library(): LibraryEntry[] {
    return [...this.#library.values()].map((e) => structuredClone(e));
  }

  libraryGet(id: string | null | undefined): LibraryEntry | undefined {
    const e = id ? this.#library.get(id) : undefined;
    return e ? structuredClone(e) : undefined;
  }

  /** Put a copy of this house's own workflow in the library under its id (any house can import it from there). The
   *  house keeps its own. replace: over the library's workflow with that id. */
  promote(projectId: string, id: string, o: { house: string; replace?: boolean }): LibraryEntry {
    const w = this.#houses.get(projectId)?.get(id);
    if (!w) throw new WorkflowValidationError(`This house has no workflow with id “${id}”.`);
    const there = this.#library.get(id);
    if (there && !o.replace) throw new WorkflowExistsError(`The library already has a workflow with id “${id}” (“${there.workflow.name}”) — replace it, or save this one as a copy first.`);
    const entry: LibraryEntry = { workflow: structuredClone(w), from: { projectId, house: o.house }, at: Date.now() };
    this.#library.set(id, entry);
    this.#persist();
    return structuredClone(entry);
  }

  /** Copy a library workflow into this house under its id: from now on it is the house's own (changing it changes
   *  only this copy). replace: over the house's own workflow with that id. A name another of the house's workflows
   *  has gets a number ("Pair 2"), as a save does. */
  importFromLibrary(projectId: string, id: string, o: { replace?: boolean } = {}): Workflow {
    const e = this.#library.get(id);
    if (!e) throw new WorkflowValidationError(`The library has no workflow with id “${id}”.`);
    const mine = this.#houses.get(projectId)?.get(id);
    if (mine && !o.replace) throw new WorkflowExistsError(`This house already has a workflow with id “${id}” (“${mine.name}”) — replace it with the library's, or keep it.`);
    const raw = structuredClone(e.workflow);
    const twin = (n: string) => this.list(projectId).some((x) => x.id !== id && x.name.trim().toLowerCase() === n.trim().toLowerCase());
    if (twin(raw.name)) {
      const base = raw.name.trim().slice(0, 76);
      let n = 2;
      while (twin(`${base} ${n}`)) n++;
      raw.name = `${base} ${n}`;
    }
    const w = normalizeWorkflow(raw);
    this.#house(projectId).set(w.id, w);
    this.#persist();
    const key = baseKey(projectId, w.id);
    const old = this.#bases.get(key);
    if (mine && old) {
      // The user replaced the house's copy: like a hand edit (a lead's older copy must not undo it, and a model it
      // brings is newer than a plan card's pick) — the base stays, the models and efforts it changed are noted.
      const at = Date.now();
      for (const s of w.steps) {
        const was = mine.steps.find((x) => x.id === s.id);
        if (!was || was.model !== s.model) this.noteHandSet(projectId, w.id, s.id, 'model', at);
        if (!was || (was.thinking ?? '') !== (s.thinking ?? '')) this.noteHandSet(projectId, w.id, s.id, 'thinking', at);
      }
    } else {
      // a new start: what a lead sends next is merged against what came in, and no hand edit is pending
      this.#bases.set(key, { projectId, workflow: structuredClone(w), at: Date.now() });
      this.#persistBases();
    }
    return w;
  }

  /** Take a workflow out of the library (the houses' copies stay theirs). */
  removeFromLibrary(id: string): boolean {
    if (!this.#library.delete(id)) return false;
    this.#persist();
    return true;
  }

  /** The workflow as chat last saved it (workflow-merge.ts), if CAST has it. */
  chatBase(projectId: string, id: string): Workflow | undefined {
    const b = this.#bases.get(baseKey(projectId, id));
    return b ? structuredClone(b.workflow) : undefined;
  }

  /** The base was seeded (see ChatBase.seeded): no lead saved it since CAST keeps bases. */
  chatBaseSeeded(projectId: string, id: string): boolean {
    return !!this.#bases.get(baseKey(projectId, id))?.seeded;
  }

  /** A lead was shown once what its save would change on a seeded base: from now on it is a base like any other. */
  unseedChatBase(projectId: string, id: string): void {
    const b = this.#bases.get(baseKey(projectId, id));
    if (!b?.seeded) return;
    delete b.seeded;
    this.#persistBases();
  }

  /** A lead saved this house's workflow (what it sent, normalized): the base from now on. carry: its team_edit's
   *  changes were carried into the base (carryOver) — when it became the base and whether it was seeded stay. */
  setChatBase(projectId: string, workflow: Workflow, o: { carry?: boolean } = {}): void {
    const key = baseKey(projectId, workflow.id);
    const old = this.#bases.get(key);
    const keep = o.carry && old ? { at: old.at, ...(old.seeded ? { seeded: true as const } : {}) } : { at: Date.now() };
    this.#bases.set(key, { projectId, workflow: structuredClone(workflow), ...keep, ...(old?.handSet ? { handSet: old.handSet } : {}) });
    this.#persistBases();
  }

  /** "<step id>.model" / ".thinking" was set by hand after the base became the base. */
  handSetSinceBase(projectId: string, workflowId: string, key: string): boolean {
    const b = this.#bases.get(baseKey(projectId, workflowId));
    const m = /^(.+)\.(model|thinking)$/.exec(key);
    if (!b || !m) return false;
    return (b.handSet?.[m[1]!]?.[m[2] as 'model' | 'thinking'] ?? -1) >= b.at;
  }

  /** The user set this person's model or effort by hand (the Workflow tab, a run card's "for next time"). */
  noteHandSet(projectId: string, workflowId: string, stepId: string, field: 'model' | 'thinking', at = Date.now()): void {
    const b = this.#bases.get(baseKey(projectId, workflowId));
    if (!b) return;
    b.handSet = { ...b.handSet, [stepId]: { ...b.handSet?.[stepId], [field]: at } };
    this.#persistBases();
  }

  /** When the user last set this person's model or effort by hand, if they did. */
  handSetAt(projectId: string, workflowId: string, stepId: string, field: 'model' | 'thinking'): number | undefined {
    return this.#bases.get(baseKey(projectId, workflowId))?.handSet?.[stepId]?.[field];
  }

  #house(projectId: string): Map<string, Workflow> {
    let house = this.#houses.get(projectId);
    if (!house) this.#houses.set(projectId, (house = new Map()));
    return house;
  }

  /** Read workflows.json; a file from before houses (v1) is moved to the houses that use each workflow and written
   *  back as v2. */
  #load(migrate: WorkflowMigration | undefined): Loaded {
    if (!existsSync(this.file)) return { moved: null, version: 0, unreadable: false };
    let parsed: { version?: unknown; workflows?: unknown[]; houses?: Record<string, unknown[]>; library?: unknown[] };
    try {
      parsed = JSON.parse(readFileSync(this.file, 'utf8'));
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not a workflows file');
    } catch (err) {
      log('flows', `could not read ${this.file}: ${errorText(err)}`);
      return { moved: null, version: 0, unreadable: true };
    }
    const read = (raw: unknown): Workflow | null => {
      try {
        return normalizeWorkflow(raw);
      } catch (err) {
        log('flows', `skipping invalid saved workflow: ${errorText(err)}`);
        return null;
      }
    };
    if (typeof parsed.version === 'number' && parsed.version >= 2) {
      for (const [projectId, list] of Object.entries(parsed.houses ?? {})) {
        if (!projectId || projectId.length > 200 || !Array.isArray(list)) continue; // a house id as the city makes it
        for (const raw of list) {
          const w = read(raw);
          if (w) this.#house(projectId).set(w.id, w);
        }
      }
      for (const row of Array.isArray(parsed.library) ? parsed.library : []) {
        const r = row as Partial<LibraryEntry> | null;
        const w = read(r?.workflow);
        if (!w) continue;
        const from = r?.from && typeof r.from.projectId === 'string' && typeof r.from.house === 'string' ? { projectId: r.from.projectId, house: r.from.house } : undefined;
        this.#library.set(w.id, { workflow: w, ...(from ? { from } : {}), at: typeof r?.at === 'number' ? r.at : 0 });
      }
      return { moved: null, version: parsed.version, unreadable: false };
    }
    // Before houses: one list every house saw. Each workflow goes to the houses that use it; an edited old example
    // team (legacy-examples.ts) to every house (each saw it); one no house uses to the library (nothing is lost, and
    // no house lists it unasked). An old example stored unchanged (an older CAST writes back the copies the v3 move
    // gave) is left to the v3 move, which runs next and gives it only to the houses that use it.
    const moved = new Map<string, string[]>();
    const houses = migrate?.houses() ?? [];
    for (const raw of Array.isArray(parsed.workflows) ? parsed.workflows : []) {
      const w = read(raw);
      if (!w || (migrate && isUnchangedExample(w))) continue;
      const users = isLegacyExampleId(w.id) ? houses : [...new Set(migrate?.usersOf(w.id) ?? [])].filter((p) => houses.includes(p));
      for (const p of users) this.#house(p).set(w.id, structuredClone(w));
      if (!users.length) this.#library.set(w.id, { workflow: w, at: Date.now() });
      moved.set(w.id, users);
    }
    try {
      // both backups before either file changes: a stop in between leaves the old files to move again
      backup(this.file, 'workflows.v1.json');
      backup(this.basesFile, 'workflow-bases.v1.json');
      this.#persist();
      log('flows', `workflows now belong to houses: ${[...moved].map(([id, to]) => `${id} → ${to.length ? to.join(', ') : 'the library'}`).join('; ') || 'none were saved'} (the old list is in workflows.v1.json)`);
    } catch (err) {
      log('flows', `could not move the saved workflows to their houses: ${errorText(err)}`);
    }
    return { moved, version: 1, unreadable: false };
  }

  /** The v3 move, in memory: each house that uses an old example team (its team, a job's, or a run of it on disk)
   *  and has no workflow with its id gets its own copy, unchanged (same id, name and step ids, so its people, chats
   *  and runs keep matching), first in its list as the examples were. A house's workflow already under an example's
   *  id (an edited one) stays as it is, and so does the library. null: not now (nothing is written, so the next start
   *  tries again). */
  #keepExamplesInUse(migrate: WorkflowMigration): Given[] | null {
    const given: Given[] = [];
    const copies = new Map<string, Workflow[]>(); // house → its copies, in LEGACY_EXAMPLES order
    try {
      const houses = migrate.houses();
      // no house in the city but workflows of houses here: the city wasn't read (a house's workflows go with it)
      if (!houses.length && this.#houses.size) {
        log('flows', 'the town has no houses but workflows.json has workflows of houses — the example teams are moved on a later start');
        return null;
      }
      for (const ex of houses.length ? LEGACY_EXAMPLES : []) {
        const users = new Set(migrate.usersOf(ex.id));
        for (const p of houses) {
          if (!users.has(p) || this.#houses.get(p)?.has(ex.id)) continue;
          const w = normalizeWorkflow(structuredClone(ex));
          copies.set(p, [...(copies.get(p) ?? []), w]);
          given.push({ projectId: p, workflow: w });
        }
      }
    } catch (err) {
      log('flows', `could not see which houses use the example teams (they are moved on a later start): ${errorText(err)}`);
      return null;
    }
    for (const [p, list] of copies) {
      const own = this.#houses.get(p);
      this.#houses.set(p, new Map([...list.map((w) => [w.id, w] as const), ...(own ?? [])]));
    }
    return given;
  }

  /** The v3 move, on disk: the file as it was is kept as workflows.v2.json (once), then workflows.json is written
   *  as v3 — also when nothing was given (the marker; a fresh data folder gets one). */
  #finishExamplesMove(given: Given[], hadFile: boolean): void {
    try {
      backup(this.file, 'workflows.v2.json');
      this.#version = VERSION;
      this.#persist();
    } catch (err) {
      log('flows', `could not keep the example teams in the houses that use them: ${errorText(err)}`);
      return;
    }
    if (!given.length && !hadFile) return; // a fresh data folder: nothing to tell
    const to = LEGACY_EXAMPLES.map((ex) => [ex.id, given.filter((g) => g.workflow.id === ex.id).map((g) => g.projectId)] as const).filter(([, ps]) => ps.length);
    const what = to.length ? to.map(([id, ps]) => `${id} → ${ps.join(', ')}`).join('; ') : 'none in use';
    log('flows', `example teams now belong to the houses that use them: ${what}${hadFile ? ' (the old file is in workflows.v2.json)' : ''}`);
  }

  /** moved: the workflows a file from before houses went to (#load) — their bases go with each copy. A row from
   *  before houses that wasn't moved (the server stopped between the two files) goes to every house that has it. */
  #loadBases(moved: Map<string, string[]> | null) {
    if (!existsSync(this.basesFile)) return;
    try {
      const parsed = JSON.parse(readFileSync(this.basesFile, 'utf8')) as { bases?: { projectId?: unknown; workflow?: unknown; at?: unknown; seeded?: unknown; handSet?: unknown }[] };
      const holders = (id: string) => [...this.#houses].filter(([, h]) => h.has(id)).map(([p]) => p);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) || (parsed.bases !== undefined && !Array.isArray(parsed.bases))) throw new Error('not a bases file');
      for (const row of parsed.bases ?? []) {
        try {
          const w = asBase(row?.workflow);
          if (!w) continue;
          const handSet = row.handSet && typeof row.handSet === 'object' ? (row.handSet as ChatBase['handSet']) : undefined;
          const at = typeof row.at === 'number' ? row.at : 0;
          const houses = typeof row.projectId === 'string' ? [row.projectId] : (moved?.get(w.id) ?? holders(w.id));
          for (const projectId of houses) {
            if (!this.#houses.get(projectId)?.has(w.id)) continue; // deleted while the server was down
            this.#bases.set(baseKey(projectId, w.id), { projectId, workflow: structuredClone(w), at, ...(row.seeded === true ? { seeded: true as const } : {}), ...(handSet ? { handSet: structuredClone(handSet) } : {}) });
          }
        } catch {
          /* not a workflow any more: it starts again from what is stored */
        }
      }
    } catch (err) {
      log('flows', `could not read ${this.basesFile}: ${errorText(err)}`);
      this.#aside = { ...this.#aside, bases: true, at: this.#aside.at || Date.now(), basesWhy: "couldn't be read when CAST started" };
    }
  }

  #persistBases() {
    try {
      if (this.#aside.bases) {
        moveAside(this.basesFile, this.#aside.at, this.#aside.basesWhy);
        this.#aside.bases = false;
      }
      mkdirSync(dirname(this.basesFile), { recursive: true });
      const tmp = `${this.basesFile}.tmp-${process.pid}`;
      writeFileSync(tmp, `${JSON.stringify({ version: 2, bases: [...this.#bases.values()] })}\n`);
      renameSync(tmp, this.basesFile);
    } catch (err) {
      log('flows', `could not keep the workflows' bases: ${errorText(err)}`); // only the merge is lost, not the save
    }
  }

  #persist() {
    if (this.#aside.workflows) {
      moveAside(this.file, this.#aside.at, "couldn't be read when CAST started");
      this.#aside.workflows = false;
    }
    mkdirSync(dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp-${process.pid}`;
    const houses = Object.fromEntries([...this.#houses].filter(([, h]) => h.size).map(([p, h]) => [p, [...h.values()]]));
    // `workflows`: what a CAST from before houses reads (each id once), so going back to one loses nothing — it shows
    // them all in every house again, and the next upgrade moves them to the houses that use them.
    const flat = new Map<string, Workflow>();
    for (const w of [...[...this.#houses.values()].flatMap((h) => [...h.values()]), ...[...this.#library.values()].map((e) => e.workflow)]) if (!flat.has(w.id)) flat.set(w.id, w);
    writeFileSync(tmp, `${JSON.stringify({ version: this.#version, houses, library: [...this.#library.values()], workflows: [...flat.values()] }, null, 2)}\n`);
    renameSync(tmp, this.file);
  }
}
