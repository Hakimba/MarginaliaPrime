import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';

/**
 * Opens a real PDF through the reading engine and checks the text a page hands
 * to the chat. Skipped unless MARGINALIA_TEST_PDF points at a file: a book
 * cannot be committed here, and this is the only test that catches a page
 * yielding no text at all.
 */
const file = process.env['MARGINALIA_TEST_PDF'] ?? '';
const available = !!file && existsSync(file);

describe.skipIf(!available)('a page of a real PDF', () => {
  it('yields its text in reading order, notes apart', async () => {
    const { makePDF } = await import('../../../packages/foliate-js/pdf.js');
    // Outside a browser the worker and the font data are not served over HTTP.
    const pdfjs = (globalThis as unknown as { pdfjsLib: { GlobalWorkerOptions: { workerSrc: string } } })
      .pdfjsLib;
    const { pathToFileURL } = await import('node:url');
    const { resolve } = await import('node:path');
    pdfjs.GlobalWorkerOptions.workerSrc = pathToFileURL(
      resolve(process.cwd(), 'public/vendor/pdfjs/pdf.worker.min.mjs'),
    ).href;
    const { domToStructuredText } = await import('./chapterExtraction');
    const bytes = readFileSync(file);
    const blob = new Blob([bytes], { type: 'application/pdf' });
    const book = (await makePDF(blob)) as unknown as {
      sections: { createDocument: () => Promise<Document> }[];
    };
    const doc = await book.sections[29]!.createDocument();
    const text = domToStructuredText(doc.body);

    expect(text.length).toBeGreaterThan(500);
    // The body comes first, several lines of it, then the marginal notes.
    const [body = '', notes = ''] = text.split('[note de marge]');
    expect(body.split('\n').filter(Boolean).length).toBeGreaterThan(10);
    expect(notes.length).toBeGreaterThan(0);
  }, 60_000);
});
