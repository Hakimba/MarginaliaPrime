import { describe, expect, it } from 'vitest';

import { fitRows, inkBands, inkRows } from '../../../packages/foliate-js/pdf-crop-fit.js';

/** Rows from a picture drawn as a string: '#' holds ink, '.' does not. */
const rowsOf = (picture: string): boolean[] => [...picture].map((c) => c === '#');

describe('inkRows', () => {
  it('finds the rows with a dark pixel on a white page', () => {
    const width = 3;
    const white = [255, 255, 255, 255];
    const black = [20, 20, 20, 255];
    const data = new Uint8ClampedArray([
      ...white, ...white, ...white,
      ...white, ...black, ...white,
      ...white, ...white, ...white,
    ]);
    expect(inkRows(data, width, 3)).toEqual([false, true, false]);
  });

  /** An image of `rows` strings, '#' a black pixel, '.' a white one. */
  const image = (rows: string[]) => {
    const width = rows[0]!.length;
    const data = new Uint8ClampedArray(width * rows.length * 4).fill(255);
    rows.forEach((row, y) =>
      [...row].forEach((c, x) => {
        if (c === '#') data.fill(20, (y * width + x) * 4, (y * width + x) * 4 + 3);
      }),
    );
    return { data, width, height: rows.length };
  };

  it('ignores a rule running down the whole drawing, like the frame of a box', () => {
    const { data, width, height } = image(['#....', '#.##.', '#....', '#.##.', '#....']);
    expect(inkRows(data, width, height)).toEqual([false, true, false, true, false]);
  });

  it('reads the rows between the given columns only', () => {
    // A margin note in the last column, at another height.
    const { data, width, height } = image(['....#', '.##..', '....#', '.....', '.##..']);
    expect(inkRows(data, width, height, 200, 0, 4)).toEqual([false, true, false, false, true]);
  });
});

describe('inkBands', () => {
  it('groups consecutive inked rows', () => {
    expect(inkBands(rowsOf('..##..###.#'))).toEqual([
      { start: 2, end: 4 },
      { start: 6, end: 9 },
      { start: 10, end: 11 },
    ]);
  });
});

describe('fitRows', () => {
  // Line above at rows 0–9, selected line 14–27 with its indices, line below
  // 32–41. The boxes of the selection cover rows 8–24: they start in the
  // descenders of the line above and stop above the indices.
  const page = rowsOf(`${'#'.repeat(10)}....${'#'.repeat(14)}....${'#'.repeat(10)}`);

  it('keeps the whole selected line, indices included, and nothing of its neighbours', () => {
    expect(fitRows(page, 8, 24)).toEqual({ top: 14, bottom: 28 });
  });

  it('pads the ink it keeps', () => {
    expect(fitRows(page, 8, 24, 2)).toEqual({ top: 12, bottom: 30 });
  });

  it('never pads into the ink of a band it left out', () => {
    // An equation number starting one row below the selected line.
    const close = rowsOf(`....${'#'.repeat(10)}.${'#'.repeat(6)}`);
    expect(fitRows(close, 3, 13, 3)).toEqual({ top: 1, bottom: 15 });
  });

  it('keeps every line of a multi-line selection', () => {
    expect(fitRows(page, 8, 38)).toEqual({ top: 14, bottom: 42 });
  });

  it('keeps a selected line merged with its neighbour by touching ink', () => {
    // Rows 0–27 are one band: the line above and the selected one touch.
    const tight = rowsOf(`${'#'.repeat(28)}....`);
    expect(fitRows(tight, 14, 26)).toBeNull();
    expect(fitRows(tight, 14, 26, 0, 4)).toEqual({ top: 0, bottom: 28 });
  });

  it('gives up on a page with ink on every row, or none, whatever the guard', () => {
    expect(fitRows(rowsOf('#'.repeat(40)), 10, 20)).toBeNull();
    expect(fitRows(rowsOf('#'.repeat(40)), 10, 20, 2, 4)).toBeNull();
    expect(fitRows(rowsOf('.'.repeat(40)), 10, 20, 2, 4)).toBeNull();
  });

  it('keeps the selected line with the guard used in the app', () => {
    expect(fitRows(page, 8, 24, 2, 4)).toEqual({ top: 12, bottom: 30 });
  });
});
