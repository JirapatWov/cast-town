// "Spend this session" for the top bar: the server's ledger (shared/spend.ts) — it never goes down when a team run's
// people or the helpers leave. A server from before the ledger sends none: then the page keeps its own ledger from
// the people it sees, which also never goes down (it only misses what was spent before the page loaded).
// Pure (no DOM).
import type { AgentInfo, SpendTotals, Vendor } from '../../../shared/protocol';
import { createSpendLedger } from '../../../shared/spend';
import { VENDOR_ORDER } from './format';

export interface SpendRow {
  vendor: Vendor;
  usd: number;
}

/** The page's own ledger, for servers without one. */
const local = createSpendLedger();

/** Totals from the server, else from the page's own ledger fed with the people on hand now. */
export function sessionSpend(state: { spend?: SpendTotals; agents: Record<string, AgentInfo> }, ledger = local): SpendTotals {
  if (state.spend) return state.spend;
  for (const a of Object.values(state.agents)) ledger.observe(a.id, a.vendor, a.costUsd, !!a.demo);
  return ledger.totals();
}

/** Real spend per vendor, in the usual vendor order (only those that spent something). */
export function spendRows(totals: SpendTotals): SpendRow[] {
  const by = totals.byVendor;
  return VENDOR_ORDER.filter((v) => (by[v] ?? 0) > 0).map((vendor) => ({ vendor, usd: by[vendor]! }));
}

/** The little bar beside the top bar's total: one coloured part per vendor, sized by its share (a tiny share still
 *  shows). Nothing when the total it stands beside is $0.00, so the bar never looks like money was spent when the
 *  number says none was. */
export function spendBarParts(rows: SpendRow[], shownTotal: number): { vendor: Vendor; flex: number }[] {
  if (!(shownTotal > 0)) return [];
  return rows.filter((r) => r.usd > 0).map((r) => ({ vendor: r.vendor, flex: Math.max(r.usd, shownTotal * 0.04) }));
}
