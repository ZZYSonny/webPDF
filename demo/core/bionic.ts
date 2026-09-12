/**
 * Bionic reading's strength, as the reader's setting.
 *
 * The drawing is the core's (`core/src/bionic.rs`): where a word's fixation
 * point is, and how faint the rest of it goes, both live there and both reach a
 * page as `fill-opacity`. What is here is the number the *control* shows before
 * anything has been rendered, and the clamp that keeps a slider's value - or a
 * value from `localStorage`, which may be anything at all - inside the range the
 * core will accept.
 *
 * The two have to agree, and they are three lines each; `main.ts` reads the
 * default from here and the core clamps whatever it is given, so a drift in
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
