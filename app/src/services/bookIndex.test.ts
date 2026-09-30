import { describe, expect, it } from 'vitest';

import type { BookDoc } from '@/libs/document';
import { ensureBookIndex, findNotation, INDEX_VERSION, type BookIndex } from './bookIndex';

/** A fixed-layout book whose page n reads `texts[n - 1]`, with a TOC. */
const makeBook = (texts: string[], toc: { label: string; page: number; sub?: { label: string; page: number }[] }[]) => {
  const loads: number[] = [];
  const item = (e: { label: string; page: number }, id: number) => ({
    id,
    label: e.label,
    href: String(e.page - 1),
    index: e.page - 1,
  });
  const bookDoc = {
    sections: texts.map((text, i) => ({
      id: i,
      createDocument: async () => {
        loads.push(i);
        return new DOMParser().parseFromString(`<body><p>${text}</p></body>`, 'text/html');
      },
    })),
    toc: toc.map((e, i) => ({ ...item(e, i), subitems: e.sub?.map((s, j) => item(s, 100 + j)) })),
    splitTOCHref: (href: string) => [Number(href), null],
  } as unknown as BookDoc;
  return { bookDoc, loads };
};

const memory = () => {
  const files = new Map<string, string>();
  const writes: BookIndex[] = [];
  return {
    files,
    writes,
    storage: {
      load: async (hash: string) => files.get(hash) ?? null,
      write: async (hash: string, content: string) => {
        files.set(hash, content);
        writes.push(JSON.parse(content) as BookIndex);
      },
    },
  };
};

const book = { hash: 'abc', title: 'Test', fixedLayout: true };

describe('ensureBookIndex', () => {
  it('indexes every page with its number, and the TOC with pages and depth', async () => {
    const { bookDoc } = makeBook(['Intro', 'Tensors ⊗', 'More'], [
      { label: '1 Intro', page: 1, sub: [{ label: '1.1 Tensors', page: 2 }] },
    ]);
    const { storage, files } = memory();
    const index = await ensureBookIndex(bookDoc, book, storage);
    expect(index?.complete).toBe(true);
    expect(index?.pages.map((p) => [p.page, p.text])).toEqual([
      [1, 'Intro'],
      [2, 'Tensors ⊗'],
      [3, 'More'],
    ]);
    expect(index?.toc).toEqual([
      { label: '1 Intro', page: 1, depth: 0 },
      { label: '1.1 Tensors', page: 2, depth: 1 },
    ]);
    const stored = JSON.parse(files.get('abc')!) as BookIndex;
    expect(stored.version).toBe(INDEX_VERSION);
    expect(stored.unit).toBe('page');
    expect(stored.pageCount).toBe(3);
  });

  it('does nothing for a book already indexed', async () => {
    const { bookDoc, loads } = makeBook(['a', 'b'], []);
    const { storage } = memory();
    await ensureBookIndex(bookDoc, book, storage);
    loads.length = 0;
    await ensureBookIndex(bookDoc, book, storage);
    expect(loads).toEqual([]);
  });

  it('resumes after the last checkpoint instead of starting over', async () => {
    const texts = Array.from({ length: 90 }, (_, i) => `page ${i + 1}`);
    const { bookDoc, loads } = makeBook(texts, []);
    const { storage, writes } = memory();
    let pagesSeen = 0;
    // Closed after 50 pages: the checkpoint at 40 is on disk.
    const first = await ensureBookIndex(bookDoc, book, storage, {
      onProgress: (done) => (pagesSeen = done),
      cancelled: () => pagesSeen >= 50,
    });
    expect(first?.complete).toBe(false);
    // An empty index first, for the tools to say the book is being indexed.
    expect(writes[0]?.pages.length).toBe(0);
    expect(writes.at(-1)?.pages.length).toBe(40);
    expect(writes.at(-1)?.complete).toBe(false);

    loads.length = 0;
    const second = await ensureBookIndex(bookDoc, book, storage);
    expect(loads[0]).toBe(40);
    expect(second?.complete).toBe(true);
    expect(second?.pages.map((p) => p.page)).toEqual(texts.map((_, i) => i + 1));
  });

  it('rebuilds an index of another version or another book', async () => {
    const { bookDoc, loads } = makeBook(['a'], []);
    const { storage, files } = memory();
    files.set('abc', JSON.stringify({ version: INDEX_VERSION - 1, hash: 'abc', complete: true, pages: [] }));
    await ensureBookIndex(bookDoc, book, storage);
    expect(loads).toEqual([0]);
  });

  it('labels the sections of a reflowable book with their chapter', async () => {
    const { bookDoc } = makeBook(['a', 'b', 'c'], [
      { label: 'Chapter 1', page: 1 },
      { label: 'Chapter 2', page: 3 },
    ]);
    const { storage } = memory();
    const index = await ensureBookIndex(bookDoc, { ...book, fixedLayout: false }, storage);
    expect(index?.unit).toBe('section');
    expect(index?.pages.map((p) => p.label)).toEqual(['Chapter 1', 'Chapter 1', 'Chapter 2']);
  });
});

describe('findNotation', () => {
  const index = (toc: { label: string; page: number }[], pages = 12): BookIndex => ({
    version: INDEX_VERSION,
    hash: 'h',
    title: 't',
    unit: 'page',
    complete: true,
    pageCount: pages,
    toc: toc.map((e) => ({ ...e, depth: 0 })),
    pages: Array.from({ length: pages }, (_, i) => ({ page: i + 1, text: `texte ${i + 1}` })),
  });

  it('takes the pages of a list of notations, up to the next entry', () => {
    const notation = findNotation(
      index([
        { label: 'Contents', page: 1 },
        { label: 'List of Symbols', page: 3 },
        { label: '1 Introduction', page: 5 },
      ]),
    );
    expect(notation).toBe('[p. 3]\ntexte 3\n\n[p. 4]\ntexte 4');
  });

  it('never takes more than four pages, and nothing without such an entry', () => {
    const long = findNotation(index([{ label: 'Notation', page: 2 }, { label: 'Index', page: 12 }]));
    expect(long?.match(/\[p\. /g)).toHaveLength(4);
    expect(findNotation(index([{ label: '1 Introduction', page: 1 }]))).toBeUndefined();
    // TAPL's appendix.
    expect(findNotation(index([{ label: 'B -- Notational Conventions', page: 5 }]))).toContain('[p. 5]');
  });
});
