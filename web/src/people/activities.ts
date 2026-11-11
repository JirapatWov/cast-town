// Activity → station / clip table (ARCHITECTURE.md "Activity → station / clip (house view)").
import type { Activity, AgentInfo } from '../../../shared/protocol';
import type { ClipName } from './library';
import { hashString } from './rng';
import type { Slot, StationKind } from './types';

export type PropKind = 'phone' | 'mug' | 'can' | 'vacuum' | 'folder' | null;

/** Busy activities a lead or team member does seated at their own desk, from the first tool call to the end of
 *  the task: between tool calls only the seated clip and the overlays change (nobody stands up). */
export const DESK_WORK = new Set<Activity>(['listening', 'thinking', 'reading', 'writing', 'running', 'searching', 'delegating', 'waiting_approval']);
export const worksAtDesk = (agent: Pick<AgentInfo, 'kind'>, activity: Activity) => agent.kind !== 'subagent' && DESK_WORK.has(activity);
/** Seats for a worker when every desk of their room is in use (room first, then shared spots); they bring a
 *  laptop. ('desk' here only matches desks nobody owns.) */
export const FALLBACK_SEATS: StationKind[] = ['desk', 'sofa', 'armchair', 'dining'];
/** Seconds a worker stays seated after the work ends (counted from leaving work; `done` already lasts ~5 s), so
 *  a short gap between tasks or workflow steps does not make anyone stand up. */
export const DESK_GRACE: [number, number] = [10, 16];

/** How a person behaves once at a slot. */
export interface Behavior {
  clip: ClipName;
  /** Seated clip (requires slot.sit); `clip` is ignored for standing then. */
  sit?: ClipName;
  typing?: boolean;
  /** Raise the right hand above the head (procedural, over the clip). */
  raise?: boolean;
  /** Turn toward the camera instead of the slot's yaw. */
  faceCamera?: boolean;
  /** One-shot played every `every` seconds (reading flips a book, coffee sips). */
  accent?: { clip: ClipName; every: [number, number] };
  /** Played once on arrival before the loop. */
  intro?: ClipName;
  prop?: PropKind;
  /** Moving behaviours walk the slot's route. */
  route?: 'pace' | 'loop';
  /** Seconds before an idle person wanders to another spot. */
  wander?: [number, number];
  // ── seated work (deskBehavior) ──
  /** Right hand on the mouse (the touchpad on a lap). */
  mouse?: boolean;
  /** The desk's monitor shows the agent working. */
  screen?: boolean;
  /** A laptop of their own in front of them (a seat without a monitor). */
  laptop?: boolean;
  /** Head turns toward the screen, over the shoulder at the camera (±75°), or toward the room. */
  look?: 'screen' | 'camera' | 'room';
  /** Head shake (error). */
  shake?: boolean;
  /** The overlay alternates: on for `on` s, off for `off` s (starts on when the overlay's flag is set). */
  bursts?: { overlay: 'typing' | 'mouse'; on: [number, number]; off: [number, number] };
}

/** Station preference per activity (first kind with a free slot wins). */
export function stationKinds(activity: Activity, agent: AgentInfo, wanderIndex: number): StationKind[] {
  const h = hashString(agent.id);
  switch (activity) {
    case 'idle':
    case 'done': {
      if (agent.kind === 'subagent') return ['center', 'window'];
      const cycles: StationKind[][] = [
        ['sofa', 'armchair', 'window'],
        ['window', 'coffee', 'sofa'],
        ['coffee', 'window', 'armchair'],
        ['armchair', 'sofa', 'dining'],
        ['dining', 'sofa', 'window'],
      ];
      return cycles[(h + wanderIndex) % cycles.length];
    }
    case 'listening':
    case 'waiting_approval':
      return ['center'];
    case 'thinking':
      return ['pace', 'corkboard', 'center'];
    case 'reading':
      return ['bookshelf', 'center'];
    case 'writing':
      return ['desk', 'dining'];
    case 'running':
      return h % 3 === 2 ? ['workbench', 'counter'] : ['counter', 'workbench'];
    case 'searching':
      return ['window', 'sofa', 'armchair'];
    case 'delegating':
      return ['corkboard', 'pace', 'center'];
    case 'chore': {
      const list: StationKind[] = ['sink', 'vacuum', 'plants', 'washer', 'workbench'];
      const k = h % list.length;
      return [...list.slice(k), ...list.slice(0, k)];
    }
    case 'error':
    case 'handoff':
      return [];
  }
}

export function behaviorFor(activity: Activity, slot: Slot): Behavior {
  const sits = !!slot.sit;
  switch (activity) {
    case 'idle':
    case 'done':
      if (sits) return { clip: 'Idle_Loop', sit: 'Sitting_Idle_Loop', wander: [24, 44] };
      if (slot.kind === 'coffee') return { clip: 'Idle_Loop', intro: 'Consume', accent: { clip: 'Consume', every: [7, 12] }, prop: 'mug', wander: [16, 26] };
      return { clip: 'Idle_Loop', wander: [14, 26] };
    case 'listening':
      return { clip: 'Idle_Talking_Loop', faceCamera: true };
    case 'waiting_approval':
      return { clip: 'Idle_Loop', raise: true, faceCamera: true };
    case 'thinking':
      return slot.route ? { clip: 'Walk_Formal_Loop', route: 'pace' } : { clip: 'Idle_FoldArms_Loop' };
    case 'reading':
      return { clip: 'Idle_Loop', intro: 'Interact', accent: { clip: 'Interact', every: [4, 7] } };
    case 'writing':
      return { clip: 'Idle_Loop', sit: 'Sitting_Talking_Loop', typing: slot.kind === 'desk' };
    case 'running':
      if (slot.id.includes('floor')) return { clip: 'Fixing_Kneeling' };
      return { clip: 'Idle_Rail_Loop' };
    case 'searching':
      return sits ? { clip: 'Idle_Loop', sit: 'Sitting_Idle_Loop', prop: 'phone' } : { clip: 'Idle_TalkingPhone_Loop', prop: 'phone' };
    case 'delegating':
      return { clip: 'Idle_Talking_Loop' };
    case 'chore':
      switch (slot.kind) {
        case 'sink': return { clip: 'Idle_Rail_Loop' };
        // Push_Loop reads as shoving a crate: walk slowly with the right hand IK'd onto a stick vacuum
        case 'vacuum': return { clip: 'Walk_Loop', route: 'loop', prop: 'vacuum' };
        case 'plants': return { clip: 'Farm_Watering', prop: 'can' };
        case 'washer': return { clip: 'Crouch_Idle_Loop' };
        case 'workbench': return { clip: 'Fixing_Kneeling' };
        default: return { clip: 'Idle_Loop' };
      }
    default:
      return { clip: 'Idle_Loop' };
  }
}

/** Seated work at a desk (or a fallback seat with a laptop): what the hands, head and screen do per activity. */
export function deskBehavior(activity: Activity, slot: Slot): Behavior {
  const base = { clip: 'Idle_Loop' as ClipName, screen: true, laptop: !slot.screen };
  switch (activity) {
    case 'writing':
      return { ...base, sit: 'Sitting_Talking_Loop', typing: true, look: 'screen', bursts: { overlay: 'typing', on: [5, 11], off: [1.2, 2.5] } };
    case 'running': // type a command, watch the output
      return { ...base, sit: 'Sitting_Talking_Loop', typing: true, look: 'screen', bursts: { overlay: 'typing', on: [2, 4], off: [1.5, 3] } };
    case 'thinking':
      return { ...base, sit: 'Sitting_Idle_Loop', look: 'screen', bursts: { overlay: 'typing', on: [1, 2], off: [5, 9] } };
    case 'reading':
      return { ...base, sit: 'Sitting_Idle_Loop', mouse: true, look: 'screen', bursts: { overlay: 'mouse', on: [4, 9], off: [1, 2.5] } };
    case 'searching':
      return { ...base, sit: 'Sitting_Idle_Loop', mouse: true, look: 'screen' };
    case 'delegating':
      return { ...base, sit: 'Sitting_Talking_Loop', look: 'room' };
    case 'listening':
      return { ...base, sit: 'Sitting_Talking_Loop', look: 'camera' };
    case 'waiting_approval':
      return { ...base, sit: 'Sitting_Idle_Loop', raise: true, look: 'camera' };
    case 'error':
      return { ...base, sit: 'Sitting_Idle_Loop', shake: true, screen: false };
    default: // idle / done during the grace period (the screen goes dark after a few seconds)
      return { ...base, sit: 'Sitting_Idle_Loop', screen: false };
  }
}

/** A worker with no seat free anywhere stands at their room spot (no wandering). */
export function standingWork(activity: Activity): Behavior {
  switch (activity) {
    case 'thinking': return { clip: 'Idle_FoldArms_Loop' };
    case 'searching': return { clip: 'Idle_TalkingPhone_Loop', prop: 'phone' };
    case 'listening':
    case 'delegating': return { clip: 'Idle_Talking_Loop', faceCamera: activity === 'listening' };
    case 'waiting_approval': return { clip: 'Idle_Loop', raise: true, faceCamera: true };
    default: return { clip: 'Idle_Loop' };
  }
}
