// The first-run welcome's three cards and its first fact (onboarding.ts). Pure, so the copy can be checked without a
// page. `point` is "Click" or "Tap" (touch.ts pointWord).
import { APP_NAME } from '../../../shared/brand';
import type { HealthKind } from './model-state';

export interface WelcomeCard {
  title: string;
  body: string;
}

/** `board`: the Board is on show; `phone`: a phone-sized screen, whose top bar has no Board / 3D switch (only the
 *  More menu has it). */
export function welcomeCards(point: string, board = false, phone = false): WelcomeCard[] {
  const where = phone ? 'the More menu (•••)' : 'the top bar';
  return [
    // The Board is a first-class way in (finding #29): say where it is, not just that the town can be flown over.
    {
      title: 'The town is your workspace',
      body: board
        ? `Every project you work on lives here, side by side. This is the Board, a plain list. The 3D town is in ${where}.`
        : `Every project you work on lives here, side by side. Prefer a plain list? Switch to the Board in ${where}.`,
    },
    { title: 'Each house is a project folder', body: 'Place any folder on an empty lot — code, a book, research notes. The TV inside shows exactly what changed.' },
    {
      title: 'Each person is an AI agent',
      body: board ? `${point} someone to give them a task. They answer right here.` : `${point} someone to give them a task. They walk to a station and get to work — for real.`,
    },
  ];
}

/** What a run costs, said before the first one: beside "Connect an AI account" and in the first chat (first-chat.ts). */
export const COST_LINE = `${APP_NAME} is free. Your AI provider charges for what the people use, and a team multiplies it: everyone in it uses your account.`;

/** The welcome's first fact: what the people run on, or why nobody can work yet. */
export interface ModelFact {
  /** 'setup': nobody can work until something is done (amber); 'live': an account works. */
  tone: 'setup' | 'live' | null;
  icon: string;
  strong: string;
  text: string;
  /** A line of its own under the text: what using an account costs. */
  cost?: string;
  /** Its button: Models & providers, or the help on building the agent. */
  button: { label: string; to: 'providers' | 'install'; icon?: string } | null;
}

/** `health`: what the omp / account check says (agents-health.ts); `live`: the providers connected (model-state.ts). */
export function modelFact(health: HealthKind, live: number): ModelFact {
  if (health === 'omp-missing') return { tone: 'setup', icon: 'alert', strong: 'The agent (cast-agent) isn’t built', text: ' — nobody can work until it is.', button: { label: 'How to build it', to: 'install' } };
  if (health === 'checking') return { tone: null, icon: 'clock', strong: 'Checking your AI accounts… ', text: 'The agent can take a minute.', button: null };
  if (health === 'check-failed')
    return { tone: 'setup', icon: 'alert', strong: 'Couldn’t check your AI accounts. ', text: 'Nobody can work until a check works — CAST tries again by itself.', button: { label: 'Models & providers', to: 'providers' } };
  if (live === 0)
    return {
      tone: 'setup',
      icon: 'key',
      strong: 'Connect an AI account first. ',
      text: 'The people here are AI agents: until CAST can reach a model, nobody can read, write or run anything. Sign in with your Claude, ChatGPT or Google account, or use an API key — it stays on this machine.',
      cost: COST_LINE,
      button: { label: 'Connect an AI account', to: 'providers', icon: 'key' },
    };
  return {
    tone: 'live',
    icon: 'checkCircle',
    strong: `${live} provider${live === 1 ? '' : 's'} connected. `,
    text: 'What you type and the files people read are sent to that provider to answer.',
    cost: COST_LINE,
    button: { label: 'Models & providers', to: 'providers' },
  };
}

/** Nothing is connected (and omp is there): the welcome's first button connects an AI account, before placing a
 *  project — a house placed now gets the default lead model, which may not be the account connected later. */
export function connectFirst(health: HealthKind, live: number): boolean {
  return live === 0 && health !== 'omp-missing';
}
