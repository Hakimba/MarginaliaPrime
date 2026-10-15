import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const boundary = vi.hoisted(() => ({ getDocument: vi.fn() }));
vi.mock('@pdfjs/pdf.min.mjs', () => {
  Object.assign(globalThis, {
    pdfjsLib: {
      GlobalWorkerOptions: {},
      PDFDataRangeTransport: class {},
      getDocument: boundary.getDocument,
    },
  });
  return {};
});
import { makePDF } from '../../../packages/foliate-js/pdf.js';

const fixture = () => {
  const page = {
    getViewport: () => ({ width: 400, height: 600 }),
    streamTextContent: vi.fn(() => new ReadableStream({
      start(controller) { controller.enqueue({ items: [] }); controller.close(); },
    })),
    render: vi.fn(() => ({ promise: Promise.resolve() })),
    cleanup: vi.fn(),
  };
  const pdf = {
    numPages: 1,
    getPage: vi.fn(async () => page),
    getMetadata: vi.fn(async () => ({ info: { Title: 'Fixture' } })),
    getOutline: vi.fn(async () => null),
    destroy: vi.fn(async () => {}),
  };
  const loadingTask = { promise: Promise.resolve(pdf), destroy: vi.fn(async () => {}) };
  boundary.getDocument.mockReturnValue(loadingTask);
  return { page, pdf, loadingTask };
};

beforeEach(() => boundary.getDocument.mockReset());
afterEach(() => vi.restoreAllMocks());

describe('PDF document lifetime', () => {
  it('owns a separate font document and returns the same destruction promise', async () => {
    const { pdf } = fixture();
    let finish;
    const pending = new Promise(resolve => { finish = resolve; });
    pdf.destroy.mockImplementation(() => pending);
    const book = await makePDF(new Blob(['PDF']));
    const options = boundary.getDocument.mock.calls[0][0];
    expect(options.ownerDocument).toBeInstanceOf(Document);
    expect(options.ownerDocument).not.toBe(document);
    expect(options.ownerDocument.defaultView).toBeNull();
    const destroyed = book.destroy();
    expect(book.destroy()).toBe(destroyed);
    expect(pdf.destroy).toHaveBeenCalledOnce();
    finish();
    await destroyed;
  });

  it('waits for cleanup and preserves an initialization failure', async () => {
    const { pdf, loadingTask } = fixture();
    const cause = new Error('Broken metadata');
    pdf.getMetadata.mockRejectedValue(cause);
    let finish;
    loadingTask.destroy.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
    const opened = makePDF(new Blob(['PDF']));
    const outcome = expect(opened).rejects.toBe(cause);
    await vi.waitFor(() => expect(loadingTask.destroy).toHaveBeenCalledOnce());
    finish();
    await outcome;
  });

  it('reports both initialization and cleanup failures', async () => {
    const { pdf, loadingTask } = fixture();
    const cause = new Error('Broken first page');
    const cleanupError = new Error('Broken cleanup');
    pdf.getPage.mockRejectedValue(cause);
    loadingTask.destroy.mockRejectedValue(cleanupError);
    await expect(makePDF(new Blob(['PDF']))).rejects.toMatchObject({
      name: 'AggregateError', cause, errors: [cause, cleanupError],
    });
  });

  it('rejects new page work after destruction starts', async () => {
    fixture();
    const book = await makePDF(new Blob(['PDF']));
    await book.destroy();
    await expect(book.sections[0].createDocument()).rejects.toThrow('PDF document is destroyed');
    await expect(book.sections[0].load()).rejects.toThrow('PDF document is destroyed');
    await expect(book.getCover()).rejects.toThrow('PDF document is destroyed');
  });

  it('discards text extraction that finishes after destruction', async () => {
    const { page } = fixture();
    let text;
    page.streamTextContent.mockImplementation(() => new ReadableStream({
      start(controller) { text = controller; },
    }));
    const book = await makePDF(new Blob(['PDF']));
    const pending = book.sections[0].createDocument();
    await vi.waitFor(() => expect(page.streamTextContent).toHaveBeenCalledOnce());
    await book.destroy();
    const outcome = expect(pending).rejects.toThrow('PDF document is destroyed');
    text.enqueue({ items: [] });
    text.close();
    await outcome;
  });

  it('discards a cover converted after destruction and releases its bitmap', async () => {
    fixture();
    let finish;
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(function () {
      return { canvas: this };
    });
    const toBlob = vi.spyOn(HTMLCanvasElement.prototype, 'toBlob').mockImplementation(callback => {
      finish = callback;
    });
    const book = await makePDF(new Blob(['PDF']));
    const pending = book.getCover();
    await vi.waitFor(() => expect(toBlob).toHaveBeenCalledOnce());
    await book.destroy();
    const outcome = expect(pending).rejects.toThrow('PDF document is destroyed');
    finish(new Blob(['cover']));
    await outcome;
    expect(toBlob.mock.contexts[0].width).toBe(0);
    expect(toBlob.mock.contexts[0].height).toBe(0);
  });
});
