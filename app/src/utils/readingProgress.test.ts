import { describe, expect, it } from 'vitest';

import { nextMaxPage } from './readingProgress';

/** Moves from `start` (furthest read = `known`) through `pages`; the last value. */
const walk = (known: number, start: number, pages: number[]): number => {
  let max = known;
  let previous = start;
  for (const page of pages) {
    max = nextMaxPage({ known: max, previous, page, loaded: true });
    previous = page;
  }
  return max;
};

describe('nextMaxPage', () => {
  it('follows the reader reading on, page by page or spread by spread', () => {
    expect(walk(30, 30, [31, 32, 33])).toBe(33);
    expect(walk(30, 30, [32, 34])).toBe(34);
  });

  it('keeps it when the reader goes back, then follows again from the limit', () => {
    expect(walk(30, 30, [20, 21, 22])).toBe(30);
    expect(walk(30, 30, [20, 30, 31])).toBe(31);
  });

  it('ignores a jump ahead and the leafing after it', () => {
    // The book's index: 30 → 450, then 451, 452 while looking for a word.
    expect(walk(30, 30, [450, 451, 452])).toBe(30);
    // And back to where the reader was: still 30.
    expect(walk(30, 30, [450, 451, 30])).toBe(30);
  });

  it('starts where the reader is when nothing is recorded', () => {
    expect(nextMaxPage({ known: 0, previous: 0, page: 42, loaded: true })).toBe(42);
  });

  it('moves nothing before the stored state is read', () => {
    expect(nextMaxPage({ known: 0, previous: 0, page: 450, loaded: false })).toBe(0);
  });

  it('does not count the page a book reopens on as read further', () => {
    // Closed on the index page last time: reopening there is not reading.
    expect(nextMaxPage({ known: 30, previous: 0, page: 450, loaded: true })).toBe(30);
  });
});
