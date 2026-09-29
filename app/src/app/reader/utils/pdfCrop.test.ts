import { describe, expect, it } from 'vitest';

import { CROP_MARGIN, CROP_MARGIN_Y, selectionRegion, withTimeout } from './pdfCrop';

const page = { w: 612, h: 792 };
const box = (left: number, top: number, right: number, bottom: number) => ({
  left,
  top,
  right,
  bottom,
});

describe('selectionRegion', () => {
  it('converts one line to points, with the margin', () => {
    // 2 px per point, text layer at (100, 50) in the iframe.
    const region = selectionRegion([box(300, 250, 500, 270)], { left: 100, top: 50 }, 2, page);
    expect(region).toEqual({
      x: 100 - CROP_MARGIN,
      y: 100 - CROP_MARGIN_Y,
      w: 100 + 2 * CROP_MARGIN,
      h: 10 + 2 * CROP_MARGIN_Y,
    });
  });

  it('gives the same region at any zoom', () => {
    const at = (k: number) =>
      selectionRegion([box(72 * k, 144 * k, 300 * k, 160 * k)], { left: 0, top: 0 }, k, page);
    expect(at(1)).toEqual(at(2.5));
    expect(at(0.75)).toEqual(at(1));
  });

  it('covers every line of a multi-line selection', () => {
    const region = selectionRegion(
      [box(150, 100, 400, 112), box(72, 114, 540, 126), box(72, 128, 200, 140)],
      { left: 0, top: 0 },
      1,
      page,
      0,
      0,
    );
    expect(region).toEqual({ x: 72, y: 100, w: 468, h: 40 });
  });

  it('never leaves the page', () => {
    const region = selectionRegion([box(2, 1, 610, 791)], { left: 0, top: 0 }, 1, page, 8, 4);
    expect(region).toEqual({ x: 0, y: 0, w: 612, h: 792 });
  });

  it('ignores empty boxes, and gives nothing when all are empty', () => {
    const region = selectionRegion(
      [box(10, 10, 10, 30), box(100, 100, 200, 110)],
      { left: 0, top: 0 },
      1,
      page,
      0,
      0,
    );
    expect(region).toEqual({ x: 100, y: 100, w: 100, h: 10 });
    expect(selectionRegion([box(5, 5, 5, 5)], { left: 0, top: 0 }, 1, page)).toBeNull();
    expect(selectionRegion([], { left: 0, top: 0 }, 1, page)).toBeNull();
  });

  it('gives nothing when the page scale is unknown', () => {
    expect(selectionRegion([box(0, 0, 10, 10)], { left: 0, top: 0 }, 0, page)).toBeNull();
  });
});

describe('withTimeout', () => {
  it('gives up on a render that never ends', async () => {
    expect(await withTimeout(new Promise(() => {}), 10)).toBeUndefined();
    expect(await withTimeout(Promise.resolve('png'), 10)).toBe('png');
  });
});
