// Someone is waiting for the user's OK while they look elsewhere: a system notification (where the browser allows
// it — iOS only for a site added to the Home Screen) and a soft chime. In the page the bell, the title count and the
// approval cards already show it, so nothing fires while the tab is in front.
import type { ApprovalRequest, TeamPlan } from '../../../shared/protocol';
import { approvalNotice } from './approval-text';
import { planSummary } from './plans';

const seen = new Set<string>();
const shown = new Map<string, Notification>();
let audio: AudioContext | null = null;

// Browsers only start sound after a gesture: create the context on the first one, it can play later in the background.
const unlock = () => {
  try {
    audio ??= new AudioContext();
    void audio.resume();
  } catch {
    /* no Web Audio */
  }
};
addEventListener('pointerdown', unlock, { once: true, capture: true });
addEventListener('keydown', unlock, { once: true, capture: true });

export const canAskToNotify = () => 'Notification' in window && Notification.permission === 'default';

export async function askToNotify(): Promise<boolean> {
  if (!('Notification' in window)) return false;
  return (await Notification.requestPermission()) === 'granted';
}

/** Approvals already waiting when the page (re)connects: no alert for those. */
export function approvalsKnown(ids: string[]) {
  for (const id of ids) seen.add(id);
}

export function alertApproval(a: ApprovalRequest, who: string, onOpen: () => void) {
  if (seen.has(a.id)) return;
  seen.add(a.id);
  if (!document.hidden && document.hasFocus()) return;
  chime();
  if (!('Notification' in window) || Notification.permission !== 'granted') return;
  try {
    const { title, body } = approvalNotice(a, who); // an agent's question: what it asks, not only its header
    const n = new Notification(title, { body, tag: a.id });
    n.onclick = () => {
      focus();
      onOpen();
      n.close();
    };
    shown.set(a.id, n);
  } catch {
    /* some browsers only allow notifications from a service worker */
  }
}

export function approvalGone(id: string) {
  shown.get(id)?.close();
  shown.delete(id);
}

const planKey = (id: string) => `plan:${id}`;

/** Plan cards already waiting when the page (re)connects: no alert for those. */
export function plansKnown(ids: string[]) {
  for (const id of ids) seen.add(planKey(id));
}

/** A plan card waits for Run / Cancel. True the first time (the caller shows its in-page toast then); the system
 *  notification and chime only fire while the page is in the background, like approvals. */
export function alertPlan(plan: TeamPlan, who: string, onOpen: () => void): boolean {
  const key = planKey(plan.id);
  if (seen.has(key)) return false;
  seen.add(key);
  if (!document.hidden && document.hasFocus()) return true;
  chime();
  if (!('Notification' in window) || Notification.permission !== 'granted') return true;
  try {
    const n = new Notification(`${who} has a plan for you`, {
      body: planSummary(plan), // continuing a run: 'Continue “X” from Reviewer — Reviewer. Run it or change the models.'
      tag: key,
    });
    n.onclick = () => {
      focus();
      onOpen();
      n.close();
    };
    shown.set(key, n);
  } catch {
    /* some browsers only allow notifications from a service worker */
  }
  return true;
}

/** Seen without an alert (the user is looking at that chat). */
export function planSeen(id: string) {
  seen.add(planKey(id));
}

export function planGone(id: string) {
  approvalGone(planKey(id));
}

function chime() {
  if (!audio || audio.state !== 'running') return;
  const t = audio.currentTime;
  for (const [i, f] of [880, 1318.5].entries()) {
    const o = audio.createOscillator();
    const g = audio.createGain();
    o.type = 'sine';
    o.frequency.value = f;
    g.gain.setValueAtTime(0, t + i * 0.12);
    g.gain.linearRampToValueAtTime(0.08, t + i * 0.12 + 0.02);
    g.gain.exponentialRampToValueAtTime(0.0001, t + i * 0.12 + 0.5);
    o.connect(g).connect(audio.destination);
    o.start(t + i * 0.12);
    o.stop(t + i * 0.12 + 0.55);
  }
}
