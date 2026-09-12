/**
 * The crop rules, as the menu shows them.
 *
 * The *test* each rule makes lives in the core (`core/src/crop.rs`), because
 * applying it means reading the page; what is here is the copy around it - the
 * name, the one-line hint, and the line of PaperCutter the rule came from, which
 * the menu shows so that nothing about a crop is a guess.
 *
 * The two lists have to agree about their ids or a toggle would name a rule the
 * core does not have, so `engine.ts` asks the core for its list when a document
 * opens and warns about any it has that this does not.
 */

import type { CropRule } from './types.ts';

export const CROP_RULES: readonly CropRule[] = [
  {
    id: 'arxiv',
    label: 'arXiv stamp',
    hint: 'the identifier arXiv prints in the left margin',
    source: 's.startswith("arXiv:")',
    needsTitle: false,
  },
  {
    id: 'conference-header',
    label: 'Conference header',
    hint: 'the publisher’s line across the top',
    source: 's.startswith("Published as a conference paper at")',
    needsTitle: false,
  },
  {
    id: 'page-number',
    label: 'Page number',
    hint: 'a span that is nothing but digits',
    source: 's.lstrip().rstrip().isdigit()',
    needsTitle: false,
  },
  {
    id: 'section-number',
    label: 'Section number',
    hint: 'a heading that opens with “3.1.”',
    source: 're.match("[0-9]\\.[0-9]\\.", s)',
    needsTitle: false,
  },
  {
    id: 'chapter',
    label: 'Chapter heading',
    hint: 'a heading that opens with “CHAPTER 1.”',
    source: 're.match("CHAPTER [0-9]\\.", s)',
    needsTitle: false,
  },
  {
    id: 'prime-ai',
    label: 'PRIME AI watermark',
    hint: 'the line “PRIME AI paper”',
    source: 's == "PRIME AI paper"',
    needsTitle: false,
  },
  {
    id: 'title',
    label: 'Running title',
    hint: 'the document’s own title, repeated as a header',
    source: 's == title  (common_filter_function)',
    needsTitle: true,
  },
];

/** The ids of the rules the core knows, for the drift check. */
export function declaredRuleIds(): string[] {
  return CROP_RULES.map((rule) => rule.id);
}
