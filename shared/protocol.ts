// CAST — shared wire protocol between the Bun bridge (server/) and the browser (web/).
// Transport: one WebSocket at /ws, JSON text frames, one message per frame.
// This file is the CONTRACT. Change it only in coordination with every consumer.
import type { SpendTotals } from './spend';
export type { SpendTotals } from './spend';

export type Vendor = 'anthropic' | 'openai' | 'deepseek' | 'google' | 'openrouter' | 'other';

export const VENDOR_COLORS: Record<Vendor, string> = {
  anthropic: '#D97757', // terracotta
  openai: '#10A37F', // mint
  deepseek: '#4D6BFE', // blue
  google: '#8E75F0', // violet
  openrouter: '#6B7280',
  other: '#9CA3AF',
};

export interface ModelInfo {
  id: string; // omp selector, e.g. "anthropic/claude-opus-5-5"
  label: string; // "Claude Opus 5.5"
  vendor: Vendor;
  available: boolean; // true when omp has credentials for it; false → not connected: nobody can work on it
  thinking?: ThinkingLevel[]; // the efforts omp offers for this model, lowest first, without 'off' (absent: unknown)
  images?: boolean; // the model takes image input (omp models: input includes "image"); absent → text only
  /** The sign-in it runs through when that isn't its maker's own API, e.g. 'Antigravity', 'ChatGPT', 'OpenRouter'
   *  (absent: the maker's API, or not connected). Pickers name it when another model has the same name. */
  route?: string;
}

/** How hard a model thinks (omp --thinking). Not every model has every level; omp lowers one a model lacks to its
 *  nearest lower level. */
export type ThinkingLevel = 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';
export const THINKING_LEVELS: readonly ThinkingLevel[] = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];

export interface ProviderStatus {
  vendor: Vendor;
  label: string; // "Anthropic"
  connected: boolean;
  how: string; // one-line hint, e.g. "export ANTHROPIC_API_KEY=… or `omp login anthropic`"
}

/** What CAST knows about omp and the AI accounts it can reach (hello.agents, models.agents): lets the app tell "omp
 *  isn't installed" from "omp is slow" from "the account check failed" from "nobody is signed in". Absent (older
 *  servers, the dev stub): treat as everything 'ok'. */
export interface AgentsHealth {
  /** omp itself: 'checking' (the first look still runs), 'ok', 'missing' (nothing to run at ompPath: nobody can
   *  work), 'failed' (it is there but `omp --version` didn't answer: ompError says why). */
  omp: 'checking' | 'ok' | 'missing' | 'failed';
  ompPath: string; // what CAST runs as omp
  ompError?: string;
  /** The AI-account check (`omp models`): 'checking' (the first one runs, nothing to go by yet), 'ok', 'stale'
   *  (going by an earlier result — the last run's, or one from before a check that failed or still runs), 'failed'
   *  (no check has worked: nothing counts as connected, so nobody can work yet; modelsError says why). */
  models: 'checking' | 'ok' | 'stale' | 'failed';
  modelsError?: string;
  checkedAt?: number; // epoch ms the result in use was read
  checking: boolean; // a check runs right now (the first look, a Refresh, or a retry)
  retryAt?: number; // the next automatic retry after a failed check (epoch ms)
}

/** A provider sign-in run by `omp login <provider>` on the server (Models & providers → Sign in). */
export interface LoginState {
  loginId: string;
  provider: string; // omp login provider id: 'anthropic', 'openai-codex', 'google-gemini-cli', 'openrouter', 'deepseek', …
  phase: 'starting' | 'waiting' | 'verifying' | 'done' | 'failed' | 'cancelled';
  url?: string; // the page to open: the provider's sign-in page, or where to create an API key
  instructions?: string; // omp's one-line hint for that page
  prompt?: string; // set while omp waits for input: the final redirect URL / code, an API key, an account ID, …
  secret?: boolean; // the prompt asks for a key: mask it
  /** The prompt may be left empty (omp's "optional", "blank for github.com", a default choice). */
  allowEmpty?: boolean;
  /** A device sign-in: the code to enter on `url` (omp's "Enter code: …"). */
  userCode?: string;
  /** omp's latest status line while it works ("Waiting for device authorization...", "Validating API key..."). */
  progress?: string;
  message?: string; // done: "Logged in to Anthropic as …"; failed: the reason
  /** failed: what the app can fix in place — 'google-project': this Google account needs a Google Cloud project ID
   *  (omp asks for GOOGLE_CLOUD_PROJECT); the app asks for one, saves it (OmpEnvView) and tries again. */
  fix?: 'google-project';
  /** failed: where the fix is done, e.g. the page that turns an API on in that project. */
  link?: { url: string; label: string };
  /** failed: omp's own words when `message` says them more plainly (tokens and e-mail addresses removed). */
  details?: string;
  /** google-gemini-cli: the Google Cloud project this attempt ran with (absent: none was set). */
  project?: string;
  /** The provider's page shows a code to paste back (Claude's code page), not a localhost address that can't load. */
  pasteCode?: boolean;
  /** Still running: how long until CAST gives up on it, as of this update (relative, so the browser's clock can't skew it). */
  timeLeftMs?: number;
  /** failed: the sign-in ran out of time (the app offers to start again). */
  timedOut?: boolean;
}

/** Extra environment CAST gives every omp it starts (<dataDir>/config.json "ompEnv"). The app edits these keys;
 *  config.json may hold others (set by hand). The CAST server's own environment wins over config.json. */
export const OMP_ENV_KEYS = ['GOOGLE_CLOUD_PROJECT', 'GEMINI_API_KEY', 'ANTHROPIC_API_KEY', 'OPENAI_API_KEY'] as const;
export type OmpEnvKey = (typeof OMP_ENV_KEYS)[number];
/** The API keys among them (omp reads them from the environment; Models & providers has a paste box for each). */
export type ApiKeyName = Exclude<OmpEnvKey, 'GOOGLE_CLOUD_PROJECT'>;

/** How omp finds the models of a model server on another machine (models.yml `discovery.type`). */
export const LOCAL_SERVER_KINDS = ['llama.cpp', 'ollama', 'lm-studio', 'openai-models-list'] as const;
export type LocalServerKind = (typeof LOCAL_SERVER_KINDS)[number];
/** A model server in omp's models.yml with one of those discovery kinds (Models & providers → Local model server).
 *  The key itself never leaves the server. */
export interface LocalServer {
  name: string; // the omp provider id: its models are `<name>/<model>`
  kind: LocalServerKind;
  baseUrl: string;
  hasKey: boolean;
}

/** One of those settings as the browser sees it. A key's value never leaves the server: only whether it is set. */
export interface OmpEnvField {
  /** Where omp's value comes from: the CAST server's environment (wins), config.json (set in the app), or nowhere. */
  source: 'env' | 'config' | null;
  /** The value, for settings that are not secret (the Google Cloud project ID). */
  value?: string;
  /** config.json holds a value too, but the server's environment overrides it. */
  shadowed?: boolean;
}
export type OmpEnvView = Record<OmpEnvKey, OmpEnvField>;

/** One stored credential of a provider omp signs in to (list_accounts). OAuth providers can hold several accounts
 *  (omp gives each chat one and moves to another when a limit is hit); API-key providers hold one key. */
export interface ProviderAccount {
  provider: string; // omp login provider id: 'anthropic', 'openai-codex', 'deepseek', …
  vendor: Vendor;
  credentialId: number; // omp's id for this credential (logout_account)
  label: string; // "<email> (<org>)" or "API key #3"
  detail: string; // omp's longer description, e.g. "<email> · account <id> · oauth #1"
  type: 'oauth' | 'api_key';
  // OAuth only, parsed from omp's label/detail; match AccountUsage (usageOfAccount):
  accountId?: string; // the provider's account id
  email?: string;
  org?: string; // the "(…)" of the label: org name (or id)
  projectId?: string; // Google accounts: their cloud project
}

/** One usage window of an account, e.g. Claude's 5-hour limit. Percentages are 0–100, null when unknown. */
export interface UsageLimit {
  id: string; // "anthropic:5h"
  label: string; // "5 Hour", "7 Day (Fable)"
  window?: string; // "5 Hour"
  remainingPct: number | null;
  usedPct: number | null;
  used?: number;
  limit?: number;
  unit?: string; // "percent", "tokens", …
  resetsAt?: number; // epoch ms
  status: string; // omp's: 'ok' | 'warning' (≥ 80% used) | 'exhausted' | 'unknown'
  /** The window reset after omp's report was fetched: the numbers are the fresh window's (nothing used), not the report's. */
  reset?: true;
}

/** Who an account is, as far as omp tells (any of it may be missing). */
export interface UsageIdentity {
  accountId?: string;
  projectId?: string;
  email?: string;
  org?: string; // org name (ProviderAccount: name or id)
  orgId?: string;
}

/** What `omp usage` reports for one signed-in account. */
export interface AccountUsage {
  provider: string;
  vendor: Vendor;
  accountId?: string;
  projectId?: string;
  email?: string;
  org?: string; // org name
  orgId?: string;
  plan?: string; // e.g. "prolite" (ChatGPT)
  limits: UsageLimit[];
  fetchedAt: number; // epoch ms
  /** omp couldn't check this account just now (it is in UsageSnapshot.unchecked): this is its previous report. */
  stale?: boolean;
}

/** An OAuth account omp holds but couldn't read the usage of just now (e.g. the provider answered 429 right after a
 *  Refresh) — omp's accountsWithoutUsage, identity only. */
export interface UncheckedAccount {
  provider: string;
  vendor: Vendor;
  accountId?: string;
  projectId?: string;
  email?: string;
  org?: string; // org name
  orgId?: string;
}

export interface UsageSnapshot {
  fetchedAt: number; // epoch ms: when the oldest fresh report was fetched (omp caches reports a few minutes)
  accounts: AccountUsage[];
  unchecked?: UncheckedAccount[]; // accounts omp couldn't check just now (their report, if any, is the previous one: stale)
  error?: string; // why usage could not be read (accounts is then empty)
}

const lower = (s?: string) => s?.toLowerCase();
const hasId = (x: UsageIdentity) => !!(x.accountId || x.projectId || x.email);

/** How well two identities of the same provider agree (omp's rules, ids compared case-insensitively): -1 when they
 *  can't be one account — orgs both sides know that share nothing; then, when both carry an email it decides (Codex
 *  Team seats share an account id, Antigravity accounts one Google project); else an account or project id that
 *  differs. Otherwise 8 per same account id + 4 same email + 2 same project id + 1 same org (≥ 2 identifies). */
export function identityScore(a: UsageIdentity, b: UsageIdentity): number {
  const same = (x?: string, y?: string) => x !== undefined && y !== undefined && lower(x) === lower(y);
  const differ = (x?: string, y?: string) => x !== undefined && y !== undefined && lower(x) !== lower(y);
  const orgsA = [a.org, a.orgId].filter((o): o is string => !!o).map((o) => o.toLowerCase());
  const orgsB = [b.org, b.orgId].filter((o): o is string => !!o).map((o) => o.toLowerCase());
  if (orgsA.length && orgsB.length && !orgsA.some((o) => orgsB.includes(o))) return -1;
  if (a.email !== undefined && b.email !== undefined) {
    if (differ(a.email, b.email)) return -1;
  } else if (differ(a.accountId, b.accountId) || differ(a.projectId, b.projectId)) return -1;
  const sameOrg = orgsA.some((o) => orgsB.includes(o));
  return (same(a.accountId, b.accountId) ? 8 : 0) + (same(a.email, b.email) ? 4 : 0) + (same(a.projectId, b.projectId) ? 2 : 0) + (sameOrg ? 1 : 0);
}

/** One provider's two identities are the same account: they agree on an id or email — or neither carries any. */
export function sameUsageAccount(a: UsageIdentity & { provider: string }, b: UsageIdentity & { provider: string }): boolean {
  if (a.provider !== b.provider) return false;
  const score = identityScore(a, b);
  return score >= 2 || (score >= 0 && !hasId(a) && !hasId(b));
}

/** The usage report of one account (API keys have none): the report of the same provider whose identity agrees with
 *  it (identityScore) — preferring the most in common; else the provider's only report when the provider has a single
 *  OAuth account. Undefined when unsure. */
export function usageOfAccount(account: ProviderAccount, accounts: ProviderAccount[], usage: AccountUsage[]): AccountUsage | undefined {
  if (account.type !== 'oauth') return undefined;
  const reports = usage.filter((u) => u.provider === account.provider);
  let best: AccountUsage | undefined;
  let bestScore = 0;
  let tie = false;
  for (const u of reports) {
    const score = identityScore(account, u);
    if (score < 2) continue; // the org alone doesn't identify an account
    if (score > bestScore) [best, bestScore, tie] = [u, score, false];
    else if (score === bestScore) tie = true;
  }
  if (best && !tie) return best;
  const oauth = accounts.filter((a) => a.provider === account.provider && a.type === 'oauth');
  return oauth.length === 1 && reports.length === 1 ? reports[0] : undefined;
}

/** omp holds this account but couldn't check its usage just now ("Couldn’t check this account just now"): its row of
 *  usage.unchecked. Its report, if usageOfAccount finds one, is then the previous one (stale). API keys: undefined. */
export function uncheckedOf(account: ProviderAccount, usage: Pick<UsageSnapshot, 'unchecked'> | null | undefined): UncheckedAccount | undefined {
  if (account.type !== 'oauth') return undefined;
  return usage?.unchecked?.find((u) => sameUsageAccount(account, u));
}

// ───────────────────────── Account order (which signed-in account omp prefers) ─────────────────────────
// Only OAuth accounts have an order (omp's auth.accountPolicies match OAuth identities): Claude, ChatGPT/Codex and
// Google sign-ins. API-key providers (DeepSeek, OpenRouter) hold one key and never appear here.
// The order is a preference, not a rule: omp still skips an account that is out of quota, in its reserve or can't
// report its usage. A chat can pick its own account (set_chat_account) until the next set_account_order of that
// provider, which makes EVERY chat drop its own pick and follow the new order.

/** One signed-in OAuth account in its provider's order. */
export interface OrderedAccount {
  credentialId: number; // ProviderAccount.credentialId: what set_account_order and set_chat_account name
  label: string; // ProviderAccount.label, e.g. "<email> (<org>)"
  /** The user put it in the saved order; false → not placed (no order saved, or signed in after it was): omp tries
   *  it after the placed ones. */
  placed: boolean;
  /** People whose current chat is on this account right now (their AgentInfo.account.credentialId). */
  inUse: number;
  /** Its usage windows (the last `omp usage` report, matched like usageOfAccount); absent → not known. */
  limits?: UsageLimit[];
  stale?: boolean; // limits are an older report: omp couldn't check the account just now
}

/** One provider's accounts in order: the first is the one omp prefers. */
export interface ProviderAccountOrder {
  provider: string; // omp login provider id: 'anthropic' | 'openai-codex' | 'google-gemini-cli' | 'google-antigravity'
  vendor: Vendor;
  /** Placed accounts first (in the saved order), then the others by credentialId (omp's own order: first signed in first). */
  accounts: OrderedAccount[];
  saved: boolean; // an order was saved for this provider (false → omp's own order)
  savedAt?: number; // epoch ms of the last set_account_order for this provider
}

/** get_account_order / the 'account_order' push. */
export interface AccountOrder {
  providers: ProviderAccountOrder[]; // every provider with ≥ 1 signed-in OAuth account
  usageAt?: number; // epoch ms the limits were fetched (absent: no usage report yet)
  error?: string; // why the accounts could not be listed (providers is then empty)
}

/** The account a person's current chat runs on, for the provider of its model (AgentInfo.account). */
export interface ChatAccount {
  provider: string; // omp login provider the chat's model runs on, e.g. 'anthropic', 'openai-codex'
  /** The chat's own pick; else the account omp last used for this chat; null → not known yet (no request yet). */
  credentialId: number | null;
  label: string; // that account's label ('' when credentialId is null)
  /** The chat picked this account itself (set_chat_account): the order doesn't move it until the next
   *  set_account_order of this provider. false → it follows the order. */
  pinned: boolean;
  /** The pick is saved but omp isn't on it yet: the person is busy (after this turn) or its omp isn't running
   *  (before its next message). */
  pending?: boolean;
  choices: number; // signed-in OAuth accounts of this provider (a picker only makes sense with ≥ 2)
}

export type BuildingStyle = 'house' | 'office' | 'cottage' | 'studio';

/** A buildable plot. World units are meters. Building local +Z (front door) faces the road after rotation rotY. */
export interface Lot {
  id: string;
  x: number;
  z: number;
  rotY: number;
  width: number; // along building local X
  depth: number; // along building local Z
  district: string; // label for UI, e.g. "Main Ave"
}

export interface Project {
  id: string;
  name: string;
  path: string; // absolute folder path on the machine running omp
  lotId: string;
  style: BuildingStyle;
  isGit: boolean;
  workflowId: string | null; // default workflow for this house (its roles become residents)
  approvalMode: ApprovalMode; // default 'write' (Accept edits) for git folders, 'always-ask' for others (no undo there)
  /** Storeys of the building, ≥ 1 (1 = ground floor only). Changed only via add_floor / remove_floor.
   *  Rooms per floor: shared/house-plan.ts. City buildings grow taller with it. */
  floors: number;
  /** Team runs a lead may start for one message of the user in this house; absent → MAX_RUNS_PER_ASK. Set from the
   *  house menu (set_project, 1…RUNS_PER_ASK_CEILING). */
  maxRunsPerAsk?: number;
  createdAt: number;
}

/** Team runs a lead may start for one message of the user, unless the house sets its own (Project.maxRunsPerAsk) — a
 *  runaway guard, not a cost cap. A new message of the user starts the count over. */
export const MAX_RUNS_PER_ASK = 5;
/** The most a house may allow. */
export const RUNS_PER_ASK_CEILING = 50;

/** The loop guard's limit in this house: its own, else the default. */
export function runsPerAsk(project: Pick<Project, 'maxRunsPerAsk'> | null | undefined): number {
  return project?.maxRunsPerAsk ?? MAX_RUNS_PER_ASK;
}

// ───────────────────────── Jobs (one job = one room = its own omp sessions) ─────────────────────────

/** A room in a house: floor 0 = ground; slot per shared/house-plan.ts slotsOnFloor(). */
export interface RoomRef {
  floor: number;
  slot: number;
}

/** What kind of work a job is. Picks the room's furniture and the lead's name/persona flavor. */
export type JobKind = 'general' | 'code' | 'write' | 'research';

/** How a job's lead decides how to do an ask (alone, helpers, a team) — Claude Code style, the user states goals.
 *  'ask' (default): the lead decides; the first team it starts after each message of the user shows a plan card
 *  (models editable) and waits for Run — later teams for the same message start without asking.
 *  'auto': the lead decides and never asks. 'solo': helpers and teams only when the user asks for them. */
export type WorkStyle = 'ask' | 'auto' | 'solo';
export const DEFAULT_WORK_STYLE: WorkStyle = 'ask';

/** A model the user picked for a duty on a plan card (newest first, ≤ 12 per job) — the lead follows these when it
 *  picks models for later teams of the job. */
export interface ModelPref {
  stepName: string; // "Reviewer"
  duty: string; // one line, what the person does
  model?: string; // omp selector the user chose (absent: they only changed the effort)
  thinking?: ThinkingLevel; // the effort the user chose (absent: they left it)
  at: number;
  /** When the model / the effort was picked, if not at `at` (a later card changed only the other part). A model or
   *  effort set by hand in the workflow after that wins over it (pickTeam). */
  modelAt?: number;
  thinkingAt?: number;
}

/** A line of work inside a project folder — like a separate Claude Code session with its own people and history.
 *  e.g. in moonlight-novel: "Write the novel" (Writer, Opus) and "Reader website" (Developer, DeepSeek). */
export interface Job {
  id: string; // unique within the project; 'main' for the job every house starts with
  projectId: string;
  name: string; // user-facing, any language, 1–60 chars
  kind: JobKind;
  room: RoomRef; // unique per project
  leadModel: string; // omp selector of the job's lead (the person you talk to in that room)
  /** leadModel was a stand-in: nobody had connected an AI account when the job got it, so it is not the user's choice.
   *  CAST switches it to the preferred connected model once accounts appear, then drops this flag; choosing a model
   *  by hand drops it too. Absent → leadModel was chosen. */
  leadModelDefault?: true;
  leadThinking?: ThinkingLevel; // how hard the lead thinks (omp --thinking); undefined → omp's own default (high)
  /** Optional standing instructions for everyone in this job (goal, scope, "only edit reader-web/", style…). */
  brief: string;
  workflowId: string | null; // the job's team: each step becomes a person in the room
  workStyle?: WorkStyle; // undefined → DEFAULT_WORK_STYLE
  modelPrefs?: ModelPref[];
  /** The job works in its own copy of the house's files (a git worktree), chosen when the job is created and never
   *  changed afterwards; absent → the house folder, shared with the other jobs. */
  worktree?: JobWorktree;
  /** omp selector of a second model that reviews the lead's turns and adds notes (omp's advisor); absent → off. */
  advisorModel?: string;
  createdAt: number;
}

/** A job's own copy of the house's files. */
export interface JobWorktree {
  path: string; // absolute folder the job's people work in (the house's subfolder inside the worktree when the house is a subfolder of its repo)
  root: string; // absolute worktree root (<dataDir>/worktrees/<projectId>/<jobId>)
  branch: string; // "rlt/<projectId>/<jobId>"
  baseRef: string; // "refs/rlt/jobs/<projectId>/<jobId>/base": the house's files the copy was last in step with (Bring into house moves it)
  createdAt: number;
  /** The last Bring into house, so it can be undone (absent: none yet, or undone). */
  lastBring?: { ref: string; files: string[]; at: number };
}

/** update_job's patch. leadThinking / advisorModel: null → back to the default (omp's own / off). */
export type JobPatch = Partial<Pick<Job, 'name' | 'kind' | 'room' | 'leadModel' | 'workflowId' | 'brief' | 'workStyle'>> & {
  leadThinking?: ThinkingLevel | null;
  advisorModel?: string | null;
};

/** One conversation with one person (omp session). A person has one current thread; older ones can be reopened. */
export interface ChatThread {
  id: string;
  agentId: string;
  title: string; // first user message (≤ 60 chars) or "New chat"
  createdAt: number;
  updatedAt: number;
  messages: number; // user + assistant messages
  current: boolean;
}

/** A chat of one person that matches a search (search_threads): how often, and the first match in context. */
export interface ThreadSearchHit {
  threadId: string;
  title: string;
  updatedAt: number;
  messages: number;
  current: boolean;
  hits: number;
  /** The text around the first match (≤ ~160 chars), as written. */
  snippet: string;
  /** Where the match is in `snippet` (character offsets), for highlighting. */
  at?: [number, number];
  /** The transcript item with the first match, so the chat can scroll to it. */
  itemId?: string;
}

/** One line of the house activity log (finished runs, errors, …): the server keeps the latest ones, so the Inbox's
 *  "Recent" is the same on every device and survives a reload. Broadcast as a `toast` that carries the same id. */
export interface ActivityEntry {
  id: string;
  ts: number;
  level: 'info' | 'success' | 'warn' | 'error';
  text: string;
  projectId?: string;
  agentId?: string;
}

export interface CityState {
  lots: Lot[];
  projects: Project[];
}

export type AgentKind = 'resident' | 'role' | 'subagent';
// 'resident' = a job's lead, 'role' = a step of the job's workflow team, 'subagent' = a helper spawned by the task tool.

/** Who sets a person's model and effort (AgentInfo.modelBy):
 *  'job'    → a lead: its job's leadModel / leadThinking (update_job, as the job dialog) — editable from the chat;
 *  'team'   → a standing team member: its workflow step (Workflow tab; a workflow is its house's own);
 *  'run'    → a one-off team's person (x-…): the run's plan; can't be chatted with;
 *  'helper' → a helper: its lead picks the model per task. */
export type ModelOwner = 'job' | 'team' | 'run' | 'helper';

/** What the 3D person is doing. The house view maps each Activity to a station + animation. */
export type Activity =
  | 'idle' // wandering / relaxing at home spot
  | 'listening' // just received a command (faces camera, talking pose)
  | 'thinking' // model reasoning, no tool yet (pacing / whiteboard)
  | 'reading' // read/grep/find/ls/lsp → bookshelf
  | 'writing' // edit/write/notebook → desk typing
  | 'running' // bash/exec/eval → kitchen counter / workshop
  | 'searching' // web_search/fetch/browser → sofa with phone
  | 'delegating' // task tool spawning subagents → corkboard
  | 'waiting_approval' // blocked on user → raises hand, amber ring
  | 'error' // failed → facepalm / shake head
  | 'done' // just finished → coffee / stretch, then idle
  | 'handoff' // carrying a folder to the next workflow role
  | 'chore'; // subagent generic busy work (dishes, vacuum, watering plants)

export interface AgentInfo {
  id: string; // opaque — clients must never parse it (use projectId / jobId / roleId)
  projectId: string;
  jobId: string; // the job (room) this person works in; helpers inherit their parent's job
  kind: AgentKind;
  name: string; // "Assistant", "Decoder", "Explore helper"
  roleId: string; // "assistant" | workflow step id | subagent agent name
  model: string; // requested model selector
  modelLabel: string; // "Claude Opus 5.5"
  vendor: Vendor;
  demo: boolean; // true → runs on the scripted test model (CAST_MOCK_LLM, nothing connected); always false in production
  /** The server won't start them now: their model isn't connected (false while the first account check runs, and
   *  for helpers). Absent (older servers): go by the model list. */
  notConnected?: boolean;
  parentId?: string; // subagents: the agent that spawned it
  status: 'offline' | 'starting' | 'idle' | 'busy' | 'error';
  activity: Activity;
  detail?: string; // short current action, e.g. "Reading src/app.ts"
  tool?: string; // current omp tool name, e.g. "read"
  tokens?: { input: number; output: number };
  costUsd?: number;
  appearance: { seed: number; gender: 'm' | 'f' }; // deterministic look, derived from id hash
  threadId?: string; // current ChatThread (leads and team members; not helpers)
  /** Busy only with helpers working in the background: a new message starts a turn right away (status stays 'busy'). */
  available?: boolean;
  /** How full the model's context is (omp get_session_stats), last known; absent → not known yet (e.g. a new chat). */
  context?: ContextUsage;
  /** Messages sent while the person was busy that it hasn't read yet, oldest first (omp's steering + follow-up queues). */
  queue?: QueuedMessage[];
  /** Leads: the chat's goal (omp goal mode); absent → none. */
  goal?: GoalInfo;
  /** The effort the person is set to (lead: Job.leadThinking; team member: its step's thinking); absent → the
   *  default, which omp runs as 'high'. omp lowers a level the model lacks (ModelInfo.thinking) to the nearest lower. */
  thinking?: ThinkingLevel;
  /** Who sets model and thinking; absent (older servers) → treat as not editable from the chat. */
  modelBy?: ModelOwner;
  /** The account the current chat runs on; absent → none to show (not connected, an API key, a helper, a one-off
   *  team person). */
  account?: ChatAccount;
  /** CAST restarted (epoch ms) while this person was working for the user, or before they read a message: their chat
   *  says what to run again. Cleared by their next message. */
  interrupted?: number;
}

export interface ContextUsage {
  tokens: number;
  window: number; // the model's context window, tokens
  percent: number; // 0–100
  live: boolean; // false: from before the person's omp stopped (shown muted, "last seen")
  at: number; // epoch ms
}

/** A message waiting for a busy person. */
export interface QueuedMessage {
  key: string; // RLT's id for it (queue_action)
  text: string; // as sent (≤ 300 chars here)
  images: number; // how many images it carries
  mode: 'steer' | 'queue'; // 'steer': read at its next step; 'queue': read when it would have finished
  by: 'user' | 'rlt'; // 'rlt': a team update RLT sent to the lead (can't be removed or moved)
}

/** omp goal mode: the lead keeps working on its own toward an objective until it marks it done (or the token budget runs out). */
export interface GoalInfo {
  objective: string;
  status: 'active' | 'paused' | 'budget-limited';
  tokensUsed: number;
  tokenBudget?: number;
  timeUsedSeconds?: number;
  updatedAt: number; // epoch ms
}

/** An image uploaded for a chat message (POST UPLOAD_PATH); shown from GET UPLOAD_PATH/<id>. */
export interface ImageRef {
  id: string; // "<sha256>.<ext>"
  mimeType: string; // image/png | image/jpeg | image/gif | image/webp
}

export const UPLOAD_PATH = '/api/uploads';
export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024; // per image, after the browser shrinks it
export const MAX_PROMPT_IMAGES = 5; // omp sends at most 5 images per model request

// ───────────────────────── Files of a person's folder (the built-in viewer) ─────────────────────────
// A person's folder is the house folder, or its job's own copy (Job.worktree.path) — the same rule as get_git.
// GET|HEAD FILES_PATH/<key>/<path…> serves one file; the key (files_key) is the auth, so the page's relative
// CSS/JS/images load too. Every file response is CSP-sandboxed (opaque origin, no access to CAST's session).
// Paths are '/'-separated and relative to the folder; dot segments (.env, .git, …) are never listed or served.

export const FILES_PATH = '/api/files';
export const FILES_KEY_TTL_MS = 24 * 60 * 60 * 1000;
export const MAX_LIST_FILES = 2000; // entries per list_files answer (then truncated)
export const MAX_FIND_FILES = 10_000; // paths per find_files answer (then truncated)

/** files_key's answer. */
export interface FilesKey {
  key: string; // opaque
  base: string; // `${FILES_PATH}/${key}/`: a file's URL is fileUrl(base, path)
  root: string; // the absolute folder paths are relative to (Job.worktree.path or Project.path)
  expiresAt: number; // epoch ms; ask again before then (a new pairing token also ends every key)
}

/** One entry of list_files (dotfiles never listed; symlinks only when they stay inside the folder). */
export interface FileEntry {
  name: string;
  isDir: boolean;
  size?: number; // bytes, files only
  mtime?: number; // epoch ms
}

/** The URL of a file of the folder a FilesKey is for: its base + each path segment URI-encoded. */
export function fileUrl(base: string, path: string): string {
  return base + path.split('/').filter((s) => s !== '').map(encodeURIComponent).join('/');
}

export type TranscriptItem =
  /** steered: read while it was working. notSent: it never reached the person (their omp didn't start, or CAST
   *  restarted before they read it) — the chat marks it "Not sent" with Retry, and it counts as no message. */
  | { kind: 'user'; id: string; text: string; ts: number; images?: ImageRef[]; steered?: boolean; notSent?: boolean }
  | { kind: 'assistant'; id: string; text: string; thinking?: string; streaming?: boolean; ts: number }
  | {
      kind: 'tool';
      id: string; // toolCallId
      tool: string;
      title: string; // human summary, e.g. "read src/app.ts"
      args?: unknown;
      result?: string; // truncated to ~4 KB
      isError?: boolean;
      status: 'running' | 'done' | 'error';
      ts: number;
      /** Files the tool read or wrote, as omp got them: relative to the person's folder when inside it, absolute
       *  ('/…') when not (e.g. /tmp/omp-image-….png: outside the house, not viewable). */
      paths?: string[];
      /** Images in the tool's result (generate_image, a read of an image), stored like uploads (ids, never base64):
       *  shown from UPLOAD_PATH/<id>. */
      images?: ImageRef[];
      /** Auto mode let this step run without asking (its rules saw nothing risky): labelled in the chat so what Auto
       *  cleared can be looked over afterwards (#61). */
      auto?: boolean;
    }
  /** link: a button that opens another chat of the same person (switch_thread), e.g. where a team's update went.
   *  details: the technical part (omp's own output), folded behind "Details". resend: a "Run again" button that
   *  sends this message to the person again (work CAST's restart interrupted). stuck: the model keeps answering with
   *  nothing (or omp gave up retrying): the card offers "Switch model…" and "Send “continue”" (F5); count = failed
   *  attempts in a row, final = the turn is over. */
  | { kind: 'system'; id: string; text: string; level: 'info' | 'warn' | 'error'; ts: number; link?: { threadId: string; label: string }; details?: string; resend?: { text: string; images?: ImageRef[] }; stuck?: { kind: 'empty' | 'failing'; model: string; count: number; final?: boolean } }
  | { kind: 'plan'; id: string; plan: TeamPlan; ts: number } // id = plan.id; upserted when it is answered
  /** A helper the person sent (omp task tool); upserted as it works. Open its whole chat with get_helper_transcript. */
  | {
      kind: 'helper';
      id: string; // "helper:<omp subagent id>"
      name: string; // "Explore helper"
      model?: string; // selector it ran on
      task: string; // what it was asked (≤ 2 KB)
      status: 'running' | 'done' | 'failed' | 'aborted';
      costUsd?: number;
      agentId?: string; // the helper person while it is in the house
      /** Server's own: the helper's omp session file, relative to the person's session dir (read by
       *  get_helper_transcript — also once that chat's own session file has changed). */
      sessionFile?: string;
      ts: number;
    }
  /** Notes from the lead's advisor (Job.advisorModel). */
  | { kind: 'advisor'; id: string; notes: { note: string; severity?: 'nit' | 'concern' | 'blocker' }[]; ts: number }
  /** The files a chat turn changed (a person working in a git house folder), added when the turn ends: the chat offers
   *  "Undo this turn's changes" (undo_turn). count: how many (files holds the first 200). from / to: the folder before and
   *  after the turn (refs/rlt/turns/…, server's own). shared: someone else worked in the folder during the turn, so its
   *  changes can't be told apart — undo files in the Changes tab instead. undoneAt: when it was undone. */
  | { kind: 'changes'; id: string; files: string[]; count: number; from: string; to: string; ts: number; shared?: boolean; undoneAt?: number };

/** One person on a plan card. */
export interface PlanStep {
  id: string; // step id in the run
  name: string;
  duty: string; // one line: what this person does
  about?: string; // their whole persona (≤ 2000 chars), behind "More" on the card; absent on plans made before 2026-11
  model: string; // omp selector; the user may change it on the card
  thinking?: ThinkingLevel; // effort (omp --thinking); absent: omp's own default (High). The user may change it too
  kind: 'work' | 'review';
  loopBackTo?: string;
  maxLoops?: number;
  parallel?: boolean; // works at the same time as the step before it
}

/** A team the lead wants to start (team_start in work style 'ask'): shown as a card in the lead's chat; the lead's
 *  turn waits until the user presses Run (optionally with other models) or Cancel. */
export interface TeamPlan {
  id: string;
  agentId: string; // the lead
  projectId: string;
  jobId: string;
  title: string; // workflow name, or the one-off team's name
  workflowId?: string; // a saved workflow (absent: a one-off team made for this task)
  why?: string; // the lead's one-line reason
  task: string; // the brief the team gets
  steps: PlanStep[]; // a continuation: only the steps that run again
  /** team_continue: this plan redoes only part of an earlier run (the steps before fromStepId keep their results). */
  continues?: PlanContinuation;
  status: 'pending' | 'approved' | 'cancelled';
  /** Set when answered: what the user changed (step id → model; step id → effort, '' = back to the default) and the
   *  run it started. */
  changed?: Record<string, string>;
  changedThinking?: Record<string, ThinkingLevel | ''>;
  runId?: string;
  ts: number;
  answeredAt?: number;
}

/** How much people may do without asking (Claude Code's permission modes). omp gets --approval-mode:
 *  'always-ask' asks before every edit and command; 'write' edits freely and asks before commands, code and helpers;
 *  'auto' runs omp as always-ask and RLT clears safe steps itself (auto-review.ts), asking only about risky ones;
 *  'yolo' never asks. */
export type ApprovalMode = 'always-ask' | 'write' | 'auto' | 'yolo';

export interface ApprovalRequest {
  id: string; // omp extension_ui_request id
  agentId: string;
  projectId: string;
  tool: string; // the tool asked about, or 'ask' / 'choice' / 'confirm' for an agent's question
  title: string; // e.g. "Allow tool: bash"; an ask's first question; a choice's or confirm's prompt
  detail?: string; // e.g. the command line; an ask's first header; a confirm's message
  options: string[]; // e.g. ["Approve", "Approve bash for this session", "Deny"]; an ask's first question's labels
  /** 'choice' (an extension's select): a short description per option, aligned with `options` ('' = none). */
  optionNotes?: string[];
  /** 'ask': every question of the agent's ask call, as omp sent them. The card shows them all and is answered with
   *  `answers` (one per question). Absent on cards from before CAST showed whole questions. */
  questions?: AskQuestion[];
  ts: number;
  /** Auto mode didn't clear this step on its own — why (shown on the card). */
  autoReason?: string;
  /** A file-changing tool (edit, write, apply_patch): what it would change, worked out by CAST from the call's
   *  arguments and the file on disk — shown on the card before Approve. Absent when CAST couldn't tell. */
  change?: ApprovalChange;
  /** A tool called from inside another running step's code (omp's eval preludes: `browser` used in an eval cell).
   *  omp sends nothing about such a call but its name, so the card shows the step it comes from instead. */
  from?: ApprovalOrigin;
}

/** The running step a tool approval comes from: its tool, what the agent said it is for, and its code. */
export interface ApprovalOrigin {
  tool: string;
  intent?: string;
  code: string;
}

/** One question of an agent's `ask` (omp's AskQuestion, without option previews). */
export interface AskQuestion {
  id: string;
  question: string;
  header?: string; // a short topic shown as a chip, e.g. "Kitchen"
  options: AskOption[];
  multi?: boolean; // any number of options may be picked (none too)
  recommended?: number; // index into options
}

export interface AskOption {
  label: string;
  description?: string;
}

/** The user's answer to one `ask` question, in omp's shape (AskAnswer): exact option labels, plus their own words.
 *  A single-choice question has exactly one of the two. */
export interface AskAnswer {
  id: string;
  selectedOptions: string[];
  customInput?: string;
}

export interface ApprovalChange {
  /** Unified diff (git style: ---/+++ headers, @@ hunks) of what the call would write. */
  diff: string;
  files: string[];
  added: number;
  removed: number;
  /** The diff was cut short (a very large write): only the first part is in `diff`. */
  truncated?: boolean;
  /** Worked out without the exact old lines (a patch op CAST can't place, an unreadable file): the lines shown may
   *  sit elsewhere in the file. */
  approx?: boolean;
}

export interface WorkflowStep {
  id: string; // stable slug, also the roleId of the person, e.g. "decoder"
  name: string; // "Decoder"
  model: string; // omp selector, e.g. "anthropic/claude-opus-5-5"
  thinking?: ThinkingLevel;
  persona: string; // appended to the system prompt of this role's omp process
  instruction: string; // prompt template; placeholders: {{task}} {{prev}} {{prevName}} {{runDir}} {{feedback}}
  kind: 'work' | 'review'; // review → reply must end with ```json {"verdict":"approve"|"revise","notes":"…"} ```
  loopBackTo?: string; // step id to return to on verdict=revise
  maxLoops?: number; // default 2
  /** Works at the same time as the step before it. A parallel group = a step plus the consecutive steps after it
   *  that have parallel:true; the next step starts when the whole group is done and gets all their outputs. */
  parallel?: boolean;
}

/** Steps per workflow (and per one-off team). */
export const MAX_WORKFLOW_STEPS = 12;

export interface Workflow {
  id: string;
  name: string; // "Decode → Implement → Review"
  description: string;
  icon: string; // single emoji
  steps: WorkflowStep[];
  /** Older servers only (their example workflows); never set now, still accepted. */
  builtin?: boolean;
}

/** A workflow in the shared library: any house imports a copy of it (shared/house-workflows.ts). */
export interface LibraryWorkflow {
  workflow: Workflow;
  /** The house it was promoted from (its name then: the house may be gone). Absent: it came from before workflows
   *  belonged to houses and no house used it. */
  from?: { projectId: string; house: string };
  /** When it was promoted (or moved there). */
  at: number;
}

export interface WorkflowRunStep {
  stepId: string;
  status: 'pending' | 'running' | 'done' | 'failed' | 'skipped';
  agentId: string;
  output?: string; // final assistant text (truncated ~8 KB)
  verdict?: 'approve' | 'revise';
  startedAt?: number;
  endedAt?: number;
  /** Time this attempt spent waiting for the user's approval (ms, closed waits), and since when it waits now. The
   *  step's working time is (endedAt ?? now) − startedAt − waits. Absent on older runs: no waits known. */
  waitedMs?: number;
  waitingSince?: number;
  /** Kept from an earlier run (continuation): not run again here. index = that run's steps[] index. */
  reused?: { runId: string; index: number };
}

/** A run that redoes only part of an earlier, ended run: the steps before stepId kept their results and the files
 *  were left as that run left them. */
export interface RunContinuation {
  runId: string; // the earlier run
  stepId: string; // this run's id of the first step that ran again
  note?: string; // what the user wanted different this time
}

/** A plan card for team_continue. */
export interface PlanContinuation {
  runId: string;
  fromStepId: string;
  kept: { id: string; name: string }[]; // the steps that keep their results, in order
  note?: string;
  /** A running team changed in a way that redoes work (team_edit redo): what changes, e.g. "Idea-maker: instruction". */
  changes?: string[];
}

/** One change to a going run's plan (edit_run, the lead's team_edit). Steps are named by id (as written, or the run's
 *  `x-` id) or by name. Only steps that haven't started can change; `note` tells the person working now something. */
export interface RunEditOp {
  op: 'update' | 'add' | 'remove' | 'move' | 'note';
  step?: string; // update / remove / move / note
  after?: string; // add / move: the step it comes after (the step working now = next); add without it: at the end
  person?: Partial<WorkflowStep> & { name: string }; // add
  name?: string;
  model?: string;
  thinking?: ThinkingLevel | ''; // '' = the default effort
  persona?: string;
  instruction?: string; // the whole new prompt
  add_to_instruction?: string; // a paragraph added to the prompt (a review: before its verdict format)
  kind?: 'work' | 'review';
  loopBackTo?: string; // '' = sends nothing back
  maxLoops?: number;
  parallel?: boolean;
  text?: string; // note
}

/** A change made to a run's plan while it ran (run.edits). */
export interface RunEdit {
  at: number;
  by: 'lead' | 'user';
  changes: string[]; // "Editor: instruction", "added Proofreader", "note to Writer"
  saved?: string; // also saved to this workflow (its name)
}

/** A going run's plan (get_run_plan): every step in full, step ids as written. Steps before `done` are behind the
 *  group working now (they keep their results); [done, frozen) is the group working or starting now (only notes);
 *  from `frozen` on nothing has started in this pass — those can change. */
export interface RunPlanView {
  runId: string;
  rev: number; // WorkflowRun.planRev when it was read
  workflowId: string; // '' for a one-off team
  workflowName: string;
  own: boolean; // the job's standing people do it
  steps: WorkflowStep[];
  done: number;
  frozen: number;
  /** Each step: behind (done), in the group now (starting = not asked yet, working, finished = done while the group
   *  still works), or not started in this pass (next). */
  states: Record<string, 'done' | 'starting' | 'working' | 'finished' | 'next'>;
  /** Step ids an added person can't take (this run's attempts, its plan). */
  taken: string[];
}

export interface WorkflowRun {
  id: string;
  workflowId: string;
  workflowName: string;
  projectId: string;
  jobId: string; // runs belong to a job; its room's corkboard shows them (runs saved before jobs existed → 'main')
  task: string;
  status: 'running' | 'waiting_approval' | 'completed' | 'failed' | 'aborted';
  currentStepId: string | null;
  loop: number; // how many review loop-backs happened so far
  steps: WorkflowRunStep[]; // one entry per executed step attempt, in order (loops append new entries)
  checkpoint?: string; // git ref holding the pre-run snapshot, e.g. refs/rlt/checkpoints/<runId>
  startedAt: number;
  endedAt?: number;
  /** Time the whole run waited for the user (status waiting_approval), closed waits in ms + since when it waits now. */
  waitedMs?: number;
  waitingSince?: number;
  costUsd: number;
  /** The people of this run, its plan now (name, model, …) — the source of truth for showing a run, since a one-off team
   *  is in no workflow and its people leave after the run; the steps that haven't started can change while it runs
   *  (edits). Runs saved before 2026-11 lack it. */
  team?: RunTeamMember[];
  adhoc?: boolean; // a one-off team made for this task (workflowId is '' then)
  startedBy?: 'lead' | 'user'; // the job's lead (team_start) or the Workflow tab
  currentStepIds?: string[]; // every step working now (a parallel group has several); currentStepId = the first
  continues?: RunContinuation; // this run continues an earlier one
  revertedAt?: number; // set when revert_run (not preview) restored its files
  interrupted?: boolean; // aborted because CAST stopped (a restart, a crash), not by the user: run it again from its last step
  /** Changes to the plan while it ran (team_edit, Edit on the run card), the latest 30; planRev counts them all. */
  edits?: RunEdit[];
  planRev?: number;
  /** The group working or starting now (indexes into team): steps from `end` on can still change. */
  planAt?: { start: number; end: number };
}

export interface RunTeamMember {
  id: string; // step id in this run
  agentId: string;
  name: string;
  model: string;
  kind: 'work' | 'review';
  loopBackTo?: string;
  parallel?: boolean;
  edited?: true; // added or changed while the run went
}

/** What revert_run does to the files (ack.data.plan): a run is undone on its own, so other jobs' work survives. */
export interface RevertPlan {
  files: string[]; // go back to how they were before the run (files the run created are removed)
  kept: string[]; // the run changed them, but they changed again afterwards or another job also edited them: left as they are
  others: string[]; // people of other jobs who changed files in this folder while the run worked ("Developer (Side)")
  /** Those of `others` who also ran commands or sent helpers: RLT doesn't know which files those changed, so a
   *  revert may put some of their files back too (absent: none). */
  othersUnknown?: string[];
}

export interface GitFileChange {
  path: string;
  status: string; // porcelain code: "M", "A", "D", "??", "R"
  additions: number;
  deletions: number;
}

export interface GitSummary {
  projectId: string;
  /** Set for a job with its own copy (Job.worktree): files/diff are what the job changed since its base, i.e. what
   *  Bring into house would bring; absent → the house folder vs HEAD. */
  jobId?: string;
  isGit: boolean;
  branch?: string;
  files: GitFileChange[];
  diff: string; // unified diff vs HEAD (job copy: vs its base) incl. untracked files (as new-file diffs); truncated ~400 KB
  ts: number;
}

/** What bring_job_changes does (ack.data.plan): each file the job changed since its base is merged into the house's
 *  files (3-way, like git merge-file); the house's HEAD, index and branch are never touched. */
export interface BringPlan {
  files: string[]; // merge cleanly (includes files the job created or deleted)
  conflicts: string[]; // both sides changed the same lines: written with <<<<<<< house / >>>>>>> job markers
  skipped: string[]; // can't be merged (binary changed on both sides): left as the house has them
}

/** A branch a deleted job left in the house's repository (its own copy, committed when the job was deleted): the
 *  house's Changes tab lists it with Bring in / Delete (finding #75). */
export interface LeftoverBranch {
  branch: string; // rlt/<projectId>/<jobId>[-n]
  job: string; // the job's name (from its last commit), else the branch's last part
  at: number; // its last commit (ms)
  files: number; // files it changed since it was last in step with the house: what Bring in looks at
  exact: boolean; // false: an older CAST lost its base — compared with the house as it was when the copy was made
  lastBring?: { at: number; files: string[] }; // its last Bring in, so it can be undone
}

/** What Changes → Undo changes kept before it put files back (refs/rlt/discarded/<id> in the house's repository): the
 *  files as they were, worktree and staged, so Bring back can put them back (3-way, like Bring in). The last 20 stay. */
export interface UndoneChanges {
  id: string; // the ref's last part: "<ms>"
  at: number; // when (ms)
  files: string[]; // relative to the house folder
}

/** What discard_changes did (ack.data), or would do (preview: no `saved`). */
export interface DiscardResult {
  files: string[]; // back as the last commit has them (a new file: deleted)
  skipped: { path: string; why: string }[]; // left alone, and why (no changes now, a submodule, a folder in the way…)
  saved?: UndoneChanges; // what Bring back can put back
}

export interface FsEntry {
  name: string;
  isDir: boolean;
  isGit?: boolean;
}

/** What the people of this town can reach, for the trust copy (welcome, Models & providers). Sent with hello; every
 *  field is absent from older servers, so the UI words things generically then. */
export interface MachineInfo {
  runAs: string; // the OS user the server (and so every omp and shell it starts) runs as
  home: string; // that user's home folder: paths under it are shown as ~/…
  agentDir: string; // omp's own folder (sign-ins and keys): $PI_CODING_AGENT_DIR or ~/.omp/agent
  fsRoots: string[]; // the folders Place project may browse (RLT_FS_ROOTS)
}

// ───────────────────────── Server → client ─────────────────────────
export type ServerMsg =
  /** ompVersion: what `omp --version` said (null: omp not found); ompTested: the release CAST is tested with
   *  (shared/omp-version.ts) — another one gets a warning banner. */
  /** demoMode: true only with CAST_MOCK_LLM while nothing is connected (people run on the scripted test model). */
  | ({ t: 'hello'; serverVersion: string; ompVersion: string | null; ompTested: string; user: string | null; demoMode: boolean; workspaceRoot: string; agents?: AgentsHealth } & Partial<MachineInfo>)
  | {
      t: 'snapshot';
      city: CityState;
      agents: AgentInfo[];
      /** Always [] (older servers: the built-ins every house had, or every workflow, which every house saw). */
      workflows: Workflow[];
      /** Each house's own workflows (house id → them). Absent from older servers. */
      houseWorkflows?: Record<string, Workflow[]>;
      /** The shared library (absent from older servers). */
      library?: LibraryWorkflow[];
      runs: WorkflowRun[];
      approvals: ApprovalRequest[];
      models: ModelInfo[];
      providers: ProviderStatus[];
      jobs: Job[]; // every job of every project
      plans: TeamPlan[]; // pending plan cards
      /** What this server session spent, never going down when people leave (absent from older servers). */
      spend?: SpendTotals;
      /** The latest house activity, newest first (absent from older servers). */
      activity?: ActivityEntry[];
    }
  | { t: 'city'; city: CityState }
  | { t: 'jobs'; projectId: string; jobs: Job[] } // replaces that project's job list
  | { t: 'threads'; agentId: string; threads: ChatThread[] } // newest first; sent on list_threads and whenever they change
  | { t: 'agent'; agent: AgentInfo } // upsert
  | { t: 'agent_removed'; agentId: string }
  | { t: 'transcript_reset'; agentId: string; items: TranscriptItem[] }
  | { t: 'transcript_upsert'; agentId: string; item: TranscriptItem } // upsert by item.id; streaming text is sent as full-text-so-far, throttled ≤10/s
  | { t: 'approval'; approval: ApprovalRequest }
  | { t: 'approval_resolved'; id: string }
  | { t: 'run'; run: WorkflowRun } // upsert
  | { t: 'plan'; plan: TeamPlan } // upsert; also upserted into the lead's transcript as a 'plan' item
  | { t: 'workflows'; workflows: Workflow[]; houseWorkflows?: Record<string, Workflow[]>; library?: LibraryWorkflow[] } // as in the snapshot
  | { t: 'handoff'; projectId: string; fromAgentId: string; toAgentId: string; label: string } // visual: carry a folder
  | { t: 'git'; summary: GitSummary }
  /** demoMode: as hello.demoMode (true only with CAST_MOCK_LLM while nothing is connected) — set whenever the models
   *  were checked again (absent from older servers and the dev stub). */
  | { t: 'models'; models: ModelInfo[]; providers: ProviderStatus[]; demoMode?: boolean; agents?: AgentsHealth; ompVersion?: string | null }
  | { t: 'login'; login: LoginState } // every step of the running sign-in (sent to all clients)
  | { t: 'omp_env'; ompEnv: OmpEnvView } // the extra omp environment changed (set_omp_env; sent to all clients)
  | { t: 'local_servers'; servers: LocalServer[] } // models.yml's model servers changed (save/remove_local_server; sent to all clients)
  /** The account order changed (set_account_order, a sign-in or sign-out), or fresh limits arrived after
   *  get_account_order: replaces the client's copy. Sent to all clients. */
  | { t: 'account_order'; order: AccountOrder }
  /** id/ts: it is also in the activity log (ActivityEntry) — the Inbox's "Recent" keeps it. */
  | { t: 'toast'; level: 'info' | 'success' | 'warn' | 'error'; text: string; projectId?: string; agentId?: string; id?: string; ts?: number }
  | { t: 'spend'; spend: SpendTotals } // the session's spend ledger changed
  /** isGit: the listed folder itself is inside a git repository (absent from older servers). */
  | { t: 'fs_list'; reqId: string; path: string; parent: string | null; entries: FsEntry[]; error?: string; isGit?: boolean }
  | { t: 'ack'; reqId: string; ok: boolean; error?: string; data?: unknown }
  | { t: 'error'; reqId?: string; message: string };

// ───────────────────────── Client → server ─────────────────────────
export type ClientMsg =
  /** initGit: the folder is not a git repo — make it one first (init + a first commit) so changes can be seen and undone. */
  | { t: 'place_project'; reqId: string; path: string; name: string; lotId: string; style: BuildingStyle; initGit?: boolean }
  /** Make a house that is not a git repo one (init + a first commit of what is there); ack.data = { project }. */
  | { t: 'init_git'; reqId: string; projectId: string }
  | { t: 'create_project'; reqId: string; name: string; lotId: string; style: BuildingStyle; template: 'empty' | 'node-api' | 'novel' } // new folder under workspaceRoot
  | { t: 'move_project'; reqId: string; projectId: string; lotId: string }
  /** Removes the building; NEVER deletes the folder. deleteHistory: also delete its chats and omp sessions (every job's)
   *  and CAST's run notes in the folder (.rlt/, run checkpoints) — the project's own files stay. */
  | { t: 'remove_project'; reqId: string; projectId: string; deleteHistory?: boolean }
  // path: point the house at another folder (refused while anyone works there or a job has its own copy; the old folder
  // is not touched). maxRunsPerAsk: the house's own loop guard (1…RUNS_PER_ASK_CEILING); null → back to the default.
  | { t: 'set_project'; reqId: string; projectId: string; patch: Partial<Pick<Project, 'name' | 'style' | 'approvalMode' | 'workflowId' | 'path'>> & { maxRunsPerAsk?: number | null } }
  | { t: 'enter_project'; projectId: string } // server upserts the house's residents (does not spawn omp until first prompt)
  // Jobs & floors (handled by the agent system). A new job's room must exist and be free; a house keeps ≥ 1 job.
  | { t: 'create_job'; reqId: string; projectId: string; name: string; kind: JobKind; room: RoomRef; leadModel?: string; leadThinking?: ThinkingLevel; workflowId?: string | null; brief?: string; workStyle?: WorkStyle; worktree?: boolean; advisorModel?: string } // ack.data = { job }; worktree: give it its own copy (git houses only)
  | { t: 'update_job'; reqId: string; projectId: string; jobId: string; patch: JobPatch }
  | { t: 'delete_job'; reqId: string; projectId: string; jobId: string } // stops its people; files and chat history stay on disk
  | { t: 'add_floor'; reqId: string; projectId: string } // floors + 1 (≤ MAX_FLOORS)
  | { t: 'remove_floor'; reqId: string; projectId: string } // top floor only, and only when no job is on it
  // Chat threads (per person; not helpers)
  | { t: 'list_threads'; agentId: string } // → { t: 'threads' }
  | { t: 'new_thread'; reqId: string; agentId: string } // fresh omp session; the old one stays reopenable
  | { t: 'search_threads'; reqId: string; agentId: string; query: string } // ack.data = { results: ThreadSearchHit[] }, best first
  | { t: 'switch_thread'; reqId: string; agentId: string; threadId: string } // reopen an older conversation (the model remembers it)
  /** Delete one chat for good: its transcript and its omp session (with its helpers' sessions). Deleting the current
   *  chat starts a fresh one first. Not while the person works. ack.data = { thread: ChatThread } (the current one). */
  | { t: 'delete_thread'; reqId: string; agentId: string; threadId: string }
  /** text may be empty when images are given. mode (only matters while the person is busy): 'queue' (default) → read
   *  when it would have finished; 'steer' → read at its next step. With reqId: ack once omp has it (or the error). */
  | { t: 'prompt'; agentId: string; text: string; reqId?: string; images?: string[]; mode?: 'queue' | 'steer' } // images: ImageRef ids, ≤ MAX_PROMPT_IMAGES
  /** Stop. With reqId: ack.data = { restored: { text: string; images: ImageRef[] }[] } — the user's queued messages it
   *  hadn't read, oldest first, for the composer. */
  | { t: 'abort'; agentId: string; reqId?: string }
  /** A queued message (AgentInfo.queue key): 'remove' → ack.data = { text, images: ImageRef[] } (back to the composer);
   *  'steer' → read it at the next step instead of at the end. */
  | { t: 'queue_action'; reqId: string; agentId: string; key: string; action: 'remove' | 'steer' }
  /** Shrink the chat's context now (omp compact); only while the person is idle. ack.data = { tokensBefore?: number; nothing?: true } */
  | { t: 'compact'; reqId: string; agentId: string }
  /** Leads: goal mode for the current chat. 'create' needs objective (tokenBudget optional, > 0). */
  | { t: 'goal'; reqId: string; agentId: string; op: 'create' | 'pause' | 'resume' | 'drop'; objective?: string; tokenBudget?: number }
  /** The whole chat of a helper (a 'helper' item of agentId's transcript), read from its omp session file — also after
   *  it left. ack.data = { items: TranscriptItem[]; running: boolean } */
  | { t: 'get_helper_transcript'; reqId: string; agentId: string; itemId: string }
  /** "Undo this turn's changes" on a 'changes' item of the person's current chat: its files go back to how they were
   *  before the turn — only when none of them changed again since (else nothing changes and ack.data.kept names them).
   *  What is replaced is kept like Undo changes (ack.data.saved → bring_back_undone). Refused while anyone works in the
   *  house folder. ack.data = { files: string[]; kept: string[]; saved?: UndoneChanges } (preview: only say what). */
  | { t: 'undo_turn'; reqId: string; agentId: string; itemId: string; preview?: boolean }
  | { t: 'get_transcript'; agentId: string }
  /** value ∈ approval.options. An ask (approval.questions) is answered with `answers`, one per question; with reqId
   *  the server acks (ok, or why the answers don't fit — the card then stays). */
  | { t: 'approve'; approvalId: string; value: string; answers?: AskAnswer[]; reqId?: string }
  | { t: 'run_workflow'; reqId: string; projectId: string; jobId?: string; workflowId: string; task: string } // jobId default 'main'
  | { t: 'abort_run'; runId: string }
  | { t: 'continue_run'; reqId: string; runId: string; fromStepId: string; note?: string; models?: Record<string, string> } // redo an ended run from a step: earlier steps keep their results, files stay (ack.data = { runId })
  | { t: 'get_run_plan'; reqId: string; runId: string } // a going run's plan in full (ack.data = RunPlanView)
  /** Change a going run's later steps (it keeps going) or send a note to the person working now; save: also change the
   *  saved workflow for next time; seen: the view's `frozen` (a step that started meanwhile gets its own message). */
  | { t: 'edit_run'; reqId: string; runId: string; ops: RunEditOp[]; save?: boolean; seen?: { rev: number; frozen: number } } // ack.data = { run, changes, warnings, delivered, saved?, notSaved? }
  | { t: 'revert_run'; reqId: string; runId: string; preview?: boolean } // undo the run's file changes; preview: only report (ack.data = { plan: RevertPlan })
  /** Save in this house (only it sees the workflow). projectId is absent only from a page older than houses' own
   *  workflows (refused: reload). */
  | { t: 'save_workflow'; reqId: string; projectId?: string; workflow: Workflow }
  /** This house's workflow. Never while it runs. A job's team only with clearTeams (the user said
   *  so): those jobs get no fixed team first. No job or house keeps pointing at it. ack.data = { workflow, cleared: "Job"[] }. */
  | { t: 'delete_workflow'; reqId: string; projectId?: string; workflowId: string; clearTeams?: boolean }
  /** Put a copy of this house's workflow in the shared library (the house keeps its own); replace: over the library's
   *  workflow with that id. ack.data = { entry: LibraryWorkflow } */
  | { t: 'promote_workflow'; reqId: string; projectId: string; workflowId: string; replace?: boolean }
  /** Copy a library workflow into this house (from then on the house's own); replace: over the house's workflow with
   *  that id. ack.data = { workflow } */
  | { t: 'import_workflow'; reqId: string; projectId: string; workflowId: string; replace?: boolean }
  /** Take a workflow out of the library (the houses' copies stay). ack.data = { workflowId } */
  | { t: 'delete_library_workflow'; reqId: string; workflowId: string }
  | { t: 'save_run_team'; reqId: string; runId: string; name: string } // keep a one-off team as a workflow; ack.data = { workflow }
  | { t: 'answer_plan'; reqId: string; planId: string; run: boolean; models?: Record<string, string>; thinking?: Record<string, ThinkingLevel | ''> } // models: step id → selector; thinking: step id → effort ('' = omp's default)
  | { t: 'get_git'; projectId: string; jobId?: string } // jobId of a job with its own copy → that copy's changes since its base
  /** A job with its own copy: merge what it changed into the house's files. preview → only ack.data = { plan: BringPlan };
   *  undo → put the files of the last bring back as they were (files changed again since are kept), ack.data = { files: string[]; kept: string[] }. */
  | { t: 'bring_job_changes'; reqId: string; projectId: string; jobId: string; preview?: boolean; undo?: boolean }
  /** Branches deleted jobs left in the house's repository: ack.data = { branches: LeftoverBranch[] }. */
  | { t: 'list_leftovers'; reqId: string; projectId: string }
  /** One of them: bring it into the house's files (preview → ack.data = { plan }; else { plan, files }), undo its last
   *  bring (ack.data = { files, kept }; preview → only say which), or delete the branch. */
  | { t: 'leftover_branch'; reqId: string; projectId: string; branch: string; action: 'bring' | 'undo' | 'delete'; preview?: boolean }
  /** Changes → Undo changes / Undo all (a git house folder, not a job's copy): the files go back to how the last commit
   *  has them, new files are deleted; staged changes of those files are unstaged. What was there is kept first
   *  (UndoneChanges). Refused while anyone works in the house folder. preview → only say what (ack.data = DiscardResult). */
  | { t: 'discard_changes'; reqId: string; projectId: string; paths: string[]; preview?: boolean }
  /** What Undo changes kept, newest first: ack.data = { undone: UndoneChanges[] }. */
  | { t: 'list_undone'; reqId: string; projectId: string }
  /** Bring back what an Undo changes kept (3-way into the house's files, like Bring in): ack.data = { plan: BringPlan }
   *  (preview: only say what). A complete bring back forgets that undo. */
  | { t: 'bring_back_undone'; reqId: string; projectId: string; id: string; preview?: boolean }
  | { t: 'fs_list'; reqId: string; path: string }
  | { t: 'refresh_models' }
  // Provider sign-in (one at a time; a new login_start cancels the previous one).
  | { t: 'login_start'; provider: string }
  | { t: 'login_input'; loginId: string; value: string } // pasted redirect URL / code, or an API key — never logged
  | { t: 'login_cancel'; loginId: string }
  // Extra environment for omp (OmpEnvView): ack.data = { ompEnv: OmpEnvView }. set: null removes a key; a change is
  // saved to config.json, re-detects the models and restarts idle omp processes on their next message.
  | { t: 'get_omp_env'; reqId: string }
  | { t: 'set_omp_env'; reqId: string; patch: Partial<Record<OmpEnvKey, string | null>> }
  // Model servers on another machine (omp's models.yml): list → ack.data = { servers: LocalServer[]; file: string };
  // test → ack.data = { models: string[] } (refused with the reason in words); save/remove → ack.data = { servers }, then
  // the models are checked again. save: apiKey absent keeps the saved key, null removes it.
  | { t: 'list_local_servers'; reqId: string }
  | { t: 'test_local_server'; reqId: string; kind: LocalServerKind; baseUrl: string; apiKey?: string; name?: string }
  | { t: 'save_local_server'; reqId: string; name: string; kind: LocalServerKind; baseUrl: string; apiKey?: string | null }
  | { t: 'remove_local_server'; reqId: string; name: string }
  // Provider accounts (Models & providers → Accounts)
  | { t: 'list_accounts'; reqId: string } // ack.data = { accounts: ProviderAccount[] }
  | { t: 'logout_account'; reqId: string; provider: string; credentialId: number } // ack.data = { accounts } (fresh list)
  | { t: 'get_usage'; reqId: string; force?: boolean } // ack.data = { usage: UsageSnapshot }; cached ~60 s unless force
  // Account order (handled by the agent system; see AccountOrder above)
  /** ack.data = { order: AccountOrder } at once, its limits from the last usage report. When that report is older
   *  than ~60 s, missing, or force: fresh limits follow as an 'account_order' push. */
  | { t: 'get_account_order'; reqId: string; force?: boolean }
  /** Save one provider's order: credentialIds first = preferred; its accounts left out come after them; [] → no
   *  order (omp's own). EVERY chat drops its own pick of this provider and follows the new order (until it picks
   *  again). ack.data = { order: AccountOrder } (also pushed to all clients as 'account_order'). */
  | { t: 'set_account_order'; reqId: string; provider: string; credentialIds: number[] }
  /** One chat's own account of a provider; null → back to following the order. threadId absent → the person's
   *  current chat. Leads and standing team members only. ack.data = { pending: boolean } (pending: saved, omp moves
   *  to it after this turn or before the chat's next message — see ChatAccount.pending). */
  | { t: 'set_chat_account'; reqId: string; agentId: string; threadId?: string; provider: string; credentialId: number | null }
  // Files of a person's folder, for the viewer (handled by the core). jobId: like get_git (a job with its own copy →
  // that copy; else, or absent → the house folder).
  | { t: 'files_key'; reqId: string; projectId: string; jobId?: string } // ack.data = FilesKey
  /** One folder; dir '' = the root. ack.data = { dir: string; entries: FileEntry[]; truncated?: boolean }
   *  (folders first, then by name; ≤ MAX_LIST_FILES). */
  | { t: 'list_files'; reqId: string; projectId: string; jobId?: string; dir: string }
  /** Every file's path (git: tracked + untracked not ignored; else a walk that skips dot folders and node_modules),
   *  ≤ MAX_FIND_FILES. query: only paths holding its characters in order (case-insensitive). ack.data =
   *  { paths: string[]; truncated?: boolean } */
  | { t: 'find_files'; reqId: string; projectId: string; jobId?: string; query?: string };

export const WS_PATH = '/ws';
export const SERVER_PORT = 4860;
/** The scripted test model's port (CAST_MOCK_LLM only; CAST_MOCK_PORT overrides it). */
export const MOCK_LLM_PORT = 4871;
