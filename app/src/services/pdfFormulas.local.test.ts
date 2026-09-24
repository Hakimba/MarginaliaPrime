import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';

/**
 * Formula detection on real pages of Mathematics for Machine Learning.
 * Skipped unless MARGINALIA_TEST_PDF points at that book: it cannot be
 * committed here. Page numbers are PDF page numbers (printed page + 6).
 */
const file = process.env['MARGINALIA_TEST_PDF'] ?? '';
const available = !!file && existsSync(file);

interface Zone {
  label: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

describe.skipIf(!available)('formulas of a real PDF', () => {
  const zonesOf = async (pageNumbers: number[]): Promise<Map<number, Zone[]>> => {
    await import('../../../packages/foliate-js/pdf.js');
    const { detectFormulas } = await import('../../../packages/foliate-js/pdf-formulas.js');
    type Pdfjs = {
      GlobalWorkerOptions: { workerSrc: string };
      getDocument: (o: object) => { promise: Promise<PdfDoc> };
    };
    type PdfPage = {
      getViewport: (o: object) => {
        width: number;
        height: number;
        convertToViewportPoint: (x: number, y: number) => number[];
      };
      getTextContent: () => Promise<{ items: PdfItem[] }>;
      getOperatorList: () => Promise<unknown>;
      commonObjs: { has: (id: string) => boolean; get: (id: string) => { name?: string } };
    };
    type PdfDoc = { getPage: (n: number) => Promise<PdfPage> };
    type PdfItem = { str: string; transform: number[]; width: number; height: number; fontName: string };
    const pdfjs = (globalThis as unknown as { pdfjsLib: Pdfjs }).pdfjsLib;
    const { pathToFileURL } = await import('node:url');
    const { resolve } = await import('node:path');
    pdfjs.GlobalWorkerOptions.workerSrc = pathToFileURL(
      resolve(process.cwd(), 'public/vendor/pdfjs/pdf.worker.min.mjs'),
    ).href;
    const doc = await pdfjs.getDocument({
      data: new Uint8Array(readFileSync(file)),
      standardFontDataUrl: `${pathToFileURL(resolve(process.cwd(), 'public/vendor/pdfjs/standard_fonts')).href}/`,
    }).promise;
    const result = new Map<number, Zone[]>();
    for (const n of pageNumbers) {
      const page = await doc.getPage(n);
      const viewport = page.getViewport({ scale: 1 });
      const { items } = await page.getTextContent();
      await page.getOperatorList();
      const font = (id: string) => (page.commonObjs.has(id) ? page.commonObjs.get(id)?.name ?? '' : '');
      result.set(
        n,
        detectFormulas(
          items
            .filter((i) => typeof i.str === 'string')
            .map((i) => ({
              x: viewport.convertToViewportPoint(i.transform[4]!, i.transform[5]!)[0]!,
              y: viewport.convertToViewportPoint(i.transform[4]!, i.transform[5]!)[1]!,
              w: i.width,
              h: i.height,
              rot: Math.round((Math.atan2(i.transform[1]!, i.transform[0]!) * 180) / Math.PI),
              str: i.str,
              font: font(i.fontName),
            })),
          viewport.width,
        ) as Zone[],
      );
    }
    return result;
  };

  it('finds each numbered display of pages with fractions, integrals, systems and matrices', async () => {
    const zones = await zonesOf([213, 208, 26, 24, 28, 151]);
    const labels = (n: number) => zones.get(n)!.map((z) => z.label || '-');
    // p. 207: Beta law, E and V on one line, the Gamma integral and its recurrence.
    expect(labels(213)).toEqual(['(6.98)', '(6.99)', '(6.100)', '(6.101)']);
    // p. 202: a display too wide for its number, aligned equations one per number.
    expect(labels(208)).toEqual([
      '(6.80)', '(6.81)', '(6.82)', '(6.83a)', '(6.83b)', '(6.83c)', '(6.83d)', '(6.84a)', '(6.84b)',
    ]);
    // p. 20: a system with vertical dots, systems with row labels, a tuple.
    expect(labels(26)).toEqual(['(2.2)', '(2.3)', '(2.4)', '(2.5)', '(2.6)', '(2.7)']);
    // p. 18: a column vector between tall brackets.
    expect(labels(24)).toEqual(['(2.1)']);
    // p. 22: matrices whose dots are set in the text font, split numbers.
    expect(labels(28)).toEqual(['(2.10)', '(2.11)', '(2.12)', '(2.13)']);
    // p. 145: numbered lines opening on a label ("Product rule:").
    expect(labels(151)).toContain('(5.29)');
    expect(labels(151)).toContain('(5.32)');
  }, 60_000);

  it('leaves matrices set inside a sentence alone, and keeps boxes apart', async () => {
    const zones = await zonesOf([29, 310]);
    // p. 23, Example 2.3: "For A = [...] ∈ R2×3, B = [...] ∈ R3×2, we obtain".
    const page = zones.get(29)!;
    expect(page.map((z) => z.label)).toEqual(['(2.14)', '(2.15)', '(2.16)', '(2.17)']);
    for (let i = 0; i + 1 < page.length; i += 1) {
      expect(page[i]!.y + page[i]!.h).toBeLessThanOrEqual(page[i + 1]!.y + 0.01);
    }
    // (2.14) stays above the sentence that follows it: baseline 294.6 pt,
    // capitals reaching up to about 287.5.
    expect(page[0]!.y + page[0]!.h).toBeLessThan(287);
    // p. 304: a labelled system ("prior", "likelihood") with one number between its rows.
    expect(zones.get(310)!.map((z) => z.label)).toContain('(9.35)');
  }, 60_000);

  it('keeps the lower limit of the Gamma integral in (6.100)', async () => {
    const zones = (await zonesOf([213])).get(213)!;
    const integral = zones.find((z) => z.label === '(6.100)')!;
    const recurrence = zones.find((z) => z.label === '(6.101)')!;
    // The limit "0" sits at y ≈ 274.7 pt, just above (6.101).
    expect(integral.y + integral.h).toBeGreaterThan(274);
    expect(recurrence.y).toBeGreaterThan(integral.y + integral.h - 3);
  }, 60_000);

  it('finds no formula on a page of prose, nor on the lettering of a plot', async () => {
    const zones = await zonesOf([25, 213]);
    // p. 19: prose and a concept map, no display.
    expect(zones.get(25)).toEqual([]);
    // p. 207: the Beta plot's legend and ticks are not formulas.
    expect(zones.get(213)!.every((z) => z.y < 330)).toBe(true);
  }, 60_000);
});
