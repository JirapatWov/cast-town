// The first-chat note's state (first-chat.ts), without a page: which message waits, for which house, and whether an
// answer that comes back late still belongs to it. "Ask me first" awaits the server; meanwhile the chat may show
// another house, whose own Send must never go out on the first house's answer.

export interface ConsentSession {
  readonly projectId: string;
  /** The latest Send pressed for it (the box may have changed since the first one). */
  send: () => void;
}

export interface ConsentGate {
  /** The message waiting, or null. */
  readonly current: ConsentSession | null;
  /** Send pressed in `projectId`: this message waits now (the same house keeps its session, with the newer send). */
  hold(projectId: string, send: () => void): ConsentSession;
  /** The answer for `session` came: its send when it is still the one waiting (then nothing waits), else null. */
  settle(session: ConsentSession): (() => void) | null;
  /** The note went (another chat on show): nothing waits, late answers are ignored. */
  clear(): void;
}

export function createConsentGate(): ConsentGate {
  let current: ConsentSession | null = null;
  return {
    get current() {
      return current;
    },
    hold(projectId, send) {
      if (current?.projectId === projectId) current.send = send;
      else current = { projectId, send };
      return current;
    },
    settle(session) {
      if (session !== current) return null;
      current = null;
      return session.send;
    },
    clear() {
      current = null;
    },
  };
}
