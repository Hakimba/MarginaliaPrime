/**
 * The index the reader's tools search: the text of every page (or section) of
 * the book and its table of contents with page numbers, built in the webview,
 * which owns the parsers, and stored by the backend as JSON (`book_index.rs`).
 * The tool server (`reader_tools.rs`) reads it.
 *
 * Built once per book, at idle and one page at a time so that reading is never
 * held up, with a checkpoint now and then: a book closed half-way resumes
 * where it stopped.
 */
import type { BookDoc, TOCItem } from '@/libs/document';
import { extractPages, findSectionIndex, resolveTocHref } from './chapterExtraction';

/** Bumped when the format or the extraction changes: older indexes are rebuilt. */
export const INDEX_VERSION = 1;
/** Pages between two checkpoints. */
const CHECKPOINT_EVERY = 20;
/** Characters of a notation section sent with the first message, at most. */
const NOTATION_LIMIT = 8000;
/** Table-of-contents titles of a list of notations. */
const NOTATION_TITLE = /\b(notations?|notational|symbols|list of symbols|symboles|nomenclature)\b/i;

export interface IndexTocEntry {
  label: string;
  /** 1-based page (or section) number, when the entry could be resolved. */
  page: number | null;
  depth: number;
}

export interface BookIndex {
  version: number;
  hash: string;
  title: string;
  /** "page" for a fixed-layout book, "section" for a reflowable one. */
  unit: 'page' | 'section';
  complete: boolean;
  pageCount: number;
  toc: IndexTocEntry[];
  pages: { page: number; label?: string; text: string }[];
  /** The book's own list of notations, when its table of contents has one. */
  notation?: string;
}

export interface IndexStorage {
  load: (hash: string) => Promise<string | null>;
  write: (hash: string, content: string) => Promise<void>;
}

export interface IndexRun {
  /** Called after each page, and once when the index is complete. */
  onProgress?: (done: number, total: number) => void;
  /** Checked between pages: true stops the run, the checkpoint stays. */
  cancelled?: () => boolean;
  /** Waits before each page; the app waits for the browser to be idle. */
  pause?: () => Promise<void>;
}

/** The table of contents, flattened, each entry with its page number. */
export const tocWithPages = async (bookDoc: BookDoc): Promise<IndexTocEntry[]> => {
  const entries: IndexTocEntry[] = [];
  const walk = async (items: TOCItem[] | undefined, depth: number) => {
    for (const item of items ?? []) {
      let page: number | null = null;
      try {
        const { sectionId } = await resolveTocHref(bookDoc, item.href);
        const index = findSectionIndex(bookDoc, sectionId);
        if (index >= 0) page = index + 1;
      } catch {
        // An entry pointing nowhere keeps its title.
      }
      const label = (item.label ?? '').replace(/\s+/g, ' ').trim();
      if (label) entries.push({ label, page, depth });
      await walk(item.subitems, depth + 1);
    }
  };
  await walk(bookDoc.toc ?? undefined, 0);
  return entries;
};

/** The title of the table-of-contents entry a page falls under. */
const sectionTitleAt = (toc: IndexTocEntry[], page: number): string | undefined => {
  let title: string | undefined;
  for (const entry of toc) {
    if (entry.page !== null && entry.page <= page) title = entry.label;
  }
  return title;
};

/** The text of the book's list of notations, if its table of contents has one. */
export const findNotation = (index: BookIndex): string | undefined => {
  const at = index.toc.findIndex((e) => e.page !== null && NOTATION_TITLE.test(e.label));
  if (at < 0) return undefined;
  const first = index.toc[at]!.page!;
  const next = index.toc.slice(at + 1).find((e) => e.page !== null && e.page > first)?.page;
  // A list of notations spans a few pages; a wrong match must not bring a chapter.
  const last = Math.min(next ? next - 1 : first, first + 3);
  const text = index.pages
    .filter((p) => p.page >= first && p.page <= last)
    .map((p) => (index.unit === 'page' ? `[p. ${p.page}]\n${p.text}` : p.text))
    .join('\n\n')
    .trim();
  return text ? text.slice(0, NOTATION_LIMIT) : undefined;
};

const parse = (raw: string | null, hash: string): BookIndex | null => {
  if (!raw) return null;
  try {
    const index = JSON.parse(raw) as BookIndex;
    return index.version === INDEX_VERSION && index.hash === hash ? index : null;
  } catch {
    return null;
  }
};

/**
 * Make sure the book has a complete index: nothing to do when it has, resume
 * a partial one, build it otherwise. Resolves to the index as it stands when
 * the run ends (complete unless cancelled).
 */
export const ensureBookIndex = async (
  bookDoc: BookDoc,
  book: { hash: string; title: string; fixedLayout: boolean },
  storage: IndexStorage,
  run: IndexRun = {},
): Promise<BookIndex | null> => {
  const total = bookDoc.sections?.length ?? 0;
  if (!total) return null;
  const stored = parse(await storage.load(book.hash), book.hash);
  if (stored?.complete) {
    run.onProgress?.(stored.pages.length ? total : 0, total);
    return stored;
  }

  const index: BookIndex = stored ?? {
    version: INDEX_VERSION,
    hash: book.hash,
    title: book.title,
    unit: book.fixedLayout ? 'page' : 'section',
    complete: false,
    pageCount: total,
    toc: await tocWithPages(bookDoc),
    pages: [],
  };
  // Resume after the last page stored: pages are added in order.
  const start = index.pages.length ? index.pages[index.pages.length - 1]!.page : 0;
  // Written at once, then every few pages: a question asked while the book is
  // being indexed searches what is done, and hears that the rest is coming.
  if (!stored) await storage.write(book.hash, JSON.stringify(index));
  let sinceCheckpoint = 0;
  for (let i = start; i < total; i += 1) {
    if (run.cancelled?.()) return index;
    await run.pause?.();
    if (run.cancelled?.()) return index;
    const [page] = await extractPages(bookDoc, i, i);
    if (page) {
      const label = index.unit === 'section' ? sectionTitleAt(index.toc, i + 1) : undefined;
      index.pages.push({ ...page, ...(label ? { label } : {}) });
    }
    run.onProgress?.(i + 1, total);
    sinceCheckpoint += 1;
    if (sinceCheckpoint >= CHECKPOINT_EVERY) {
      sinceCheckpoint = 0;
      await storage.write(book.hash, JSON.stringify(index));
    }
  }
  index.complete = true;
  const notation = findNotation(index);
  if (notation) index.notation = notation;
  await storage.write(book.hash, JSON.stringify(index));
  run.onProgress?.(total, total);
  return index;
};
