import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FixedLayout } from '../../../packages/foliate-js/fixed-layout.js';

// Exercise the real renderer; jsdom supplies documents but no geometry or iframe loads.
vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} });
vi.stubGlobal('IntersectionObserver', class { observe() {} disconnect() {} });
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
