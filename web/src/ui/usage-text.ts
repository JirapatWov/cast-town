// Usage limits in Models & providers, as plain text: "17% used · resets in 3 h 9 min" (or "4.2 of 25 h used" where omp
// gives amounts), the bar's colour level, and which `omp usage` report belongs to which signed-in account. Pure (no
// DOM), so it is unit-tested on its own. Everything says what is USED: the bar fills with it.
import { usageOfAccount, type AccountUsage, type ProviderAccount, type UsageLimit } from '../../../shared/protocol';

export type UsageLevel = 'ok' | 'warn' | 'err';

type LimitAmount = Pick<UsageLimit, 'remainingPct' | 'usedPct' | 'used' | 'limit'>;

const MIN = 60_000;
/** Used from this share on, a limit is drawn in the warning colour (omp itself warns from 80 %). */
export const WARN_USED_PCT = 75;

const clampPct = (n: number) => Math.min(100, Math.max(0, n));
const known = (n: number | null | undefined): n is number => typeof n === 'number' && Number.isFinite(n);

/** Share of the limit used, 0–100, or null when omp doesn't say. */
export function usedPct(l: LimitAmount): number | null {
  if (known(l.usedPct)) return clampPct(l.usedPct);
  if (known(l.remainingPct)) return clampPct(100 - l.remainingPct);
  if (known(l.used) && known(l.limit) && l.limit > 0) return clampPct((l.used / l.limit) * 100);
  return null;
}

/** Warn from 75 % used (or when omp warns), err at 100 % used or when omp says the limit is reached.
 *  omp's statuses are ok | warning | exhausted | unknown; "unknown" goes by the numbers, anything else is an error. */
export function usageLevel(l: LimitAmount & Pick<UsageLimit, 'status'>): UsageLevel {
  const pct = usedPct(l);
  const status = l.status || 'ok';
  if ((pct !== null && pct >= 100) || !['ok', 'warning', 'unknown'].includes(status)) return 'err';
  if ((pct !== null && pct >= WARN_USED_PCT) || status === 'warning') return 'warn';
  return 'ok';
}

/** "17%"; never rounds a sliver up to 100 % or down to 0 %. */
export function fmtPct(pct: number): string {
  if (pct <= 0) return '0%';
  if (pct >= 100) return '100%';
  if (pct < 1) return '<1%';
  return `${Math.min(99, Math.round(pct))}%`;
}

/** 4.2 · 25 · 1.2M — short numbers for amounts. */
function num(n: number): string {
  const a = Math.abs(n);
  if (a >= 1e9) return `${+(n / 1e9).toFixed(1)}B`;
  if (a >= 1e6) return `${+(n / 1e6).toFixed(1)}M`;
  if (a >= 1e4) return `${+(n / 1e3).toFixed(1)}k`;
  if (Number.isInteger(n)) return n.toLocaleString('en-US');
  return `${+n.toFixed(a < 10 ? 1 : 0)}`;
}

/** "4.2 of 25 h used", "1.2M of 5M tokens used", "$4.20 of $25 used"; null when omp gives no amounts worth showing
 *  (a percentage, or no limit to measure against). */
export function amountText(l: Pick<UsageLimit, 'used' | 'limit' | 'unit'>): string | null {
  if (!known(l.used) || !known(l.limit) || l.limit <= 0) return null;
  const unit = l.unit ?? 'unknown';
  if (unit === 'percent') return null;
  if (unit === 'usd') return `$${l.used.toFixed(2).replace(/\.00$/, '')} of $${l.limit.toFixed(2).replace(/\.00$/, '')} used`;
  if (unit === 'minutes') {
    return l.limit >= 120 ? `${num(l.used / 60)} of ${num(l.limit / 60)} h used` : `${num(l.used)} of ${num(l.limit)} min used`;
  }
  if (unit === 'bytes') {
    const gb = (b: number) => `${+(b / 1e9).toFixed(1)} GB`;
    return `${gb(l.used)} of ${gb(l.limit)} used`;
  }
  const word = unit === 'unknown' ? '' : ` ${unit}`;
  return `${num(l.used)} of ${num(l.limit)}${word} used`;
}

/** "17% used", "4.2 of 25 h used" where omp gives amounts, or what is known when it gives neither. */
export function usedText(l: LimitAmount & Pick<UsageLimit, 'unit'>): string {
  const amount = amountText(l);
  if (amount) return amount;
  const pct = usedPct(l);
  if (pct !== null) return `${fmtPct(pct)} used`;
  if (known(l.used)) return `${l.used.toLocaleString('en-US')}${l.unit && l.unit !== 'percent' && l.unit !== 'unknown' ? ` ${l.unit}` : ''} used`;
  return 'Usage unknown';
}

/** Local date and time for a reset more than a day away: "Wed, Nov 4, 02:00 PM" (browser locale by default). */
export function fmtWhen(ts: number, locale?: string, timeZone?: string): string {
  return new Date(ts).toLocaleString(locale ?? [], { weekday: 'short', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', timeZone });
}

/** "resets in 3 h 9 min" within a day, else "resets Wed, Nov 4, 02:00 PM"; '' when omp gives no reset time. */
export function resetText(resetsAt: number | undefined, now: number, locale?: string, timeZone?: string): string {
  if (!known(resetsAt)) return '';
  const ms = resetsAt - now;
  if (ms <= 0) return 'resets now';
  const mins = Math.max(1, Math.round(ms / MIN));
  if (mins < 60) return `resets in ${mins} min`;
  if (mins < 24 * 60) {
    const h = Math.floor(mins / 60);
    const m = mins % 60;
    return m ? `resets in ${h} h ${m} min` : `resets in ${h} h`;
  }
  return `resets ${fmtWhen(resetsAt, locale, timeZone)}`;
}

/** The text after a limit's bar: "17% used · resets in 3 h 9 min"; "0% used · reset just now" when the window reset
 *  after omp's report (the numbers are then the fresh window's, and the report's reset time is gone). */
export function usageLine(l: LimitAmount & Pick<UsageLimit, 'unit' | 'resetsAt' | 'reset'>, now: number, locale?: string, timeZone?: string): string {
  return [usedText(l), l.reset ? 'reset just now' : resetText(l.resetsAt, now, locale, timeZone)].filter(Boolean).join(' · ');
}

/** "updated 4 min ago" for a usage block. */
export function updatedText(fetchedAt: number, now: number): string {
  if (!known(fetchedAt) || fetchedAt <= 0) return 'not checked yet';
  const mins = Math.floor(Math.max(0, now - fetchedAt) / MIN);
  if (mins < 1) return 'updated just now';
  if (mins < 60) return `updated ${mins} min ago`;
  if (mins < 24 * 60) return `updated ${Math.floor(mins / 60)} h ago`;
  return `updated ${new Date(fetchedAt).toLocaleDateString()}`;
}

/** omp labels an account "<email> (<org>)" or "API key #3"; show "<email> · <org>". */
export function accountName(label: string): string {
  const m = /^(.*\S)\s+\(([^()]+)\)$/.exec(label.trim());
  return m ? `${m[1]} · ${m[2]}` : label.trim();
}

export const accountKey = (a: Pick<ProviderAccount, 'provider' | 'credentialId'>) => `${a.provider}#${a.credentialId}`;

/** Each account's usage report (matched like the server does: usageOfAccount), plus the reports no account claimed
 *  (an account the list missed), which the page still shows. */
export function pairUsage(accounts: ProviderAccount[], reports: AccountUsage[]): { byAccount: Map<string, AccountUsage>; orphans: AccountUsage[] } {
  const byAccount = new Map<string, AccountUsage>();
  for (const a of accounts) {
    const u = usageOfAccount(a, accounts, reports);
    if (u) byAccount.set(accountKey(a), u);
  }
  const claimed = new Set(byAccount.values());
  return { byAccount, orphans: reports.filter((r) => !claimed.has(r)) };
}
