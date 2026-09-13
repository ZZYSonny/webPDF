/**
 * The crop rules, and the reader's own.
 *
 * A rule is a name and a regular expression. The *test* is the expression and
 * nothing else: a text run is left out of a page's crop box when any selected
 * expression matches anywhere in it, so `^` and `$` are how a rule says "at the
 * start" or "the whole run" and everything else is the reader's to write. The
 * core (`core/src/crop.rs`) compiles the list and matches it; it knows nothing
 * about what a rule is called, which is why the list lives here.
 *
 * The built-in rules are PaperCutter's own filter list, each predicate lifted
 * into the expression that means the same thing, and the menu shows a rule's
 * expression rather than a description of it: what a rule does is exactly what
 * it says. `{title}` is the one substitution - the document's title, escaped -
 * because "a run that is the title" is the one mark that depends on the
 * document and no expression can name it on its own.
 *
 * A reader can add their own rules and they are kept in `localStorage`, page
 * and all: the vocabulary a reader builds up is theirs, not a document's, which
 * is why the rules are stored beside the memory rather than inside it.
 */

/** The id of a crop rule. A string, because ids also arrive from storage. */
export type CropRuleId = string;

/** One crop rule: a name a reader recognises, and the expression it applies. */
export interface CropRule {
  id: CropRuleId;
  label: string;
  /**
   * The regular expression, matched anywhere in a text run. `{title}` stands for
   * the document's own title, escaped: see `expandPattern`.
   */
  pattern: string;
  /** True when the expression is only meaningful once the title is known. */
  needsTitle?: boolean;
  /** True for a rule the reader added, which the menu lets them remove. */
  custom?: boolean;
}

/**
 * The rules every document starts with, in the order the menu draws them.
 *
 * Each `pattern` is the predicate of the same name in PaperCutter's
 * `cutter.py`, anchored the way that predicate was: `startswith` and
 * `re.match` both mean "at the start", and `isdigit` after a `strip()` means
 * "nothing but digits, whole". The expressions are deliberately ASCII: the
 * script's `isdigit()` accepts every Unicode digit, and a numbered page is set
 * in the ASCII ones.
 */
export const CROP_RULES: readonly CropRule[] = [
  {
    id: 'arxiv',
    label: 'arXiv stamp',
    pattern: String.raw`^arXiv:`,
  },
  {
    id: 'conference-header',
    label: 'Conference header',
    pattern: String.raw`^Published as a conference paper at`,
  },
  {
    id: 'page-number',
    label: 'Page number',
    pattern: String.raw`^\s*[0-9]+\s*$`,
  },
  {
    id: 'section-number',
    label: 'Section number',
    pattern: String.raw`^[0-9]\.[0-9]\.`,
  },
  {
    id: 'chapter',
    label: 'Chapter heading',
    pattern: String.raw`^CHAPTER [0-9]\.`,
  },
  {
    id: 'title',
    label: 'Running title',
    pattern: '^{title}$',
    needsTitle: true,
  },
];

/**
 * The rule the menu stars: the one nearly every paper needs.
 *
 * A recommendation and not a state - the row starts unchecked like every other,
 * because cropping is opt-in.
 */
export const RECOMMENDED_RULE_ID: CropRuleId = 'page-number';

/** Where the reader's own rules live in `localStorage`. */
export const CUSTOM_RULES_KEY = 'webpdf.crop.rules';

/** The most rules a reader's own list will hold, so storage cannot grow forever. */
export const CUSTOM_RULES_LIMIT = 50;

/**
 * `text` with every character an expression would read as syntax escaped.
 *
 * Deliberately broad: escaping a character that did not need it is still that
 * character, and the escape is understood by Rust's engine as well as by
 * JavaScript's.
 */
export function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * The expression a rule applies to a document with this title.
 *
 * The title is escaped, so a title full of brackets is a title and not a
 * pattern. A title-less document leaves `{title}` standing: the rule cannot be
 * used there, and the row is disabled rather than silently matching nothing.
 */
export function expandPattern(rule: CropRule, title: string): string {
  if (!rule.needsTitle) return rule.pattern;
  return title === '' ? rule.pattern : rule.pattern.replaceAll('{title}', escapeRegExp(title));
}

/** Can this rule do anything at all on a document with this title? */
export function ruleUsable(rule: CropRule, title: string): boolean {
  return !rule.needsTitle || title !== '';
}

/** The id for a rule the reader is adding, never colliding with one already held. */
export function nextCustomId(taken: Iterable<CropRuleId>): CropRuleId {
  const used = new Set(taken);
  for (let n = 1; ; n++) {
    const id = `custom-${n}`;
    if (!used.has(id)) return id;
  }
}

/** One rule out of anything that claims to be one, or null. */
function customRuleOf(raw: unknown): CropRule | null {
  if (!raw || typeof raw !== 'object') return null;
  const value = raw as Partial<CropRule>;
  if (typeof value.pattern !== 'string' || value.pattern.trim() === '') return null;
  const label = typeof value.label === 'string' && value.label.trim() !== '' ? value.label : value.pattern;
  return {
    id: typeof value.id === 'string' && value.id !== '' ? value.id : '',
    label,
    pattern: value.pattern,
    custom: true,
  };
}

/**
 * The reader's own rules, out of whatever storage held.
 *
 * Storage is a file on a disk this code does not own, and it is shared with
 * every version of this page the reader has ever loaded, so an entry that does
 * not look like a rule is dropped and one that does is read for exactly what it
 * is. An id is the one thing a rule cannot be without, so one that is missing -
 * or that would collide with a built-in or with an earlier entry - is given a
 * fresh one rather than trusted.
 */
export function readCustomRules(raw: string | null): CropRule[] {
  if (!raw) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const rules: CropRule[] = [];
  const taken = new Set<CropRuleId>(CROP_RULES.map((rule) => rule.id));
  for (const entry of parsed) {
    const rule = customRuleOf(entry);
    if (!rule) continue;
    if (rule.id === '' || taken.has(rule.id)) rule.id = nextCustomId(taken);
    taken.add(rule.id);
    rules.push(rule);
    if (rules.length === CUSTOM_RULES_LIMIT) break;
  }
  return rules;
}

/** The reader's rules as they go back into storage: what a rule is, and no more. */
export function writeCustomRules(rules: readonly CropRule[]): string {
  return JSON.stringify(
    rules.slice(0, CUSTOM_RULES_LIMIT).map((rule) => ({ id: rule.id, label: rule.label, pattern: rule.pattern })),
  );
}
