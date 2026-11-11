// Run something expensive only once the part of the page that needs it is on screen: Models & providers asks for
// usage limits (`omp usage`, a few hundred MB on the server) only when its usage part scrolls into view.

type ObserverCtor = new (cb: (entries: { isIntersecting: boolean }[]) => void) => { observe(el: Element): void; disconnect(): void };

/** Calls `fn` once, the first time one of `els` is on screen (in the viewport and not scrolled out of a scroll box).
 *  Without IntersectionObserver (old browsers): at once. Returns a stop function (also safe after `fn` ran). */
export function whenSeen(els: readonly Element[], fn: () => void, IO: ObserverCtor | undefined = (globalThis as { IntersectionObserver?: ObserverCtor }).IntersectionObserver): () => void {
  if (!els.length) return () => {};
  let done = false;
  if (!IO) {
    done = true;
    fn();
    return () => {};
  }
  const io = new IO((entries) => {
    if (done || !entries.some((e) => e.isIntersecting)) return;
    done = true;
    io.disconnect();
    fn();
  });
  for (const el of els) io.observe(el);
  return () => {
    done = true;
    io.disconnect();
  };
}
