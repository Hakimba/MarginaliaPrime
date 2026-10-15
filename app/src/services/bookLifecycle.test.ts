import { afterEach, describe, expect, it, vi } from 'vitest';
import { BookDoc, DocumentLoader } from '@/libs/document';
import { Book } from '@/types/book';
import { FileSystem } from '@/types/system';
import { BookData, useBookDataStore } from '@/store/bookDataStore';
import { partialMD5 } from '@/utils/md5';
import { TxtToEpubConverter } from '@/utils/txt';
import { fetchBookDetails, importBook, refreshBookMetadata } from './bookService';

vi.mock('@/utils/md5', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/utils/md5')>(),
  partialMD5: vi.fn(async () => 'bookhash'),
}));

function makeDoc(): BookDoc {
  return {
    metadata: { title: 'Book', author: 'Author', language: 'en' },
    rendition: {}, dir: 'ltr', sections: [], splitTOCHref: () => [],
    getCover: vi.fn(async () => null), destroy: vi.fn(async () => {}),
  };
}
function makeBook(): Book {
  return { hash: 'bookhash', format: 'PDF', title: 'Book', author: 'Author', createdAt: 1, updatedAt: 1 };
}
function makeFs(file: File): FileSystem {
  return {
    resolvePath: () => { throw new Error('Unexpected resolvePath'); },
    getURL: () => 'cover.png', getBlobURL: async () => 'blob:cover', getImageURL: async () => 'cover.png',
    openFile: vi.fn(async () => file), copyFile: vi.fn(async () => {}), readFile: async () => '',
    writeFile: vi.fn(async () => {}), removeFile: vi.fn(async () => {}), readDir: async () => [],
    createDir: vi.fn(async () => {}), removeDir: vi.fn(async () => {}), exists: vi.fn(async () => true),
    stats: () => { throw new Error('Unexpected stats'); }, getPrefix: async () => '',
  };
}
function setup() {
  const events: string[] = [];
  const file = Object.assign(new File(['%PDF-'], 'book.pdf'), {
    close: vi.fn(async () => { events.push('close'); }),
  });
  const doc = makeDoc();
  doc.destroy = vi.fn(async () => { events.push('destroy'); });
  const open = vi.spyOn(DocumentLoader.prototype, 'open').mockResolvedValue({ book: doc, format: 'PDF' });
  return { file, doc, open, events, fs: makeFs(file), book: makeBook() };
}
const consumers = [
  { name: 'details', run: (fs: FileSystem, book: Book) => fetchBookDetails(fs, book) },
  { name: 'refresh', run: (fs: FileSystem, book: Book) => refreshBookMetadata(fs, book) },
  { name: 'import', run: (fs: FileSystem, book: Book) => importBook(fs, '/book.pdf', [book], false, true, true, false,
    async () => {}, async () => 'cover.png') },
];
afterEach(() => {
  vi.restoreAllMocks();
  vi.mocked(partialMD5).mockReset().mockResolvedValue('bookhash');
  useBookDataStore.setState({ booksData: {} });
});

describe.each(consumers)('temporary document used by $name', ({ name, run }) => {
  it('waits for destruction before closing the acquired file', async () => {
    const { fs, book, doc, file, events } = setup();
    let finishDestroy = () => {};
    const pendingDestroy = new Promise<void>((resolve) => { finishDestroy = resolve; });
    doc.destroy = vi.fn(() => { events.push('destroy'); return pendingDestroy; });
    const result = run(fs, book);
    await vi.waitFor(() => expect(doc.destroy).toHaveBeenCalledOnce());
    expect(file.close).not.toHaveBeenCalled();
    finishDestroy();
    await result;
    expect(events).toEqual(['destroy', 'close']);
  });
  it('closes its file if opening the document fails', async () => {
    const { fs, book, open, file } = setup();
    const failure = new Error('open failed');
    open.mockRejectedValue(failure);
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const rejection = expect(run(fs, book)).rejects;
    if (name === 'import') await rejection.toMatchObject({ cause: failure });
    else await rejection.toBe(failure);
    expect(file.close).toHaveBeenCalledOnce();
  });
  it('reports destruction failure and still closes its file', async () => {
    const { fs, book, doc, file } = setup();
    const failure = new Error('destroy failed');
    doc.destroy = vi.fn(async () => { throw failure; });
    await expect(run(fs, book)).rejects.toBe(failure);
    expect(file.close).toHaveBeenCalledOnce();
  });
  it('supports formats without a destroy method', async () => {
    const { fs, book, doc, file } = setup();
    delete doc.destroy;
    await run(fs, book);
    expect(file.close).toHaveBeenCalledOnce();
  });
  it('preserves processing, destruction and file-close errors together', async () => {
    const { fs, book, doc, file } = setup();
    const processing = new Error('metadata or cover failed');
    const destroying = new Error('destroy failed');
    const closing = new Error('close failed');
    if (name === 'import') vi.mocked(doc.getCover).mockRejectedValue(processing);
    else Object.defineProperty(doc, 'metadata', { get() { throw processing; } });
    doc.destroy = vi.fn(async () => { throw destroying; });
    file.close.mockRejectedValue(closing);
    vi.spyOn(console, 'error').mockImplementation(() => {});
    await expect(run(fs, book)).rejects.toMatchObject({ cause: processing, errors: [processing, destroying, closing] });
    expect(file.close).toHaveBeenCalledOnce();
  });
});
it('releases a successfully opened import when hashing fails', async () => {
  const { fs, book, doc, events } = setup();
  const failure = new Error('read failed');
  vi.mocked(partialMD5).mockRejectedValueOnce(failure);
  vi.spyOn(console, 'error').mockImplementation(() => {});
  await expect(importBook(fs, '/book.pdf', [book], false, false, false, false,
    async () => {}, async () => 'cover.png')).rejects.toBe(failure);
  expect(doc.destroy).toHaveBeenCalledOnce();
  expect(events).toEqual(['destroy', 'close']);
});
it('closes the original TXT file when conversion fails', async () => {
  const { file, book, open } = setup();
  const source = Object.assign(new File(['text'], 'book.txt'), { close: file.close });
  const failure = new Error('conversion failed');
  vi.spyOn(TxtToEpubConverter.prototype, 'convert').mockRejectedValue(failure);
  vi.spyOn(console, 'error').mockImplementation(() => {});
  await expect(importBook(makeFs(source), '/book.txt', [book], false, false, false, false,
    async () => {}, async () => 'cover.png')).rejects.toMatchObject({ cause: failure });
  expect(open).not.toHaveBeenCalled();
  expect(source.close).toHaveBeenCalledOnce();
});
it('destroys a converted TXT document before closing both acquired files', async () => {
  const { file, book, events } = setup();
  const source = Object.assign(new File(['text'], 'book.txt'), {
    close: vi.fn(async () => { events.push('close source'); }),
  });
  vi.spyOn(TxtToEpubConverter.prototype, 'convert').mockResolvedValue({
    file, bookTitle: 'Book', chapterCount: 1, language: 'en',
  });
  await importBook(makeFs(source), '/book.txt', [book], false, false, false, false,
    async () => {}, async () => 'cover.png');
  expect(events).toEqual(['destroy', 'close source', 'close']);
});
function data(id: string, bookDoc: BookDoc): BookData {
  return { id, book: null, file: null, config: null, bookDoc, isFixedLayout: true };
}
describe('cached document eviction', () => {
  it('closes the acquired file even when document teardown fails', async () => {
    const doc = makeDoc();
    const failure = new Error('worker teardown failed');
    doc.destroy = vi.fn(async () => { throw failure; });
    const file = Object.assign(new File(['book'], 'book.pdf'), { close: vi.fn(async () => {}) });
    useBookDataStore.setState({ booksData: { bookhash: { ...data('bookhash', doc), file } } });
    await expect(useBookDataStore.getState().clearBookData('bookhash')).rejects.toBe(failure);
    expect(file.close).toHaveBeenCalledOnce();
  });
  it('preserves both teardown and file-close failures', async () => {
    const doc = makeDoc();
    const teardown = new Error('worker teardown failed');
    const close = new Error('file close failed');
    doc.destroy = vi.fn(async () => { throw teardown; });
    const file = Object.assign(new File(['book'], 'book.pdf'), {
      close: vi.fn(async () => { throw close; }),
    });
    useBookDataStore.setState({ booksData: { bookhash: { ...data('bookhash', doc), file } } });
    await expect(useBookDataStore.getState().clearBookData('bookhash')).rejects.toMatchObject({
      name: 'AggregateError', errors: [teardown, close], cause: teardown,
    });
  });
  it('retains a shared backing file until its last owner is removed', async () => {
    const first = makeDoc();
    const second = makeDoc();
    const events: string[] = [];
    first.destroy = vi.fn(async () => { events.push('first'); });
    second.destroy = vi.fn(async () => { events.push('second'); });
    const file = Object.assign(new File(['book'], 'book.pdf'), {
      close: vi.fn(async () => { events.push('close'); }),
    });
    useBookDataStore.setState({ booksData: {
      first: { ...data('first', first), file }, second: { ...data('second', second), file },
    } });
    await useBookDataStore.getState().clearBookData('first');
    expect(events).toEqual(['first']);
    await useBookDataStore.getState().clearBookData('second');
    expect(events).toEqual(['first', 'second', 'close']);
  });
  it('destroys exactly the removed document for a view key and waits for completion', async () => {
    const removed = makeDoc();
    const retained = makeDoc();
    let finishDestroy = () => {};
    removed.destroy = vi.fn(() => new Promise<void>((resolve) => { finishDestroy = resolve; }));
    useBookDataStore.setState({ booksData: {
      bookhash: data('bookhash', removed), otherhash: data('otherhash', retained),
    } });
    const clearing = useBookDataStore.getState().clearBookData('bookhash-view1');
    expect(useBookDataStore.getState().getBookData('bookhash')).toBeNull();
    expect(useBookDataStore.getState().getBookData('otherhash')?.bookDoc).toBe(retained);
    expect(removed.destroy).toHaveBeenCalledOnce();
    expect(retained.destroy).not.toHaveBeenCalled();
    let finished = false;
    void clearing.then(() => { finished = true; });
    await Promise.resolve();
    expect(finished).toBe(false);
    await useBookDataStore.getState().clearBookData('bookhash-view2');
    expect(removed.destroy).toHaveBeenCalledOnce();
    finishDestroy();
    await clearing;
    expect(finished).toBe(true);
  });
  it('keeps a document alive while another cache entry still owns it', async () => {
    const shared = makeDoc();
    useBookDataStore.setState({ booksData: { first: data('first', shared), second: data('second', shared) } });
    await useBookDataStore.getState().clearBookData('first-view');
    expect(shared.destroy).not.toHaveBeenCalled();
    await useBookDataStore.getState().clearBookData('second');
    expect(shared.destroy).toHaveBeenCalledOnce();
  });
  it('leaves an entry inserted during destruction alive', async () => {
    const oldDoc = makeDoc();
    const newDoc = makeDoc();
    let finishDestroy = () => {};
    oldDoc.destroy = vi.fn(() => new Promise<void>((resolve) => { finishDestroy = resolve; }));
    useBookDataStore.setState({ booksData: { bookhash: data('bookhash', oldDoc) } });
    const clearing = useBookDataStore.getState().clearBookData('bookhash');
    useBookDataStore.setState({ booksData: { bookhash: data('bookhash', newDoc) } });
    finishDestroy();
    await clearing;
    expect(useBookDataStore.getState().getBookData('bookhash')?.bookDoc).toBe(newDoc);
    expect(newDoc.destroy).not.toHaveBeenCalled();
  });
  it('propagates destruction failure after removing the entry', async () => {
    const doc = makeDoc();
    const failure = new Error('worker teardown failed');
    doc.destroy = vi.fn(async () => { throw failure; });
    useBookDataStore.setState({ booksData: { bookhash: data('bookhash', doc) } });
    await expect(useBookDataStore.getState().clearBookData('bookhash')).rejects.toBe(failure);
    expect(useBookDataStore.getState().getBookData('bookhash')).toBeNull();
  });
});
