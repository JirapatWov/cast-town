// Plain words about a team, shared by the server (the lead's workflow tools, the scripted test model) and the web
// client (saving a workflow): a description made from the steps themselves, so a saved team never keeps a template's
// old text.
import type { WorkflowStep } from './protocol';

type StepText = Pick<WorkflowStep, 'id' | 'name' | 'model' | 'kind' | 'loopBackTo' | 'parallel'>;

/** "Decoder (Claude Opus 5.5) → Implementer (DeepSeek V4 Pro) → Reviewer (GPT-6.1 Sol). Reviewer checks the work and
 *  sends it back to Implementer when it needs changes." `label`: a model id → its readable name. */
export function describeTeam(steps: StepText[], label: (model: string) => string): string {
  if (!steps.length) return 'Nobody on this team yet.';
  const groups: StepText[][] = [];
  for (const s of steps) {
    if (s.parallel && groups.length) groups[groups.length - 1]!.push(s);
    else groups.push([s]);
  }
  const who = (s: StepText) => `${s.name} (${label(s.model)})`;
  const line = groups.map((g) => (g.length > 1 ? `${g.map(who).join(' + ')} at the same time` : who(g[0]!))).join(' → ');
  const reviews = steps
    .filter((s) => s.kind === 'review')
    .map((s) => {
      const back = s.loopBackTo ? steps.find((x) => x.id === s.loopBackTo) : undefined;
      return back ? `${s.name} checks the work and sends it back to ${back.name} when it needs changes.` : `${s.name} checks the work.`;
    });
  const text = [`${line}.`, ...reviews].join(' ');
  return text.length > 400 ? `${text.slice(0, 399)}…` : text;
}

/** A persona as lines about the person ("You polish prose lightly" → "Polishes prose lightly"; "You are the Editor.
 *  Never edit files" → "The Editor. Never edits files"): personas are written to the model, cards are read by the
 *  user. Best effort and English only — text that doesn't look English passes through unchanged. */
export function thirdPerson(persona: string): string {
  const t = persona.trim();
  if (!/\b(you|the|and|your)\b/i.test(t)) return t;
  return t
    .split(/(?<=[.!?])\s+/)
    .map(sentence)
    .join(' ')
    .replace(/\byourself\b/g, 'themselves')
    .replace(/\bYour\b/g, 'Their')
    .replace(/\byour\b/g, 'their')
    .replace(/\byou (?=(?:are|were|have|had|can|could|will|would|must|should|may|might|need|get|got|write|wrote|see|find|work|do|did|make)\b)/g, 'they ')
    .replace(/\byou\b/g, 'them');
}

/** Words a sentence starts with that aren't an order to the model (so they stay as they are). */
const NOT_VERB = new Set(
  'a an the their this that these those it its each every all any some one two three no not if when while after before for in on at with by from as so but and or to of there here only however also both either neither most many few such what which who whom whose where why how i we he she they your my our'.split(' '),
);
const ADVERB = /^(never|always|only|also|often|usually|rarely|just|first|then)$/i;

/** One sentence: "You are the X …" → "The X …"; "You write …" / "Write …" / "Never write …" → "Writes …" / "Never writes …". */
function sentence(s: string): string {
  let m = /^You are (an?|the) (.*)$/s.exec(s);
  if (m) return `${cap(m[1]!.toLowerCase())} ${m[2]}`;
  s = s.replace(/^You /, '').replace(/^Don[’']t /, 'Doesn’t ');
  m = /^([A-Za-z]+)(\s+)(\S+)(.*)$/s.exec(s);
  if (!m) return cap(s);
  const [, first, sp, second, rest] = m;
  if (ADVERB.test(first!)) return NOT_VERB.has(second!) || !/^[a-z]+$/.test(second!) ? cap(s) : andVerbs(`${cap(first!.toLowerCase())}${sp}${verbS(second!)}${rest}`);
  if (NOT_VERB.has(first!.toLowerCase()) || /^[A-Z]{2,}/.test(first!) || /[A-Z]/.test(first!.slice(1))) return cap(s);
  return andVerbs(`${cap(verbS(first!.toLowerCase()))}${sp}${second}${rest}`);
}

/** Verbs personas join with "and" / "or" / ";" after the first one ("Add or update tests", "read … and pitch …"). A
 *  short list on purpose: a word after "and" is often a noun ("outline and characters"), so only these change. */
const JOINED_VERB = 'add|update|pitch|mention|send|make|write|read|keep|check|ask|judge|block|trace|run|fix|edit|polish|report|flag|suggest|explain|finish|use|leave|note|list|test|verify'.split('|');
const JOINED = new RegExp(`(\\b(?:and|or)\\s+(?:(?:only|also|then|always|never)\\s+)?|;\\s+)(${JOINED_VERB.join('|')})\\b`, 'g');
/** In a sentence already turned into "Verbs …": the verbs joined to the first one agree too. */
function andVerbs(s: string): string {
  return s.replace(JOINED, (_m, lead: string, verb: string) => `${lead}${verbS(verb)}`);
}

const cap = (s: string) => (s ? s[0]!.toUpperCase() + s.slice(1) : s);

function verbS(verb: string): string {
  const irregular: Record<string, string> = { be: 'is', are: 'is', have: 'has', do: 'does', go: 'goes', can: 'can', will: 'will', must: 'must', should: 'should', may: 'may', don: 'doesn' };
  if (verb in irregular) return irregular[verb]!;
  return /(s|sh|ch|x|z|o)$/.test(verb) ? `${verb}es` : /[^aeiou]y$/.test(verb) ? `${verb.slice(0, -1)}ies` : `${verb}s`;
}
