import { describe, it, expect } from 'vitest';

import { detectFormulas } from '../../../packages/foliate-js/pdf-formulas.js';

/**
 * Synthetic pages laid out like the LaTeX book the detector was measured on:
 * running text in Charter at 10.5 pt between x = 72 and 406.7, mathematics in
 * Computer Modern at 10.9 pt, equation numbers flush right.
 */
interface Item {
  x: number;
  y: number;
  w: number;
  h: number;
  str: string;
  font: string;
  rot?: number;
}

const TEXT = 'HTQOZG+CharterBT-Roman';
const MI = 'DXQGZE+CMMI10';
const R = 'VKZMRM+CMR10';
const R7 = 'MSGGQM+CMR7';
const EX = 'TQFJUQ+CMEX10';

const t = (x: number, y: number, w: number, str: string, font = TEXT, h = 10.5): Item => ({
  x, y, w, h, str, font,
});

/** Full lines of justified prose, the column the page is measured against. */
const prose = (from: number, count: number): Item[] =>
  Array.from({ length: count }, (_, i) =>
    t(72, from + i * 13, 334.7, 'The running text of the page fills its whole line here'),
  );

const number = (y: number, label: string): Item =>
  t(406.7 - label.length * 5, y, label.length * 5, label);

const labels = (items: Item[]) => detectFormulas(items, 595).map((z) => z.label || '-');

describe('detectFormulas', () => {
  it('finds a numbered display and leaves prose with inline mathematics alone', () => {
    const items = [
      ...prose(100, 6),
      t(72, 180, 60, 'where we have'),
      t(134, 180, 8, 'α', MI, 10.9),
      t(144, 180, 150, 'as the parameter of the law'),
      // p(µ) = Γ(α)µ   (6.98)
      t(150, 205, 6, 'p', MI, 10.9),
      t(156, 205, 20, '(µ) =', R, 10.9),
      t(178, 205, 30, 'Γ(α)µ', MI, 10.9),
      number(205, '(6.98)'),
      ...prose(230, 6),
    ];
    const zones = detectFormulas(items, 595);
    expect(zones.map((z) => z.label)).toEqual(['(6.98)']);
    const [zone] = zones;
    // The box holds the formula, not its number.
    expect(zone!.x).toBeLessThan(150);
    expect(zone!.x + zone!.w).toBeLessThan(215);
    expect(zone!.text).toContain('Γ(α)µ');
  });

  it('keeps the lower limit of an integral with it, not with the equation below', () => {
    const items = [
      ...prose(100, 6),
      // Γ(t) := ∫_0^∞ … (6.100): the integral hangs from y = 251 down to about 274.
      t(138, 265, 30, 'Γ(t) :=', R, 10.9),
      t(175, 251, 6, 'Z', EX, 10.5),
      t(186, 253, 8, '∞', 'SOISIN+CMSY7', 7),
      t(181, 274.7, 4, '0', R7, 7),
      t(196, 265, 60, 'x exp(−x)dx', MI, 10.9),
      number(265, '(6.100)'),
      // Γ(t + 1) = tΓ(t)   (6.101), right below.
      t(119, 287.8, 80, 'Γ(t + 1) = tΓ(t)', MI, 10.9),
      number(287.8, '(6.101)'),
      ...prose(310, 6),
    ];
    const zones = detectFormulas(items, 595);
    expect(zones.map((z) => z.label)).toEqual(['(6.100)', '(6.101)']);
    const [integral, recurrence] = zones;
    expect(integral!.text).toContain('0');
    expect(recurrence!.text).not.toMatch(/^0/);
    // The first box reaches down to the limit; the second starts below it.
    expect(integral!.y + integral!.h).toBeGreaterThan(274);
    expect(recurrence!.y).toBeGreaterThan(270);
  });

  it('does not take the lettering of a plot for formulas', () => {
    const items = [
      ...prose(100, 6),
      // A legend and axis ticks in Computer Modern, smaller than the text.
      t(180, 360, 45, 'α = 0.5 = β', MI, 8.7),
      t(180, 372, 40, 'α = 1 = β', MI, 8.7),
      t(140, 470, 200, '0.0 0.2 0.4 0.6 0.8 1.0', R, 8.7),
      ...prose(500, 6),
    ];
    expect(labels(items)).toEqual([]);
  });

  it('reads a line opening on a word as prose', () => {
    const items = [
      ...prose(100, 6),
      t(150, 190, 38, 'for all', TEXT),
      t(190, 190, 40, 'x, y ∈ R', MI, 10.9),
      t(150, 205, 20, 'and', TEXT),
      t(172, 205, 50, 'Σ x = 1', MI, 10.9),
      ...prose(230, 6),
    ];
    expect(labels(items)).toEqual([]);
  });

  it('gives a display too wide for its number the number of the next line', () => {
    const items = [
      ...prose(100, 6),
      t(72, 205, 330, 'V[x] = ασ + (1 − α)σ + αµ + (1 − α)µ − [αµ + (1 − α)µ]', MI, 10.9),
      number(220, '(6.82)'),
      ...prose(245, 6),
    ];
    expect(labels(items)).toEqual(['(6.82)']);
  });

  it('keeps a matrix whole across its row of dots', () => {
    const items = [
      ...prose(100, 6),
      t(200, 190, 60, 'a11 · · · a1n', MI, 10.9),
      t(214, 204, 3, '.', TEXT),
      t(264, 204, 3, '.', TEXT),
      t(200, 218, 60, 'am1 · · · amn', MI, 10.9),
      t(170, 204, 20, 'A =', MI, 10.9),
      number(204, '(2.11)'),
      ...prose(245, 6),
    ];
    expect(labels(items)).toEqual(['(2.11)']);
  });

  it('strips the label opening a numbered line', () => {
    const items = [
      ...prose(100, 6),
      t(100, 200, 60, 'Product rule:'),
      t(190, 200, 120, "(f g)′ = f′g + fg′", MI, 10.9),
      number(200, '(5.29)'),
      ...prose(225, 6),
    ];
    const [zone] = detectFormulas(items, 595);
    expect(zone?.label).toBe('(5.29)');
    expect(zone!.x).toBeGreaterThan(180);
  });

  it('joins an equation number split in two items', () => {
    const items = [
      ...prose(100, 6),
      t(200, 200, 80, 'a = b + c', MI, 10.9),
      t(376.7, 200, 25, '(2.10'),
      t(401.7, 200, 5, ')'),
      ...prose(225, 6),
    ];
    expect(labels(items)).toEqual(['(2.10)']);
  });

  it('leaves the rows of a matrix set inside a sentence to the sentence', () => {
    const items = [
      ...prose(100, 6),
      // "For A = [1 2 3; 3 2 1] ∈ R, we obtain": rows above and below the text line.
      t(72, 205, 25, 'For'),
      t(99, 205, 22, 'A =', MI, 10.9),
      t(126, 198.5, 30, '1 2 3', R, 10.9),
      t(126, 211.5, 30, '3 2 1', R, 10.9),
      t(160, 205, 20, '∈ R', MI, 10.9),
      t(185, 205, 60, ', we obtain'),
      // AB = … (2.15), a display set apart below.
      t(150, 240, 80, 'AB = C', MI, 10.9),
      number(240, '(2.15)'),
      ...prose(265, 6),
    ];
    const zones = detectFormulas(items, 595);
    expect(zones.map((z) => z.label)).toEqual(['(2.15)']);
    // The display's box does not reach up into the sentence's rows.
    expect(zones[0]!.y).toBeGreaterThan(214);
  });

  it('keeps a box close to its glyphs under several braces', () => {
    const items = [
      ...prose(100, 6),
      t(150, 200, 10, 'A', MI, 10.9),
      t(162, 200, 10, 'B', MI, 10.9),
      t(174, 200, 10, 'C', MI, 10.9),
      // Three underbraces: hanging glyphs whose real depth is unknown.
      t(150, 204, 10, '|{z}', EX, 10.5),
      t(162, 204, 10, '|{z}', EX, 10.5),
      t(174, 204, 10, '|{z}', EX, 10.5),
      t(150, 214, 20, 'n×k', 'BSFIZJ+CMMI7', 7),
      number(200, '(2.14)'),
      ...prose(230, 6),
    ];
    const [zone] = detectFormulas(items, 595);
    expect(zone?.label).toBe('(2.14)');
    // Labels end near 215.5; the box must stay clear of the next line (top ≈ 222).
    expect(zone!.y + zone!.h).toBeLessThan(222);
  });

  it('finds nothing without font names', () => {
    const items = prose(100, 30).map((item) => ({ ...item, font: '' }));
    expect(detectFormulas(items, 595)).toEqual([]);
  });
});
