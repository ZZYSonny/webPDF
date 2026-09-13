/**
 * The crop rules, and the reader's own.
 *
 *   node --test tests/rules.test.ts
 *
 * A rule is a name and a regular expression (`demo/core/rules.ts`), and this is
 * the half of it that does not need a PDF: which rules ship, what `{title}`
 * expands to, and what survives a trip through storage. Whether an expression
 * *means* what it says is the core's business and is checked in Rust; what is
 * checked here is that the menu hands the core the expression it printed.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  CROP_RULES,
  CUSTOM_RULES_LIMIT,
  RECOMMENDED_RULE_ID,
  expandPattern,
  nextCustomId,
  readCustomRules,
  ruleUsable,
  writeCustomRules,
  type CropRule,
} from '../demo/core/rules.ts';

test('the rules are the reference list, with the watermark gone', () => {
  assert.deepEqual(
    CROP_RULES.map((rule) => rule.id),
    ['arxiv', 'conference-header', 'page-number', 'section-number', 'chapter', 'title'],
  );
  // Every rule is a regular expression and nothing else: no hint, no prose.
  for (const rule of CROP_RULES) {
    assert.equal(typeof rule.pattern, 'string');
    assert.ok(rule.pattern.length > 0, `${rule.id} has an expression`);
    assert.equal('hint' in rule, false, `${rule.id} carries no hint`);
    assert.equal('source' in rule, false, `${rule.id} carries no source line`);
  }
  // The predicate PaperCutter's `s == "PRIME AI paper"` was, is not one of them.
  assert.equal(CROP_RULES.some((rule) => rule.pattern === '^PRIME AI paper$'), false);
  assert.equal(CROP_RULES.some((rule) => /PRIME/.test(rule.pattern)), false);
  // The recommendation is a built-in rule, and it is by id.
  assert.ok(CROP_RULES.some((rule) => rule.id === RECOMMENDED_RULE_ID));
});

test('the reference predicates keep their spelling as expressions', () => {
  const patternOf = (id: string): string => CROP_RULES.find((rule) => rule.id === id)?.pattern ?? '';
  assert.equal(patternOf('arxiv'), '^arXiv:');
  assert.equal(patternOf('conference-header'), '^Published as a conference paper at');
  assert.equal(patternOf('page-number'), '^\\s*[0-9]+\\s*$');
  assert.equal(patternOf('section-number'), '^[0-9]\\.[0-9]\\.');
  assert.equal(patternOf('chapter'), '^CHAPTER [0-9]\\.');
  // The one rule that cannot be written down: the document's own title.
  assert.equal(patternOf('title'), '^{title}$');
  assert.equal(CROP_RULES.find((rule) => rule.id === 'title')?.needsTitle, true);
});

test('a title is escaped, so a title full of brackets is a title', () => {
  const title = CROP_RULES.find((rule) => rule.id === 'title') as CropRule;
  assert.equal(expandPattern(title, 'Attention Is All You Need'), '^Attention Is All You Need$');
  assert.equal(expandPattern(title, 'A (2+2) study'), '^A \\(2\\+2\\) study$');
  assert.equal(expandPattern(title, 'a.b*c?'), '^a\\.b\\*c\\?$');
  // With no title the placeholder stands: the rule cannot apply, and the menu
  // disables it rather than sending an expression that matches nothing.
  assert.equal(expandPattern(title, ''), '^{title}$');
  assert.equal(ruleUsable(title, ''), false);
  assert.equal(ruleUsable(title, 'A title'), true);
  // A rule that does not need a title ignores it.
  const arxiv = CROP_RULES[0] as CropRule;
  assert.equal(expandPattern(arxiv, 'anything'), arxiv.pattern);
  assert.equal(ruleUsable(arxiv, ''), true);
});

test('the reader’s rules are read for what they are, and nothing is trusted', () => {
  assert.deepEqual(readCustomRules(null), []);
  assert.deepEqual(readCustomRules(''), []);
  assert.deepEqual(readCustomRules('not json'), []);
  assert.deepEqual(readCustomRules('{"pattern":"^a$"}'), []);
  // A rule needs an expression; a name is optional and falls back to it.
  assert.deepEqual(readCustomRules('[{"pattern":"^a$"}]'), [{ id: 'custom-1', label: '^a$', pattern: '^a$', custom: true }]);
  assert.deepEqual(
    readCustomRules('[{"id":"custom-9","label":"Mine","pattern":"^b$","custom":false,"needsTitle":true}]'),
    [{ id: 'custom-9', label: 'Mine', pattern: '^b$', custom: true }],
  );
  // Entries that are not rules are dropped, and an id that is missing, a
  // duplicate, or one of a built-in rule's is given a fresh one.
  const mixed = readCustomRules('[null,{"pattern":""},{"pattern":"^c$"},{"id":"custom-1","pattern":"^d$"},{"id":"page-number","pattern":"^e$"},7]');
  assert.deepEqual(
    mixed.map((rule) => [rule.id, rule.pattern]),
    [
      ['custom-1', '^c$'],
      ['custom-2', '^d$'],
      ['custom-3', '^e$'],
    ],
  );
  // The list cannot grow without end.
  const many = JSON.stringify(Array.from({ length: CUSTOM_RULES_LIMIT + 5 }, (_, i) => ({ pattern: `^p${i}$` })));
  assert.equal(readCustomRules(many).length, CUSTOM_RULES_LIMIT);
});

test('the reader’s rules go back to storage as what they are, and come back', () => {
  const rules: CropRule[] = [
    { id: 'custom-1', label: 'Mine', pattern: '^a$', custom: true },
    { id: 'custom-2', label: 'Yours', pattern: '^b$', custom: true },
  ];
  assert.equal(writeCustomRules(rules), '[{"id":"custom-1","label":"Mine","pattern":"^a$"},{"id":"custom-2","label":"Yours","pattern":"^b$"}]');
  assert.deepEqual(readCustomRules(writeCustomRules(rules)), rules);
  // A broken store is not a crash, and a round trip through one keeps nothing.
  assert.deepEqual(readCustomRules(writeCustomRules([])), []);
});

test('a new rule gets an id that is not taken', () => {
  assert.equal(nextCustomId([]), 'custom-1');
  assert.equal(nextCustomId(['custom-1']), 'custom-2');
  // Ids are found in the gaps, not merely appended after the highest.
  assert.equal(nextCustomId(['custom-2', 'custom-1']), 'custom-3');
  assert.equal(nextCustomId(CROP_RULES.map((rule) => rule.id)), 'custom-1');
});
