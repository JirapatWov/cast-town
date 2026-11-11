// Messages on their way to a person, one at a time per person. The composer empties its box the moment Send is
// pressed; the message waits here (shown as a "Sending…" chip) until the server has the one before it. Sending one
// after the other keeps the order the user typed them in (the server starts omp for the first one — up to a minute
// on a cold start — and a second prompt racing that start could overtake it). When one fails, it and every message
// typed after it for that person come back together, oldest first, so nothing is sent out of order or lost.
// Pure (no DOM): tests drive it with plain promises.

export interface Outgoing<M> {
  key: number;
  to: string;
  msg: M;
  /** On the wire (only the oldest of a person's messages is). */
  sending: boolean;
}

export interface SendQueueHooks<M> {
  /** These messages to `to` never got there (the first is the one that failed), oldest first. */
  onFail(to: string, failed: Outgoing<M>[], err: unknown): void;
  /** Something was added, sent or failed (re-render the chips). */
  onChange?(): void;
}

export function createSendQueue<M>(send: (to: string, msg: M) => Promise<void>, hooks: SendQueueHooks<M>) {
  const lines = new Map<string, Outgoing<M>[]>();
  let nextKey = 1;

  function pump(to: string) {
    const line = lines.get(to);
    const head = line?.[0];
    if (!line || !head || head.sending) return;
    head.sending = true;
    hooks.onChange?.();
    let p: Promise<void>;
    try {
      p = Promise.resolve(send(to, head.msg));
    } catch (err) {
      p = Promise.reject(err);
    }
    p.then(
      () => {
        const cur = lines.get(to);
        if (cur?.[0] === head) cur.shift();
        if (cur && !cur.length) lines.delete(to);
        hooks.onChange?.();
        pump(to);
      },
      (err: unknown) => {
        const cur = lines.get(to) ?? [];
        lines.delete(to);
        const failed = cur.includes(head) ? cur : [head, ...cur];
        hooks.onFail(to, failed, err);
        hooks.onChange?.();
      },
    );
  }

  return {
    /** Queue a message for `to`; it goes as soon as the ones before it to the same person have arrived. */
    push(to: string, msg: M): Outgoing<M> {
      const item: Outgoing<M> = { key: nextKey++, to, msg, sending: false };
      const line = lines.get(to) ?? [];
      line.push(item);
      lines.set(to, line);
      hooks.onChange?.();
      pump(to);
      return item;
    },
    /** What is still on its way to `to`, oldest first (the first may be on the wire). */
    pending(to: string): readonly Outgoing<M>[] {
      return lines.get(to) ?? [];
    },
    /** Take back a message that hasn't gone out yet (not the one on the wire). */
    cancel(key: number): Outgoing<M> | undefined {
      for (const [to, line] of lines) {
        const i = line.findIndex((x) => x.key === key && !x.sending);
        if (i < 0) continue;
        const [item] = line.splice(i, 1);
        if (!line.length) lines.delete(to);
        hooks.onChange?.();
        return item;
      }
      return undefined;
    },
  };
}
