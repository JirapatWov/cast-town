// Spend that only ever goes up. AgentInfo.costUsd is a person's running cost, and people come and go: a team run's
// members and the helpers leave the house when they are done, taking their costUsd with them. Summing the people
// who are still here therefore *lowered* "Spend this session" whenever a run ended. The ledger instead adds up how
// much each person's cost grew while it watched, per vendor, and keeps that when they leave.
// Used by the server (the session's ledger, sent with the snapshot and as `spend` messages) and by the client as a
// fallback for servers that don't send one.
import type { Vendor } from './protocol';

export interface SpendTotals {
  /** When the ledger started counting (the server's start). */
  since: number;
  /** Real spend: people on real models. */
  total: number;
  byVendor: Partial<Record<Vendor, number>>;
  /** What people on the scripted test model (CAST_MOCK_LLM) "spent": its simulated numbers, never billed. Present
   *  once there is some; servers from before the split counted it in byVendor. */
  simulated?: { total: number; byVendor: Partial<Record<Vendor, number>> };
}

export function createSpendLedger(now: () => number = Date.now) {
  const seen = new Map<string, number>(); // person → costUsd last seen
  const byVendor = new Map<Vendor, number>();
  const simulated = new Map<Vendor, number>(); // growth on the scripted test model: never money
  const since = now();

  return {
    /** A person's running cost now. Only growth counts; a lower number starts a new count for them (a person who
     *  was set up again from scratch under the same id). demo: they run on the scripted test model, so the growth
     *  is simulated, not spent. True when the totals changed. */
    observe(id: string, vendor: Vendor, costUsd: number | undefined, demo = false): boolean {
      const cost = typeof costUsd === 'number' && Number.isFinite(costUsd) && costUsd > 0 ? costUsd : 0;
      const prev = seen.get(id);
      seen.set(id, cost);
      const grew = cost - (prev ?? 0);
      if (prev !== undefined && cost < prev) return false;
      if (grew <= 1e-12) return false;
      const bucket = demo ? simulated : byVendor;
      bucket.set(vendor, (bucket.get(vendor) ?? 0) + grew);
      return true;
    },
    /** The person left: what they spent stays counted; a newcomer with the same id starts from zero. */
    forget(id: string): void {
      seen.delete(id);
    },
    totals(): SpendTotals {
      const sum = (m: Map<Vendor, number>) => {
        const out: Partial<Record<Vendor, number>> = {};
        let total = 0;
        for (const [v, usd] of m) {
          out[v] = usd;
          total += usd;
        }
        return { total, byVendor: out };
      };
      const real = sum(byVendor);
      return { since, ...real, ...(simulated.size ? { simulated: sum(simulated) } : {}) };
    },
  };
}

export type SpendLedger = ReturnType<typeof createSpendLedger>;
