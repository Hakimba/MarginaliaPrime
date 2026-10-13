/**
 * How far the reader has read, for the anti-spoiler: the rule that moves the
 * furthest page read.
 *
 * It moves only when the reader reads on from where they had got to: one or
 * two pages forward (two in the two-page layout) from the furthest page read,
 * give or take a spread. Everything else is a visit and leaves it alone:
 *
 *   - a jump ahead (the book's index, an appendix, a link in an answer);
 *   - leafing through pages after such a jump (the index, page after page);
 *   - going back.
 *
 * A reader who really skips ahead to read a later chapter says so with one
 * click ("lu jusqu'à p. N" in the chat panel), which sets it to the page on
 * screen.
 */
export interface ProgressStep {
  /** Furthest page read so far, 1-based; 0 when nothing is recorded yet. */
  known: number;
  /** Page on screen before this move, 1-based; 0 right after opening. */
  previous: number;
  /** Page on screen now. */
  page: number;
  /** The stored state has been read: before that, nothing moves. */
  loaded: boolean;
}

/** Pages a single move may advance: one, or a spread of two. */
const STEP = 2;

export const nextMaxPage = ({ known, previous, page, loaded }: ProgressStep): number => {
  if (!loaded) return known;
  // Nothing recorded (a book opened for the first time): start where the
  // reader is.
  if (known <= 0) return page;
  const atTheLimit = previous > 0 && Math.abs(previous - known) <= STEP;
  const readingOn = page > previous && page - previous <= STEP;
  return atTheLimit && readingOn ? Math.max(known, page) : known;
};
