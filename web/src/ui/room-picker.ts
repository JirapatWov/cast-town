// Room picker: one mini floor plan per floor (top floor first), drawn from shared/house-plan.ts. The walls are an
// SVG underlay; rooms are real buttons laid over it so they are focusable, labelled and keyboard-pickable.
import type { Job, RoomRef } from '../../../shared/protocol';
import { CORRIDOR, MAX_FLOORS, STAIRS, roomSlot, roomsOf, slotsOnFloor, type Rect, type RoomSlotDef } from '../../../shared/house-plan';
import { h, setChildren } from './dom';
import { vendorColor, vendorOfModel } from './format';
import { icon } from './icons';
import { floorName, kindInfo, projectFloors } from './jobs';
import type { Shell } from './shell';

// Plan frame (house-local meters): interior x ∈ [-9, 9], z ∈ [-6, 6] plus a margin for the outer walls.
const VB = { x: -9.35, z: -6.35, w: 18.7, h: 12.7 };
const pct = (v: number, from: number, span: number) => `${(((v - from) / span) * 100).toFixed(3)}%`;
const INSET = 0.2; // keep room tiles off the wall lines

export interface RoomPickerOptions {
  projectId: string;
  value: RoomRef | null;
  /** Move mode: this job's current room reads "Here now" instead of being blocked. */
  movingJobId?: string;
  /** Live label for the selected free room (the job name being typed). */
  previewName?: () => string;
  /** What the dialog's button says, for the note on a floor that isn't built yet ("create the job", "move it"). */
  buildVerb?: string;
  onChange(room: RoomRef): void;
}

export interface RoomPicker {
  readonly el: HTMLElement;
  readonly value: RoomRef | null;
  /** The picked room is on a floor that isn't built yet (it is built with the job). */
  readonly onNewFloor: boolean;
  set(room: RoomRef | null): void;
  render(): void;
  refreshPreview(): void;
}

function line(x0: number, z0: number, x1: number, z1: number, cls = 'rp-wall'): string {
  return `<path class="${cls}" d="M${x0} ${z0} L${x1} ${z1}"/>`;
}

/** Wall along z = at from x0 to x1 with door gaps cut out. */
function wallWithGaps(at: number, x0: number, x1: number, gaps: [number, number][]): string {
  const segs: string[] = [];
  let cur = x0;
  for (const [a, b] of [...gaps].sort((p, q) => p[0] - q[0])) {
    if (a > cur) segs.push(line(cur, at, a, at));
    cur = Math.max(cur, b);
  }
  if (cur < x1) segs.push(line(cur, at, x1, at));
  return segs.join('');
}

/** Door leaf + swing arc, opening into the room (classic plan notation). */
function doorSwing(d: NonNullable<RoomSlotDef['door']>, into: 1 | -1): string {
  const w = d.to - d.from;
  const z1 = d.at + into * w;
  const sweep = into > 0 ? 1 : 0;
  return `<path class="rp-door" d="M${d.from} ${d.at} L${d.from} ${z1} A${w} ${w} 0 0 ${sweep} ${d.to} ${d.at}"/>`;
}

function stairs(upper: boolean): string {
  const { x0, x1, z0, z1 } = STAIRS;
  const treads: string[] = [];
  for (let z = z0 + 0.42; z < z1 - 0.1; z += 0.42) treads.push(line(x0 + 0.08, z, x1 - 0.08, z, 'rp-tread'));
  const mid = (x0 + x1) / 2;
  return `<rect class="rp-stairs" x="${x0}" y="${z0}" width="${x1 - x0}" height="${z1 - z0}" rx=".08"/>${treads.join('')}
    <path class="rp-stair-arrow" d="M${mid} ${z1 - 0.5} L${mid} ${z0 + 0.7} M${mid - 0.32} ${z0 + 1.05} L${mid} ${z0 + 0.7} L${mid + 0.32} ${z0 + 1.05}"/>
    ${upper ? `<path class="rp-rail" d="M${x0} ${z0 + 0.6} L${x0} ${z1}"/>` : ''}`;
}

function groundPlan(): string {
  // The shared ground floor: kitchen, dining, living room and the front door, sketched lightly for orientation.
  return `<rect class="rp-floorfill" x="-9" y="-6" width="18" height="12"/>
    <rect class="rp-furn" x="-8.8" y="-5.9" width="5.4" height=".62" rx=".1"/>
    <rect class="rp-furn" x="-6.7" y="-4.3" width="2.3" height=".9" rx=".12"/>
    <rect class="rp-furn" x="-6.2" y="-1.1" width="2.2" height="1.3" rx=".15"/>
    <rect class="rp-furn" x="-1.6" y="-5.88" width="3.2" height=".42" rx=".08"/>
    <rect class="rp-rug" x="-2" y="-3.3" width="4" height="2.9" rx=".12"/>
    <path class="rp-furn" d="M-1.5 -1.05 h3 a.35 .35 0 0 1 .35 .35 v.3 h-3.7 v-.3 a.35 .35 0 0 1 .35 -.35z"/>
    <circle class="rp-rug" cx="0.3" cy="3.3" r="1.35"/>
    <rect class="rp-furn" x="-8.85" y="-2.6" width=".42" height="3.6" rx=".06"/>
    <text class="rp-label" x="-6.1" y="-2.35">Kitchen</text>
    <text class="rp-label" x="0" y="1.15">Living room</text>
    <path class="rp-entry" d="M-10.1 2.85 L-9.05 2.85 M-9.45 2.5 L-9.05 2.85 L-9.45 3.2"/>
    ${stairs(false)}
    <path class="rp-wall rp-outer" d="M-9 -6 H9 V6 H-9 V3.35 M-9 2.35 V-6"/>`;
}

function upperPlan(floor: number, top: boolean): string {
  const rooms = Array.from({ length: slotsOnFloor(floor) }, (_, s) => roomSlot(floor, s)!);
  const gapsBack: [number, number][] = [];
  const gapsFront: [number, number][] = [];
  let swings = '';
  for (const r of rooms) {
    if (!r.door) continue;
    const intoRoom: 1 | -1 = r.rect.z1 <= CORRIDOR.z0 ? -1 : 1;
    (intoRoom < 0 ? gapsBack : gapsFront).push([r.door.from, r.door.to]);
    swings += doorSwing(r.door, intoRoom);
  }
  return `<rect class="rp-floorfill" x="-9" y="-6" width="18" height="12"/>
    <rect class="rp-corridor" x="${CORRIDOR.x0}" y="${CORRIDOR.z0}" width="${CORRIDOR.x1 - CORRIDOR.x0}" height="${CORRIDOR.z1 - CORRIDOR.z0}"/>
    ${stairs(true)}
    ${top ? '' : `<text class="rp-label rp-label-sm" x="${(STAIRS.x0 + STAIRS.x1) / 2}" y="${STAIRS.z1 + 0.05}">up</text>`}
    ${wallWithGaps(CORRIDOR.z0, -9, 9, gapsBack)}
    ${wallWithGaps(CORRIDOR.z1, -9, STAIRS.x0, gapsFront)}
    ${line(0, -6, 0, CORRIDOR.z0)}${line(0, CORRIDOR.z1, 0, 6)}${line(STAIRS.x0, CORRIDOR.z1, STAIRS.x0, 6)}
    ${swings}
    <path class="rp-wall rp-outer" d="M-9 -6 H9 V6 H-9 Z"/>`;
}

function tileStyle(r: Rect): Record<string, string> {
  return {
    left: pct(r.x0 + INSET, VB.x, VB.w),
    top: pct(r.z0 + INSET, VB.z, VB.h),
    width: `${(((r.x1 - r.x0 - INSET * 2) / VB.w) * 100).toFixed(3)}%`,
    height: `${(((r.z1 - r.z0 - INSET * 2) / VB.h) * 100).toFixed(3)}%`,
  };
}

export function firstFreeRoom(floors: number, jobs: Job[], from = 0): RoomRef | null {
  for (const r of roomsOf(floors)) {
    if (r.floor < from) continue;
    if (!jobs.some((j) => j.room.floor === r.floor && j.room.slot === r.slot)) return { floor: r.floor, slot: r.slot };
  }
  return null;
}

/** The room a new job gets without the user picking one: the first free room, else room A of a floor that isn't built
 *  yet (the server builds it when the job is created — nothing is built before Create). null: the house is full. */
export function defaultRoom(floors: number, jobs: Job[]): RoomRef | null {
  return firstFreeRoom(floors, jobs) ?? (floors < MAX_FLOORS ? { floor: floors, slot: 0 } : null);
}

export function createRoomPicker(shell: Shell, opts: RoomPickerOptions): RoomPicker {
  const { store } = shell;
  let value: RoomRef | null = opts.value;
  let busy: 'remove' | null = null;
  const built = () => projectFloors(store.project(opts.projectId));
  // A floor shown but not built yet: "Add Floor N" only plans it (the job's create builds it); a room on it is picked.
  let planned = !!value && value.floor === built();
  const el = h('div', { class: 'room-picker', role: 'radiogroup', 'aria-label': 'Room' });

  const isSel = (f: number, s: number) => !!value && value.floor === f && value.slot === s;

  function pick(room: RoomRef) {
    value = room;
    api.render();
    opts.onChange(room);
    el.querySelector<HTMLElement>(`[data-room="${room.floor}-${room.slot}"]`)?.focus({ preventScroll: true });
  }

  /** Show the next floor (not built yet) and pick its first room. Nothing is built until the dialog's button. */
  function planFloor() {
    if (planned || built() >= MAX_FLOORS) return;
    planned = true;
    pick({ floor: built(), slot: 0 });
    el.querySelector('.rp-floor')?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }

  /** Drop the planned floor again (only offered while another room is free): back to the first free room. */
  function unplanFloor() {
    const free = firstFreeRoom(built(), store.jobsOf(opts.projectId));
    if (!free) return;
    planned = false;
    pick(free);
  }

  async function removeTop(floor: number) {
    if (busy) return;
    busy = 'remove';
    api.render();
    try {
      await store.request({ t: 'remove_floor', reqId: '', projectId: opts.projectId });
      shell.toast('info', `${floorName(floor)} removed`, { projectId: opts.projectId });
      if (value && value.floor >= floor) {
        value = firstFreeRoom(floor, store.jobsOf(opts.projectId));
        if (value) opts.onChange(value);
      }
    } catch (err) {
      shell.toast('error', `Could not remove the floor: ${(err as Error).message}`);
    } finally {
      busy = null;
      api.render();
    }
  }

  function roomTile(def: RoomSlotDef, job: Job | undefined): HTMLElement {
    const sel = isSel(def.floor, def.slot);
    const mine = !!job && job.id === opts.movingJobId;
    const style = tileStyle(def.rect);
    const fresh = def.floor >= built(); // on the planned floor: free, built with the job
    if (job && !mine) {
      const k = kindInfo(job.kind);
      const vendor = vendorOfModel(job.leadModel, store.state.models);
      return h(
        'div',
        { class: 'rp-room is-taken', style: { ...style, '--kc': k.accent }, role: 'img', 'aria-label': `${def.code}: ${job.name} (taken)`, title: `${def.code} · ${job.name}` },
        h('span', { class: 'rp-code' }, def.code, h('span', { class: 'vendor-dot', style: { background: vendorColor(vendor) } })),
        h('span', { class: 'rp-name' }, job.name),
      );
    }
    const preview = (opts.previewName?.() || '').trim();
    const label = sel ? (mine ? 'Here now' : preview || (opts.movingJobId ? 'Moves here' : 'New job')) : mine ? 'Here now' : 'Free';
    return h(
      'button',
      {
        type: 'button',
        role: 'radio',
        'aria-checked': String(sel),
        'aria-label': `${def.code}, ${floorName(def.floor)}: ${mine ? 'current room' : fresh ? 'free, on a new floor' : 'free'}`,
        'data-room': `${def.floor}-${def.slot}`,
        class: ['rp-room', 'is-free', sel && 'is-on', mine && 'is-mine'],
        style,
        tabindex: sel || (!value && def.floor === 0) ? '0' : '-1',
        onclick: () => pick({ floor: def.floor, slot: def.slot }),
      },
      h('span', { class: 'rp-code' }, def.code, sel ? icon('check', 12, 'rp-check') : null),
      h('span', { class: ['rp-name', sel && !mine && 'rp-preview'] }, label),
    );
  }

  // Arrow keys move between free rooms (radio-group convention), top floor first like the layout.
  el.addEventListener('keydown', (ev) => {
    if (!['ArrowDown', 'ArrowUp', 'ArrowLeft', 'ArrowRight'].includes(ev.key)) return;
    const tiles = [...el.querySelectorAll<HTMLButtonElement>('button.rp-room')];
    const i = tiles.indexOf(document.activeElement as HTMLButtonElement);
    if (i < 0 || !tiles.length) return;
    ev.preventDefault();
    const next = tiles[(i + (ev.key === 'ArrowDown' || ev.key === 'ArrowRight' ? 1 : tiles.length - 1)) % tiles.length];
    const [f, s] = (next.dataset.room ?? '0-0').split('-').map(Number);
    pick({ floor: f, slot: s });
  });

  const api: RoomPicker = {
    el,
    get value() {
      return value;
    },
    get onNewFloor() {
      return !!value && value.floor >= built();
    },
    set(room) {
      value = room;
      if (room && room.floor >= built()) planned = true;
      api.render();
    },
    refreshPreview() {
      const name = (opts.previewName?.() || '').trim();
      const target = el.querySelector('.rp-room.is-on:not(.is-mine) .rp-preview');
      if (target) target.textContent = name || (opts.movingJobId ? 'Moves here' : 'New job');
    },
    render() {
      const project = store.project(opts.projectId);
      const floors = projectFloors(project);
      // the planned floor got built meanwhile (another window): it's an ordinary floor now
      if (planned && (floors >= MAX_FLOORS || !value || value.floor < floors)) planned = false;
      const shown = floors + (planned && floors < MAX_FLOORS ? 1 : 0);
      const jobs = store.jobsOf(opts.projectId);
      const sections: HTMLElement[] = [];
      const canAdd = floors < MAX_FLOORS;
      const verb = opts.buildVerb ?? 'create the job';
      const otherFree = !!firstFreeRoom(floors, jobs.filter((j) => j.id !== opts.movingJobId));
      sections.push(
        shown > floors
          ? h(
              'div',
              { class: 'rp-add is-planned', role: 'note' },
              icon('layers', 15),
              h('span', { class: 'rp-add-title' }, `${floorName(floors)} is built when you ${verb}`),
              otherFree
                ? h('button', { type: 'button', class: 'link-btn rp-unplan', onclick: unplanFloor }, 'Use a free room instead')
                : h('span', { class: 'rp-add-sub' }, 'Every room below is taken'),
            )
          : h(
              'button',
              { type: 'button', class: 'rp-add', disabled: !canAdd || !!busy, onclick: planFloor, title: canAdd ? `Show ${floorName(floors)} — it is built only when you ${verb}` : undefined },
              icon('plus', 15),
              h('span', { class: 'rp-add-title' }, canAdd ? `Add ${floorName(floors)}` : `${MAX_FLOORS} floors is the most a house can have`),
              canAdd ? h('span', { class: 'rp-add-sub' }, '4 more rooms') : null,
            ),
      );
      for (let f = shown - 1; f >= 0; f--) {
        const defs = Array.from({ length: slotsOnFloor(f) }, (_, s) => roomSlot(f, s)!);
        const here = jobs.filter((j) => j.room.floor === f);
        const free = defs.length - here.filter((j) => j.id !== opts.movingJobId).length;
        const top = f === shown - 1;
        const fresh = f >= floors;
        const removable = !fresh && f === floors - 1 && f > 0 && here.length === 0;
        const svg = `<svg class="rp-svg" viewBox="${VB.x} ${VB.z} ${VB.w} ${VB.h}" aria-hidden="true" focusable="false">${f === 0 ? groundPlan() : upperPlan(f, top)}</svg>`;
        sections.push(
          h(
            'section',
            { class: ['rp-floor', value?.floor === f && 'has-sel', fresh && 'is-new'], 'aria-label': fresh ? `${floorName(f)} (not built yet)` : floorName(f) },
            h(
              'header',
              { class: 'rp-floor-head' },
              h('span', { class: 'rp-floor-num' }, String(f + 1)),
              h('span', { class: 'rp-floor-name' }, f === 0 ? 'Ground floor' : floorName(f)),
              fresh ? h('span', { class: 'rp-floor-new' }, 'new') : null,
              h('span', { class: 'rp-floor-free' }, free > 0 ? `${free} free` : 'full'),
              removable
                ? h(
                    'button',
                    { type: 'button', class: 'rp-remove', disabled: !!busy, onclick: () => void removeTop(f), title: 'This floor is empty — remove it' },
                    busy === 'remove' ? h('span', { class: 'spinner spinner-sm' }) : icon('minus', 13),
                    'Remove',
                  )
                : null,
            ),
            h('div', { class: 'rp-plan', html: svg }, defs.map((d) => roomTile(d, here.find((j) => j.room.slot === d.slot)))),
          ),
        );
      }
      setChildren(el, ...sections);
      if (!el.querySelector('button.rp-room[tabindex="0"]')) el.querySelector<HTMLElement>('button.rp-room')?.setAttribute('tabindex', '0');
    },
  };
  api.render();
  return api;
}
