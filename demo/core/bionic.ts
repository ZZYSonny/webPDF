/**
 * Bionic reading's strength and word scope, as the reader's settings.
 *
 * The drawing is the core's (`core/src/bionic.rs`): where a word's fixation
 * point is, how faint the rest of it goes, and which words are marked at all
 * live there and reach a page as `fill-opacity`. What is here is the number and
 * the name the *control* shows before anything has been rendered, and the
 * clamps that keep a slider's value - or a value from `localStorage`, which may
 * be anything at all - inside the range the core will accept.
 *
 * The two sides have to agree, and each is a handful of lines; `main.ts` reads
 * the defaults from here and the core clamps whatever it is given, so a drift in
 * either direction is invisible rather than wrong.
 */

/** How much strength the faded part of each word keeps. A half. */
export const BIONIC_DIM = 0.5;

/** The faintest a word may be drawn and still be read. */
export const BIONIC_MIN_DIM = 0.05;

export function bionicDim(value: number | null | undefined): number {
  if (value === null || value === undefined || !Number.isFinite(value)) return BIONIC_DIM;
  return Math.min(BIONIC_DIM, Math.max(BIONIC_MIN_DIM, value));
}

/**
 * Which words bionic reading marks.
 *
 * - `'prose'` is the default: the words a common English dictionary knows,
 *   minus the vocabulary of equations. It leaves a formula's `i`, `min`, `max`,
 *   `sin` and `log` exactly as the document set them, while still marking the
 *   prose around them.
 * - `'common'` is the dictionary without that subtraction. `dx`, `T0`, `mHC`,
 *   `2024` and a word in a script the list does not cover are still left alone
 *   because the list does not know them.
 * - `'short'` is every word of four letters or more, which leaves `the`, `is`,
 *   `dx`, `sin` and `log` alone.
 * - `'all'` is every word, which is what bionic reading usually means.
 */
export type BionicScope = 'prose' | 'common' | 'short' | 'all';

/** The scope a document opens with, and the one the menu shows in force. */
export const BIONIC_SCOPE: BionicScope = 'prose';

/** A scope from storage, or the default when it is not one this page knows. */
export function bionicScope(value: unknown): BionicScope {
  return value === 'prose' || value === 'common' || value === 'short' || value === 'all'
    ? value
    : BIONIC_SCOPE;
}
