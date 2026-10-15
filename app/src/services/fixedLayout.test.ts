import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FixedLayout } from '../../../packages/foliate-js/fixed-layout.js';

// Exercise the real renderer; jsdom supplies documents but no geometry or iframe loads.
const resizeCallbacks = new Map<Element, () => void>();
vi.stubGlobal('ResizeObserver', class {
  constructor(private callback: () => void) {}
  observe(element: Element) { resizeCallbacks.set(element, this.callback); }
  unobserve(element: Element) { resizeCallbacks.delete(element); }
});
const intersectionCallbacks = new Map<Element, (entries: { target: Element; isIntersecting: boolean }[]) => void>();
vi.stubGlobal('IntersectionObserver', class {
  constructor(private callback: (entries: { target: Element; isIntersecting: boolean }[]) => void) {}
  observe(element: Element) { intersectionCallbacks.set(element, this.callback); }
  disconnect() { intersectionCallbacks.clear(); }
});
HTMLElement.prototype.scrollIntoView = vi.fn();

const renderers: FixedLayout[] = [];
const makeReader = (dir = 'ltr', spread = 'none') => {
  const reader = new FixedLayout();
  document.body.append(reader);
  renderers.push(reader);
  reader.getBoundingClientRect = () => ({ width: 600, height: 900 }) as DOMRect;
  const book = {
    dir,
    rendition: { spread, viewport: { width: 400, height: 600 } },
    sections: Array.from({ length: 8 }, (_, index) => ({
      load: vi.fn(async () => ({ src: 'about:blank', data: `<p>Page ${index}</p>` })),
    })),
  };
  reader.open(book);
  return { reader, book };
};

// Drive only browser loading, never replace the renderer's pagination methods.
const settle = async () => {
  for (let i = 0; i < 20; i++) {
    await Promise.resolve();
    for (const reader of renderers) {
      for (const frame of reader.shadowRoot!.querySelectorAll('iframe')) {
        if (frame.dataset.sectionIndex === undefined) {
          if (!frame.contentDocument) {
            Object.defineProperty(frame, 'contentDocument', {
              value: new DOMParser().parseFromString(frame.srcdoc, 'text/html'),
            });
          }
          frame.dispatchEvent(new Event('load'));
        }
      }
    }
  }
};

beforeEach(() => {
  CSSStyleSheet.prototype.replaceSync ??= () => {};
});
afterEach(async () => {
  for (const reader of renderers) { reader.destroy(); reader.remove(); }
  renderers.length = 0;
  await Promise.resolve();
});

describe('fixed-layout page modes', () => {
  it.each(['PDF', 'EPUB'])('forwards wheel once after an initially zero-width %s page recovers', async (format) => {
    const { reader, book } = makeReader();
    const scrollBy = vi.fn();
    reader.scrollBy = scrollBy;
    if (format === 'PDF') {
      book.sections[5]!.load.mockImplementationOnce(async () => ({
        src: 'about:blank', data: '<p>PDF</p>',
        onZoom: async () => ({ kind: 'ready' }),
      }));
    }
    reader.setAttribute('flow', 'scrolled');
    reader.getBoundingClientRect = () => new DOMRect(0, 0, 0, 900);
    const page = reader.shadowRoot!.querySelector<HTMLElement>('.scroll-page[data-index="5"]')!;
    intersectionCallbacks.get(page)!([{ target: page, isIntersecting: true }]);
    await settle();
    reader.getBoundingClientRect = () => new DOMRect(0, 0, 600, 900);
    resizeCallbacks.get(reader)!();
    await settle();
    resizeCallbacks.get(reader)!();
    await settle();
    const frame = page.querySelector('iframe')!;
    expect(frame.style.width).toBe(format === 'PDF' ? '600px' : '400px');
    frame.contentDocument!.dispatchEvent(new WheelEvent('wheel', { deltaY: 100 }));
    expect(scrollBy).toHaveBeenCalledExactlyOnceWith({ top: 100, left: 0, behavior: 'instant' });
  });

  it('loads an intersecting scrolled page with performance tracing enabled', async () => {
    const mark = vi.fn();
    vi.stubGlobal('__perfMark', mark);
    try {
      const { reader } = makeReader();
      const loaded: number[] = [];
      reader.addEventListener('load', (event: Event) => {
        if (event instanceof CustomEvent) loaded.push(event.detail.index);
      });
      reader.setAttribute('flow', 'scrolled');
      const page = reader.shadowRoot!.querySelector<HTMLElement>('.scroll-page[data-index="5"]')!;
      intersectionCallbacks.get(page)!([{ target: page, isIntersecting: true }]);
      await settle();
      expect(loaded).toEqual([5]);
      expect(mark).toHaveBeenCalledWith('pdf:frame-load', { index: 5 });
      expect(page.querySelector('iframe')?.dataset.sectionIndex).toBe('5');
    } finally {
      vi.stubGlobal('__perfMark', undefined);
    }
  });

  it('creates a scrolled PDF overlayer only after its layers are ready', async () => {
    const { reader, book } = makeReader();
    let finishRender = () => {};
    const pending = new Promise<{ kind: 'ready' }>(resolve => {
      finishRender = () => resolve({ kind: 'ready' });
    });
    const frameSizes: string[] = [];
    const onZoom = vi.fn(({ doc }: { doc: Document }) => {
      const frame = Array.from(reader.shadowRoot!.querySelectorAll('iframe'))
        .find(iframe => iframe.contentDocument === doc);
      frameSizes.push(`${frame?.style.width} × ${frame?.style.height}`);
      return pending;
    });
    book.sections[5]!.load.mockImplementationOnce(async () => ({
      src: 'about:blank', data: '<p>PDF</p>', onZoom,
    }));
    const overlays: number[] = [];
    reader.addEventListener('create-overlayer', event => {
      if (!(event instanceof CustomEvent)) throw new Error('Expected overlayer detail');
      overlays.push(event.detail.index);
    });
    reader.setAttribute('flow', 'scrolled');
    const page = reader.shadowRoot!.querySelector<HTMLElement>('.scroll-page[data-index="5"]')!;
    intersectionCallbacks.get(page)!([{ target: page, isIntersecting: true }]);
    await settle();
    expect(onZoom).toHaveBeenCalledTimes(1);
    expect(overlays).toEqual([]);
    expect(frameSizes).toEqual(['600px × 900px']);
    finishRender();
    await settle();
    expect(overlays).toEqual([5]);
  });

  it('waits for the latest scrolled render before creating or redrawing its overlayer', async () => {
    const { reader, book } = makeReader();
    const finishes: Array<(outcome: { kind: 'ready' | 'cancelled' }) => void> = [];
    const onZoom = vi.fn(() => new Promise<{ kind: 'ready' | 'cancelled' }>(resolve => {
      finishes.push(resolve);
    }));
    book.sections[5]!.load.mockImplementationOnce(async () => ({
      src: 'about:blank', data: '<p>PDF</p>', onZoom,
    }));
    const redraw = vi.fn();
    const overlays: number[] = [];
    reader.addEventListener('create-overlayer', event => {
      if (!(event instanceof CustomEvent)) throw new Error('Expected overlayer detail');
      overlays.push(event.detail.index);
      event.detail.attach({ element: document.createElement('div'), redraw });
    });
    reader.setAttribute('flow', 'scrolled');
    const page = reader.shadowRoot!.querySelector<HTMLElement>('.scroll-page[data-index="5"]')!;
    intersectionCallbacks.get(page)!([{ target: page, isIntersecting: true }]);
    await settle();
    reader.getBoundingClientRect = () => new DOMRect(0, 0, 800, 900);
    resizeCallbacks.get(reader)!();
    expect(onZoom).toHaveBeenCalledTimes(2);
    finishes[0]!({ kind: 'cancelled' });
    await settle();
    expect(overlays).toEqual([]);
    finishes[1]!({ kind: 'ready' });
    await settle();
    expect(overlays).toEqual([5]);
    reader.getBoundingClientRect = () => new DOMRect(0, 0, 900, 900);
    resizeCallbacks.get(reader)!();
    expect(redraw).not.toHaveBeenCalled();
    finishes[2]!({ kind: 'ready' });
    await settle();
    expect(redraw).toHaveBeenCalledTimes(1);
  });

  it('cleans a failed scrolled render and retries only on a later intersection', async () => {
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const { reader, book } = makeReader();
      let failRender = (_error: Error) => {};
      const pending = new Promise<never>((_, reject) => { failRender = reject; });
      const onZoom = vi.fn().mockImplementationOnce(() => pending)
        .mockResolvedValue({ kind: 'ready' });
      book.sections[5]!.load.mockImplementation(async () => ({
        src: 'about:blank', data: '<p>PDF</p>', onZoom,
      }));
      const overlayer = vi.fn();
      reader.addEventListener('create-overlayer', overlayer);
      reader.setAttribute('flow', 'scrolled');
      const page = reader.shadowRoot!.querySelector<HTMLElement>('.scroll-page[data-index="5"]')!;
      intersectionCallbacks.get(page)!([{ target: page, isIntersecting: true }]);
      await settle();
      failRender(new Error('PDF layers failed'));
      await settle();
      expect(overlayer).not.toHaveBeenCalled();
      expect(page.querySelector('iframe')).toBeNull();
      expect(warning).toHaveBeenCalledWith('Failed to render scroll page', 5, expect.any(Error));
      intersectionCallbacks.get(page)!([{ target: page, isIntersecting: true }]);
      await settle();
      expect(onZoom).toHaveBeenCalledTimes(2);
      expect(overlayer).toHaveBeenCalledTimes(1);
    } finally {
      warning.mockRestore();
    }
  });

  it.each(['mode switch', 'destroy', 'detach'])('discards a scrolled render after %s', async (exit) => {
    const { reader, book } = makeReader();
    let finishRender = () => {};
    const pending = new Promise<{ kind: 'ready' }>(resolve => {
      finishRender = () => resolve({ kind: 'ready' });
    });
    book.sections[5]!.load.mockImplementationOnce(async () => ({
      src: 'about:blank', data: '<p>PDF</p>', onZoom: () => pending,
    }));
    const overlays: number[] = [];
    reader.addEventListener('create-overlayer', event => {
      if (!(event instanceof CustomEvent)) throw new Error('Expected overlayer detail');
      overlays.push(event.detail.index);
    });
    reader.setAttribute('flow', 'scrolled');
    const page = reader.shadowRoot!.querySelector<HTMLElement>('.scroll-page[data-index="5"]')!;
    intersectionCallbacks.get(page)!([{ target: page, isIntersecting: true }]);
    await settle();
    if (exit === 'mode switch') reader.setAttribute('flow', 'paginated');
    else if (exit === 'destroy') reader.destroy();
    else reader.remove();
    finishRender();
    await settle();
    expect(overlays).not.toContain(5);
  });

  it('creates an overlayer for a scrolled EPUB frame without onZoom', async () => {
    const { reader } = makeReader();
    const overlays: number[] = [];
    reader.addEventListener('create-overlayer', event => {
      if (!(event instanceof CustomEvent)) throw new Error('Expected overlayer detail');
      overlays.push(event.detail.index);
    });
    reader.setAttribute('flow', 'scrolled');
    const page = reader.shadowRoot!.querySelector<HTMLElement>('.scroll-page[data-index="5"]')!;
    intersectionCallbacks.get(page)!([{ target: page, isIntersecting: true }]);
    await settle();
    expect(overlays).toEqual([5]);
  });

  it('sizes PDF frames before rendering and waits for the layers before creating overlayers', async () => {
    const { reader, book } = makeReader();
    let finishRender = () => {};
    const pending = new Promise<{ kind: 'ready' }>(resolve => {
      finishRender = () => resolve({ kind: 'ready' });
    });
    const onZoom = vi.fn(({ doc }: { doc: Document }) => {
      const iframe = Array.from(reader.shadowRoot!.querySelectorAll('iframe'))
        .find(frame => frame.contentDocument === doc);
      expect(iframe?.style.display).toBe('block');
      expect(iframe?.style.width).toBe('600px');
      expect(iframe?.style.height).toBe('900px');
      return pending;
    });
    book.sections[0]!.load.mockImplementationOnce(async () => ({
      src: 'about:blank', data: '<p>PDF</p>', onZoom,
    }));
    const overlayer = vi.fn();
    reader.addEventListener('create-overlayer', overlayer);
    const navigation = reader.goTo({ index: 0 });
    await settle();
    expect(onZoom).toHaveBeenCalledTimes(1);
    expect(overlayer).not.toHaveBeenCalled();
    finishRender();
    await navigation;
    expect(overlayer).toHaveBeenCalledTimes(1);
  });

  it.each(['target', 'next', 'prev'])('waits for the revealed portrait half and creates its overlayer through %s', async (action) => {
    const { reader, book } = makeReader('ltr', 'auto');
    const initialIndex = action === 'prev' ? 2 : 1;
    const targetIndex = action === 'prev' ? 1 : 2;
    let finishRender = () => {};
    const pending = new Promise<{ kind: 'ready' }>(resolve => {
      finishRender = () => resolve({ kind: 'ready' });
    });
    const onZoom = vi.fn(() => pending);
    book.sections[targetIndex]!.load.mockImplementationOnce(async () => ({
      src: 'about:blank', data: '<p>Hidden PDF half</p>', onZoom,
    }));
    const overlays: number[] = [];
    reader.addEventListener('create-overlayer', event => {
      if (!(event instanceof CustomEvent)) throw new Error('Expected overlayer detail');
      overlays.push(event.detail.index);
      event.detail.attach({ element: document.createElement('div'), redraw: vi.fn() });
    });
    const initial = reader.goTo({ index: initialIndex });
    await settle();
    await initial;
    expect(onZoom).not.toHaveBeenCalled();
    expect(overlays).toEqual([initialIndex]);
    let finished = false;
    const navigation = (action === 'target' ? reader.goTo({ index: targetIndex })
      : action === 'next' ? reader.next() : reader.prev()).then(() => { finished = true; });
    await settle();
    expect(onZoom).toHaveBeenCalledTimes(1);
    expect(finished).toBe(false);
    expect(overlays).toEqual([initialIndex]);
    finishRender();
    await navigation;
    expect(overlays).toEqual([initialIndex, targetIndex]);
    expect(reader.index).toBe(targetIndex);
  });

  it.each(['zoom', 'resize'])('waits for replacement layout during the first PDF render after %s', async (change) => {
    const { reader, book } = makeReader();
    let cancelFirst = () => {};
    let finishLatest = () => {};
    const first = new Promise<{ kind: 'cancelled' }>(resolve => {
      cancelFirst = () => resolve({ kind: 'cancelled' });
    });
    const latest = new Promise<{ kind: 'ready' }>(resolve => {
      finishLatest = () => resolve({ kind: 'ready' });
    });
    const onZoom = vi.fn().mockImplementationOnce(() => first).mockImplementationOnce(() => latest);
    book.sections[0]!.load.mockImplementationOnce(async () => ({ src: 'about:blank', data: '<p>PDF</p>', onZoom }));
    const overlayer = vi.fn();
    const relocate = vi.fn();
    reader.addEventListener('create-overlayer', overlayer);
    reader.addEventListener('relocate', relocate);
    let finished = false;
    const navigation = reader.goTo({ index: 0 }).then(() => { finished = true; });
    await settle();
    if (change === 'zoom') reader.setAttribute('zoom', '2');
    else {
      reader.getBoundingClientRect = () => ({ width: 800, height: 1200 }) as DOMRect;
      resizeCallbacks.get(reader)!();
    }
    cancelFirst();
    await settle();
    expect(finished).toBe(false);
    expect(overlayer).not.toHaveBeenCalled();
    finishLatest();
    await navigation;
    expect(overlayer).toHaveBeenCalledTimes(1);
    expect(relocate).toHaveBeenCalledTimes(1);
  });

  it('creates the previously hidden half overlayer when resizing into landscape', async () => {
    const { reader } = makeReader('ltr', 'auto');
    const overlays: number[] = [];
    reader.addEventListener('create-overlayer', event => {
      if (!(event instanceof CustomEvent)) throw new Error('Expected overlayer detail');
      overlays.push(event.detail.index);
      event.detail.attach({ element: document.createElement('div'), redraw: vi.fn() });
    });
    const navigation = reader.goTo({ index: 1 });
    await settle();
    await navigation;
    expect(overlays).toEqual([1]);
    reader.getBoundingClientRect = () => ({ width: 1200, height: 900 }) as DOMRect;
    resizeCallbacks.get(reader)!();
    await settle();
    expect(overlays).toEqual([1, 2]);
  });

  it('keeps the new spread when a second navigation targets it during loading', async () => {
    const { reader, book } = makeReader();
    const first = reader.goTo({ index: 0 });
    await settle();
    await first;
    let release = () => {};
    book.sections[3]!.load.mockImplementationOnce(() => new Promise(resolve => {
      release = () => resolve({ src: 'about:blank', data: '<p>Delayed</p>' });
    }));
    const loading = reader.goTo({ index: 3 });
    await Promise.resolve();
    const repeated = reader.goTo({ index: 3 });
    await settle();
    await repeated;
    release();
    await loading;
    expect(reader.index).toBe(3);
    const visible = Array.from(reader.shadowRoot!.querySelectorAll('iframe'))
      .filter(frame => frame.parentElement?.style.visibility === 'visible');
    expect(visible.map(frame => frame.dataset.sectionIndex)).toEqual(['3']);
  });

  it.each(['ltr', 'rtl'])('keeps every page through single/auto/single in a narrow %s reader', async (dir) => {
    const { reader } = makeReader(dir);
    for (let index = 0; index < 8; index++) {
      const navigation = reader.goTo({ index });
      await settle();
      await navigation;
      reader.setAttribute('spread', 'auto');
      await settle();
      expect(reader.index).toBe(index);
      reader.setAttribute('spread', 'none');
      await settle();
      expect(reader.index).toBe(index);
      expect(reader.pages).toBe(8);
    }
  });

  it('applies a page mode set before the first navigation', async () => {
    const { reader } = makeReader('ltr', 'auto');
    reader.setAttribute('spread', 'none');
    expect(reader.pages).toBe(8);
    const navigation = reader.goTo({ index: 3 });
    await settle();
    await navigation;
    expect(reader.index).toBe(3);
  });

  it.each(['ltr', 'rtl'])('keeps the target page during rapid mode changes in %s', async (dir) => {
    const { reader } = makeReader(dir);
    for (let index = 0; index < 8; index++) {
      const navigation = reader.goTo({ index });
      await settle();
      await navigation;
      reader.setAttribute('spread', 'auto');
      reader.setAttribute('spread', 'none');
      await settle();
      expect(reader.index).toBe(index);
    }
  });

  it('updates the reading position when navigating to the other half of the same spread', async () => {
    const { reader } = makeReader('ltr', 'auto');
    const navigation = reader.goTo({ index: 1 });
    await settle();
    await navigation;
    await reader.goTo({ index: 2 });
    expect(reader.index).toBe(2);
    reader.setAttribute('spread', 'none');
    await settle();
    expect(reader.index).toBe(2);
  });

  it('keeps the scroll position when changing mode then returning to pagination', async () => {
    const { reader } = makeReader();
    const navigation = reader.goTo({ index: 4 });
    await settle();
    await navigation;
    reader.setAttribute('flow', 'scrolled');
    await reader.goTo({ index: 5 });
    reader.setAttribute('spread', 'auto');
    expect(reader.index).toBe(5);
    reader.setAttribute('flow', 'paginated');
    await settle();
    expect(reader.index).toBe(5);
  });

  it('discards an old navigation when its page finishes loading after a mode change', async () => {
    const { reader, book } = makeReader();
    let release!: (value: { src: string; data: string }) => void;
    book.sections[3]!.load.mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
    const oldNavigation = reader.goTo({ index: 3 });
    reader.setAttribute('spread', 'auto');
    reader.setAttribute('spread', 'none');
    await settle();
    release({ src: 'about:blank', data: '<p>Old page</p>' });
    await settle();
    await oldNavigation;
    expect(reader.index).toBe(3);
    expect(reader.getContents().map(({ index }: { index: number }) => index)).toEqual([3]);
  });

  it('does not reuse a pending single-page preload as a two-page spread', async () => {
    const { reader, book } = makeReader();
    let release!: (value: { src: string; data: string }) => void;
    book.sections[2]!.load.mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
    const navigation = reader.goTo({ index: 1 });
    await settle();
    await navigation;
    expect(release).toBeTypeOf('function');
    reader.setAttribute('spread', 'auto');
    await settle();
    release({ src: 'about:blank', data: '<p>Old preload</p>' });
    await settle();
    const next = reader.goTo({ index: 4 });
    await settle();
    await next;
    expect(reader.index).toBe(4);
    expect(reader.getContents().map(({ index }: { index: number }) => index)).toContain(4);
  });
});
