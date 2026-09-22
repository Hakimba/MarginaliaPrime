import { describe, it, expect } from 'vitest';

import {
  applyReadingOrder,
  bodyHeight,
  detectColumns,
  groupIntoLines,
  orderItems,
  pageToText,
} from '../../../packages/foliate-js/pdf-text-order.js';

interface Item {
  x: number;
  y: number;
  w: number;
  h: number;
  str: string;
  rot?: number;
}

const item = (x: number, y: number, w: number, str: string, h = 10): Item => ({ x, y, w, h, str });

/**
 * The lettering of a plot as a PDF lays it out: tiny type, scattered across the
 * width, sometimes turned on its side. Measured on a real book: running text
 * 10.5, captions 8, axis ticks and legends 4.5 to 6.5.
 */
const plotLettering = (): Item[] => [
  { x: 150, y: 400, w: 6, h: 6.5, str: '10' },
  { x: 200, y: 400, w: 40, h: 6.5, str: 'Training data' },
  { x: 150, y: 412, w: 4, h: 6.5, str: '2' },
  { x: 330, y: 412, w: 4, h: 6.5, str: '5' },
  { x: 150, y: 424, w: 4, h: 4.5, str: 'y', rot: 90 },
  { x: 250, y: 424, w: 4, h: 6.5, str: '0' },
  { x: 150, y: 436, w: 8, h: 6.5, str: '−4' },
  { x: 340, y: 436, w: 8, h: 6.5, str: '−10' },
];

/**
 * A page laid out like the technical books this reader is for: a body column
 * with a marginal column of glosses, the geometry measured on a real one
 * (margin at x=60, body from x=144, lines 10.5 apart, exponents 5 above the
 * baseline, matrix rows 13 apart).
 */
const bookPage = () => {
  const items: Item[] = [];
  let y = 120;
  for (let line = 0; line < 12; line++) {
    let x = 144;
    for (const word of ['une', 'ligne', 'de', 'texte', `numéro${line}`]) {
      items.push(item(x, y, word.length * 5, word));
      x += word.length * 5 + 3;
    }
    y += 10.5;
  }
  // Two glosses in the margin, the first wrapping over two lines.
  items.push(item(60, 141, 40, 'une glose', 8));
  items.push(item(60, 151.5, 40, 'qui continue.', 8));
  items.push(item(60, 183, 40, 'mot-clé', 8));
  return items;
};

describe('detectColumns', () => {
  it('separates a marginal column from the body', () => {
    const columns = detectColumns(bookPage(), 595);
    expect(columns).toHaveLength(2);
    expect(columns[0].margin).toBe(true);
    expect(columns[1].margin).toBe(false);
  });

  it('keeps both columns of a genuine two-column layout as body text', () => {
    const items: Item[] = [];
    for (let line = 0; line < 20; line++) {
      const y = 100 + line * 11;
      items.push(item(60, y, 200, `gauche${line}`));
      items.push(item(320, y, 200, `droite${line}`));
    }
    const columns = detectColumns(items, 595);
    expect(columns).toHaveLength(2);
    expect(columns.every((c: { margin: boolean }) => !c.margin)).toBe(true);
  });

  it('treats a sparse page as a single column', () => {
    expect(detectColumns([item(100, 100, 50, 'titre')], 595)).toHaveLength(1);
  });
});

describe('groupIntoLines', () => {
  it('keeps an exponent on the line of its base', () => {
    const lines = groupIntoLines([item(100, 200, 8, 'x'), item(108, 195, 4, '2', 7)], 10);
    expect(lines).toHaveLength(1);
    expect(lines[0].items.map((i: Item) => i.str)).toEqual(['x', '2']);
  });

  it('keeps two rows of a matrix apart', () => {
    const lines = groupIntoLines([item(100, 200, 8, 'a11'), item(100, 213, 8, 'a21')], 10);
    expect(lines).toHaveLength(2);
  });

  it('reads a line from left to right whatever the emission order', () => {
    const lines = groupIntoLines([item(200, 100, 8, 'monde'), item(100, 100, 8, 'bonjour')], 10);
    expect(lines[0].items.map((i: Item) => i.str)).toEqual(['bonjour', 'monde']);
  });
});

describe('orderItems', () => {
  it('reads the body first and the margin last', () => {
    const { order } = orderItems(bookPage(), 595);
    const glossAt = order.findIndex((i: Item) => i.str === 'une glose');
    const lastBodyAt = order.map((i: Item) => i.str).lastIndexOf('numéro11');
    expect(glossAt).toBeGreaterThan(lastBodyAt);
  });

  it('reads a two-column layout column by column', () => {
    const items: Item[] = [];
    for (let line = 0; line < 20; line++) {
      const y = 100 + line * 11;
      items.push(item(60, y, 200, `gauche${line}`));
      items.push(item(320, y, 200, `droite${line}`));
    }
    const { order } = orderItems(items, 595);
    const strs = order.map((i: Item) => i.str);
    expect(strs.indexOf('droite0')).toBeGreaterThan(strs.indexOf('gauche19'));
  });
});

describe('bodyHeight', () => {
  it('takes the height of the running text, not of the numerous short lines', () => {
    const items = [
      ...Array.from({ length: 10 }, (_, i) => item(144, 100 + i * 11, 300, 'x'.repeat(70))),
      ...Array.from({ length: 6 }, (_, i) => ({ x: 144, y: 300 + i * 9, w: 300, h: 8, str: 'note' })),
    ];
    expect(bodyHeight(items)).toBe(10);
  });
});

describe('isGraphicLine', () => {
  it('sets the lettering of a plot apart and keeps the caption', () => {
    const items: Item[] = [
      ...bookPage(),
      ...plotLettering(),
      // The caption, worth reading: barely smaller than the body, and it fills
      // its line.
      { x: 144, y: 460, w: 330, h: 8, str: '(a) Regression problem: find the parameters' },
    ];
    const { lines } = orderItems(items, 595);
    const zoneOfText = (needle: string) =>
      lines.find((line: { items: Item[] }) => line.items.some((i) => i.str.includes(needle)))?.zone;
    expect(zoneOfText('Training data')).toBe('figure');
    expect(zoneOfText('−4')).toBe('figure');
    expect(zoneOfText('Regression problem')).toBe('body');
    expect(zoneOfText('numéro0')).toBe('body');
  });

  it('reads the body first, then the plots, then the margin', () => {
    const { lines } = orderItems([...bookPage(), ...plotLettering()], 595);
    const zones = lines.map((line: { zone: string }) => line.zone);
    expect(zones.lastIndexOf('body')).toBeLessThan(zones.indexOf('figure'));
    expect(zones.lastIndexOf('figure')).toBeLessThan(zones.indexOf('margin'));
  });
});

describe('pageToText', () => {
  it('labels the marginal notes and keeps them out of the body', () => {
    const text = pageToText(bookPage(), 595);
    const [body, notes] = text.split('\n\n');
    expect(body).toContain('une ligne de texte numéro0');
    expect(body).not.toContain('glose');
    expect(notes).toContain('[note de marge] une glose qui continue.');
    expect(notes).toContain('[note de marge] mot-clé');
  });

  it('labels the lettering of a plot and keeps it out of the body', () => {
    const text = pageToText([...bookPage(), ...plotLettering()], 595);
    const [body = ''] = text.split('\n\n');
    expect(body).not.toContain('Training data');
    expect(text).toContain('[figure]');
    expect(text.indexOf('[figure]')).toBeLessThan(text.indexOf('[note de marge]'));
  });

  it('restores the space a PDF only expresses as a gap', () => {
    // Two words of the body column, positioned as a LaTeX producer does: no
    // space item between them, only a four-point gap.
    const text = pageToText(
      [...bookPage(), item(200, 250, 30, 'matrice'), item(234, 250, 8, 'A')],
      595,
    );
    expect(text).toContain('matrice A');
  });
});

describe('applyReadingOrder', () => {
  /** jsdom has no layout: rects are supplied from the items themselves. */
  const layer = (items: Item[]) => {
    const container = document.createElement('div');
    container.className = 'textLayer';
    container.getBoundingClientRect = () =>
      ({ left: 0, top: 0, width: 595, height: 842 }) as DOMRect;
    for (const it of items) {
      const span = document.createElement('span');
      span.textContent = it.str;
      span.getBoundingClientRect = () =>
        ({ left: it.x, top: it.y, width: it.w, height: it.h }) as DOMRect;
      container.append(span);
    }
    const end = document.createElement('div');
    end.className = 'endOfContent';
    container.append(end);
    return container;
  };

  it('reorders the spans, tags the margin and keeps the end marker last', () => {
    // Emission order of a real producer: the glosses of the margin are
    // interleaved in the middle of the body text.
    const items = bookPage();
    const shuffled = [...items.slice(0, 20), ...items.slice(-3), ...items.slice(20, -3)];
    const container = layer(shuffled);

    expect(applyReadingOrder(container)).not.toBeNull();

    const spans = Array.from(container.querySelectorAll('span'));
    const texts = spans.map((s) => s.textContent);
    const margins = spans.filter((s) => s.dataset.zone === 'margin');
    expect(margins.map((s) => s.textContent)).toEqual([
      'une glose',
      'qui continue.',
      'mot-clé',
    ]);
    // Every marginal span is out of the body's way, at the very end.
    expect(texts.slice(-3)).toEqual(['une glose', 'qui continue.', 'mot-clé']);
    expect(texts.indexOf('numéro0')).toBeLessThan(texts.indexOf('numéro1'));
    expect(spans[0]!.dataset.zone).toBeUndefined();
    expect(container.lastElementChild!.className).toBe('endOfContent');
  });

  it('records the space a gap stands for on the following word', () => {
    const container = layer([
      ...bookPage(),
      item(200, 250, 30, 'matrice'),
      item(234, 250, 8, 'A'),
      item(243, 250, 8, ','),
    ]);
    applyReadingOrder(container);
    const spans = Array.from(container.querySelectorAll('span'));
    const byText = (text: string) => spans.find((s) => s.textContent === text)!;
    expect(byText('A').dataset.space).toBe('1');
    expect(byText(',').dataset.space).toBeUndefined();
  });

  it('cuts a line break at the end of every visual line', () => {
    const container = layer([item(144, 120, 40, 'ligne1'), item(144, 140, 40, 'ligne2')]);
    applyReadingOrder(container);
    expect(container.textContent).toBe('ligne1ligne2');
    expect(container.querySelectorAll('br')).toHaveLength(2);
  });
});
