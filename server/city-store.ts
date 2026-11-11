// CityStore: the town's projects, persisted to <dataDir>/city.json with atomic writes.
// Lots always come from shared/city-layout.ts so layout changes take effect without migrations.
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

interface CityFile {
  version: number;
  projects: Project[];
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

/** Keep only well-formed projects; tolerate older files missing optional fields. */
function sanitize(raw: unknown): Project[] {
  const list = (raw as Partial<CityFile> | null)?.projects;
  if (!Array.isArray(list)) return [];
  const out: Project[] = [];
  for (const p of list as Partial<Project>[]) {
    if (!p || typeof p.id !== 'string' || typeof p.path !== 'string' || typeof p.name !== 'string') continue;
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

export function createCityStore(dataDir: string, workspaceRoot: string): CoreCityStore {
  const file = join(dataDir, 'city.json');
  const existed = existsSync(file);
  const lotIds = new Set(LOTS.map((l) => l.id));
  const listeners = new Set<(city: CityState) => void>();
  let projects: Project[] = [];

  if (existed) {
    try {
      projects = sanitize(JSON.parse(readFileSync(file, 'utf8')));
    } catch (err) {
      const backup = `${file}.corrupt-${Date.now()}`;
      renameSync(file, backup);
      log('city', `city.json was unreadable (${String(err)}); moved it to ${backup} and started an empty town`);
    }
  }

  // Projects on lots that no longer exist (or doubled up) move to the first free lot.
  const used = new Set<string>();
  for (const p of projects) {
    if (lotIds.has(p.lotId) && !used.has(p.lotId)) used.add(p.lotId);
    else p.lotId = '';
  }
  for (const p of projects) {
    if (p.lotId) continue;
    const free = LOTS.find((l) => !used.has(l.id));
    if (!free) continue;
    p.lotId = free.id;
    used.add(free.id);
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
