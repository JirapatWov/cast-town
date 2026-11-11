// A model that keeps answering with nothing (F5). omp classes an empty answer as a passing transport error and sends
// the identical request again — up to 10 times, ~1.5 min each — then gives up with "Retry budget exhausted after 10
// retries: Cloud Code Assist API returned an empty response". The same request gets the same empty answer, so the
// retries can't help: CAST counts consecutive identical empty answers per person and, from the 2nd one, shows a card
// with the way out (another model, or a short message that changes the request). omp itself is not changed.
//
// The texts are omp's (agent/packages/ai/src/providers/google-gemini-cli.ts, google-shared.ts, ollama.ts;
// packages/coding-agent/src/session/turn-recovery.ts).

/** An answer with nothing in it, in any of the ways omp words it. */
const EMPTY =
  /returned an empty response|empty response body|returned a thought-only response without final output|returned no final output|returned (?:an )?empty stop|empty stop after retry cap/i;
/** omp gave up retrying: "Retry budget exhausted after 10 retries: <the last error>". */
const EXHAUSTED = /^Retry budget exhausted after (\d+) (?:retry|retries):\s*/i;

export type StuckKind = 'empty' | 'failing';

/** 'empty': an empty answer (retrying or not); 'failing': omp gave up retrying some other error; null: neither. */
export function stuckKind(message: string): StuckKind | null {
  const text = message.trim();
  const rest = text.replace(EXHAUSTED, '');
  if (EMPTY.test(rest)) return 'empty';
  return EXHAUSTED.test(text) ? 'failing' : null;
}

/** How many retries omp made before giving up (0: it didn't say). */
export function retriesOf(message: string): number {
  return Number(EXHAUSTED.exec(message.trim())?.[1] ?? 0);
}

/** The error without omp's "Retry budget exhausted …:" prefix: what "identical" compares. */
export function errorKey(message: string): string {
  return message.trim().replace(EXHAUSTED, '').replace(/\s+/g, ' ').toLowerCase();
}

/** What the card says. `model`: the model's name as the app shows it. */
export function stuckText(kind: StuckKind, model: string, reason: string): string {
  if (kind === 'empty') {
    return `${model} sent back an empty answer several times in a row. This usually repeats for the same conversation — switch this agent to another model, or send a short message to nudge it.`;
  }
  const why = reason.trim().replace(EXHAUSTED, '').split('\n')[0]!.slice(0, 200);
  return `${model} failed several times in a row${why ? ` (${why})` : ''}. Switch this agent to another model, or send a short message to try again.`;
}

/** Consecutive identical empty answers of one person on one model. Every failed attempt is counted once: omp reports
 *  each with an errored assistant message (note), and its retry notice says how many attempts failed so far (atLeast)
 *  — whichever arrives, the count is right. Real output (text, a tool call) or another model starts over. */
export class EmptyStreak {
  #key = '';
  #model = '';
  #count = 0;
  /** The card of this streak (its transcript item id), once shown. */
  cardId: string | null = null;

  get count(): number {
    return this.#count;
  }

  /** An errored answer: returns the count when it is an empty one (the streak goes on or starts), else null (and the
   *  streak is over). */
  note(message: string, model: string): number | null {
    if (stuckKind(message) !== 'empty') {
      this.reset();
      return null;
    }
    this.#continue(message, model);
    this.#count++;
    return this.#count;
  }

  /** omp's retry notice ("attempt n"): n attempts have failed so far. */
  atLeast(message: string, model: string, attempts: number): number | null {
    if (stuckKind(message) !== 'empty') return null;
    this.#continue(message, model);
    this.#count = Math.max(this.#count, attempts);
    return this.#count;
  }

  reset(): void {
    this.#key = '';
    this.#model = '';
    this.#count = 0;
    this.cardId = null;
  }

  #continue(message: string, model: string) {
    const key = errorKey(message);
    if (key !== this.#key || model !== this.#model) {
      this.reset();
      this.#key = key;
      this.#model = model;
    }
  }
}
