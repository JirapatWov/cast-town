// CityStore: the town's projects, persisted to <dataDir>/city.json with atomic writes.
// Lots always come from shared/city-layout.ts so layout changes take effect without migrations.
// A project the town has no room for at load (more projects than lots) or that can't be read is never dropped
// silently: it is logged and its record kept in <dataDir>/city-overflow.json, from where it can be put back.
import { existsSync, readFileSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { LOTS } from '../shared/city-layout';
import { MAX_FLOORS } from '../shared/house-plan';
import { RUNS_PER_ASK_CEILING, type BuildingStyle, type CityState, type Project } from '../shared/protocol';
import type { CityStore } from './contracts';
import { projectLeftData } from './data-layout';
import { log, slugify, uniqueName, UserError, writeFileAtomic } from './util';

const FILE_VERSION = 1;
const STYLES: BuildingStyle[] = ['house', 'office', 'cottage', 'studio'];
const APPROVAL_MODES: Project['approvalMode'][] = ['always-ask', 'write', 'auto', 'yolo'];
/** Beside city.json: the projects a load could not place, as they were (README → Troubleshooting). */
export const CITY_OVERFLOW_FILE = 'city-overflow.json';

interface CityFile {
  version: number;
  projects: Project[];
}

/** One record the town could not take, with why and when. `project` is the project with the lot it asked for (an
 *  unreadable entry: as city.json had it), so it can be copied back into city.json's `projects` (with a free `lotId`)
 *  while CAST is stopped. */
export interface OverflowEntry {
  reason: 'no-free-lot' | 'unreadable';
  movedAt: number;
  project: unknown;
}

interface OverflowFile {
  version: number;
  projects: OverflowEntry[];
}

export interface CoreCityStore extends CityStore {
  /** False when city.json did not exist at startup (a first run: the town starts empty). */
  readonly existed: boolean;
  readonly file: string;
  projectByPath(path: string): Project | undefined;
  projectOnLot(lotId: string): Project | undefined;
  freeLots(): string[];
}

/** Storeys: a whole number 1–MAX_FLOORS (files written before floors existed have none → 1). */
function cleanFloors(v: unknown): number {
  return typeof v === 'number' && Number.isInteger(v) ? Math.min(MAX_FLOORS, Math.max(1, v)) : 1;
}

/** The house's own loop guard: a whole number 1–RUNS_PER_ASK_CEILING, else none (the default applies). */
function cleanRunsPerAsk(v: unknown): Pick<Project, 'maxRunsPerAsk'> {
  return typeof v === 'number' && Number.isInteger(v) && v >= 1 && v <= RUNS_PER_ASK_CEILING ? { maxRunsPerAsk: v } : {};
}

/** Keep only well-formed projects; tolerate older files missing optional fields. Entries that aren't projects at all
 *  (no id, path or name) go to `rejected` as they were. */
function sanitize(raw: unknown, rejected: unknown[]): Project[] {
  const list = (raw as Partial<CityFile> | null)?.projects;
  if (!Array.isArray(list)) return [];
  const out: Project[] = [];
  for (const p of list as Partial<Project>[]) {
    if (!p || typeof p.id !== 'string' || typeof p.path !== 'string' || typeof p.name !== 'string') {
      rejected.push(p);
      continue;
    }
    out.push({
      id: p.id,
      name: p.name,
      path: p.path,
      lotId: typeof p.lotId === 'string' ? p.lotId : '',
      style: STYLES.includes(p.style as BuildingStyle) ? (p.style as BuildingStyle) : 'house',
      isGit: p.isGit === true,
      workflowId: typeof p.workflowId === 'string' ? p.workflowId : null,
      approvalMode: APPROVAL_MODES.includes(p.approvalMode as Project['approvalMode']) ? p.approvalMode! : 'write',
      floors: cleanFloors(p.floors),
      ...cleanRunsPerAsk(p.maxRunsPerAsk),
      createdAt: typeof p.createdAt === 'number' ? p.createdAt : Date.now(),
    });
  }
  return out;
}

/** Add `entries` to the overflow file. A project already in it (same id: the same city.json loaded again, as every
 *  start does until the town next changes) is replaced, not doubled. */
function keepOverflow(dataDir: string, entries: OverflowEntry[]): string {
  const path = join(dataDir, CITY_OVERFLOW_FILE);
  let kept: OverflowEntry[] = [];
  try {
    const old = JSON.parse(readFileSync(path, 'utf8')) as Partial<OverflowFile>;
    if (Array.isArray(old.projects)) kept = old.projects;
  } catch {
    // none yet (an unreadable one is set aside, never overwritten)
    if (existsSync(path)) renameSync(path, `${path}.corrupt-${Date.now()}`);
  }
  // the same project (by id) set aside again replaces its old entry
  const idOf = (e: OverflowEntry): unknown => (e && typeof e.project === 'object' && e.project && 'id' in e.project ? e.project.id : undefined);
  for (const e of entries) {
    const id = idOf(e);
    const at = typeof id === 'string' ? kept.findIndex((k) => idOf(k) === id) : -1;
    if (at >= 0) kept[at] = e;
    else kept.push(e);
  }
  const data: OverflowFile = { version: 1, projects: kept };
  writeFileAtomic(path, JSON.stringify(data, null, 2) + '\n');
  return path;
}

export function createCityStore(dataDir: string, workspaceRoot: string): CoreCityStore {
  const file = join(dataDir, 'city.json');
  const existed = existsSync(file);
  const lotIds = new Set(LOTS.map((l) => l.id));
  const listeners = new Set<(city: CityState) => void>();
  let projects: Project[] = [];

  const rejected: unknown[] = [];
  if (existed) {
    try {
      projects = sanitize(JSON.parse(readFileSync(file, 'utf8')), rejected);
    } catch (err) {
      const backup = `${file}.corrupt-${Date.now()}`;
      renameSync(file, backup);
      log('city', `city.json was unreadable (${String(err)}); moved it to ${backup} and started an empty town`);
    }
  }

  // Projects on lots that no longer exist (or doubled up) move to the first free lot.
  const used = new Set<string>();
  const wanted = new Map(projects.map((p) => [p.id, p.lotId]));
  for (const p of projects) {
    if (lotIds.has(p.lotId) && !used.has(p.lotId)) used.add(p.lotId);
    else p.lotId = '';
  }
  for (const p of projects) {
    if (p.lotId) continue;
    const free = LOTS.find((l) => !used.has(l.id));
    if (!free) continue;
    log('city', `${p.name} (${p.id}) stood on lot "${wanted.get(p.id) || 'none'}", which is gone or taken; moved it to ${free.id}`);
    p.lotId = free.id;
    used.add(free.id);
  }
  // No lot left for the rest (more projects than the town has lots): set aside with the lot they asked for, never lost.
  const homeless = projects.filter((p) => !p.lotId);
  if (homeless.length || rejected.length) {
    const movedAt = Date.now();
    const kept = keepOverflow(dataDir, [
      ...homeless.map((p): OverflowEntry => ({ reason: 'no-free-lot', movedAt, project: { ...p, lotId: wanted.get(p.id) ?? '' } })),
      ...rejected.map((r): OverflowEntry => ({ reason: 'unreadable', movedAt, project: r })),
    ]);
    for (const p of homeless) log('city', `No free lot for ${p.name} (${p.id}, folder ${p.path}): all ${LOTS.length} lots are taken. Kept its record in ${kept}`);
    if (rejected.length) log('city', `${rejected.length} entr${rejected.length === 1 ? 'y' : 'ies'} of city.json ${rejected.length === 1 ? 'is' : 'are'} not a project (no id, name or folder); kept in ${kept}`);
  }
  projects = projects.filter((p) => p.lotId);

  const state = (): CityState => ({ lots: LOTS.map((l) => ({ ...l })), projects: projects.map((p) => ({ ...p })) });

  function persist(): void {
    const data: CityFile = { version: FILE_VERSION, projects };
    writeFileAtomic(file, JSON.stringify(data, null, 2) + '\n');
  }

  function changed(): void {
    persist();
    const snapshot = state();
    for (const fn of listeners) {
      try {
        fn(snapshot);
      } catch (err) {
        log('city', 'listener failed', err);
      }
    }
  }

  function requireFreeLot(lotId: string, exceptProjectId?: string): void {
    if (!lotIds.has(lotId)) throw new UserError(`Unknown lot ${lotId}`);
    const holder = projects.find((p) => p.lotId === lotId && p.id !== exceptProjectId);
    if (holder) throw new UserError(`Lot ${lotId} is already home to ${holder.name}`);
  }

  function find(id: string): Project {
    const p = projects.find((x) => x.id === id);
    if (!p) throw new UserError('That project no longer exists');
    return p;
  }

  return {
    file,
    existed,
    workspaceRoot,
    get: state,
    project: (id) => {
      const p = projects.find((x) => x.id === id);
      return p ? { ...p } : undefined;
    },
    projectByPath: (path) => {
      const p = projects.find((x) => x.path === path);
      return p ? { ...p } : undefined;
    },
    projectOnLot: (lotId) => {
      const p = projects.find((x) => x.lotId === lotId);
      return p ? { ...p } : undefined;
    },
    freeLots: () => LOTS.filter((l) => !projects.some((p) => p.lotId === l.id)).map((l) => l.id),

    addProject(input) {
      requireFreeLot(input.lotId);
      const base = slugify(input.name) || slugify(input.path.split('/').pop() ?? '') || 'project';
      const id = uniqueName(base, (c) => projects.some((p) => p.id === c) || projectLeftData(dataDir, c));
      const project: Project = { id, ...input, floors: cleanFloors(input.floors), createdAt: Date.now() };
      projects.push(project);
      changed();
      return { ...project };
    },

    updateProject(id, patch) {
      const p = find(id);
      if (patch.lotId !== undefined && patch.lotId !== p.lotId) requireFreeLot(patch.lotId, id);
      Object.assign(p, patch, { id: p.id });
      p.floors = cleanFloors(p.floors);
      changed();
      return { ...p };
    },

    removeProject(id) {
      const before = projects.length;
      projects = projects.filter((p) => p.id !== id);
      if (projects.length !== before) changed();
    },

    onChange(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
  };
}
