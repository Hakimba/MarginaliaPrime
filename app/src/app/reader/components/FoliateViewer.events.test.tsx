import React, { act, StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { BookDoc } from '@/libs/document';
import FoliateViewer from './FoliateViewer';

const fixture = vi.hoisted(() => {
  const viewSettings = {
    writingMode: 'horizontal-tb', vertical: false, rtl: false, scrolled: false,
    maxColumnCount: 1, maxInlineSize: 600, maxBlockSize: 800,
    marginTop: 0, marginBottom: 0, marginLeft: 0, marginRight: 0, gapPercent: 0,
  };
  const reader = {
    viewStates: { 'book-view': { loading: false, viewSettings } },
    getView: vi.fn(), setView: vi.fn(), setViewInited: vi.fn(), setProgress: vi.fn(),
    getProgress: vi.fn(), getViewSettings: () => viewSettings, setViewSettings: vi.fn(),
  };
  return {
    reader, openGate: Promise.resolve(), dark: false, style: vi.fn(), observe: vi.fn(), parallelGoTo: vi.fn(),
    getParallels: vi.fn(() => new Set(['parallel-view'])),
  };
});
vi.mock('foliate-js/view.js', () => ({}));
vi.mock('@/utils/perf', () => ({ perfRender: () => {}, perfMark: () => {}, perfSpan: () => () => {} }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: async () => null }));
vi.mock('@/context/EnvContext', () => ({ useEnv: () => ({ envConfig: {}, appService: null }) }));
vi.mock('@/store/themeStore', () => ({ useThemeStore: () => ({ themeCode: 'default', isDarkMode: fixture.dark }) }));
vi.mock('@/store/settingsStore', () => ({ useSettingsStore: () => ({ settings: {} }) }));
vi.mock('@/store/customFontStore', () => ({ useCustomFontStore: () => ({ getLoadedFonts: () => [], getAvailableFonts: () => [] }) }));
vi.mock('@/store/readerStore', () => ({ useReaderStore: Object.assign(
  <T,>(selector: (state: typeof fixture.reader) => T) => selector(fixture.reader),
  { getState: () => fixture.reader },
) }));
vi.mock('@/store/bookDataStore', () => ({ useBookDataStore: <T,>(selector: (state: { getBookData: () => { book: { title: string } } }) => T) => selector({ getBookData: () => ({ book: { title: 'Book' } }) }) }));
vi.mock('@/store/parallelViewStore', () => ({ useParallelViewStore: () => ({ getParallels: fixture.getParallels }) }));
vi.mock('../hooks/useIframeEvents', () => ({ useMouseEvent: () => ({}), useTouchEvent: () => ({}), useLongPressEvent: () => {} }));
vi.mock('../hooks/usePagination', () => ({ usePagination: () => ({}) }));
vi.mock('../hooks/useProgressAutoSave', () => ({ useProgressAutoSave: () => {} }));
vi.mock('../hooks/useAutoSaveBookCover', () => ({ useBookCoverAutoSave: () => {} }));
vi.mock('../hooks/useSelectionProbe', () => ({ useSelectionProbe: () => {} }));
vi.mock('@/hooks/useUICSS', () => ({ useUICSS: () => {} }));
vi.mock('@/hooks/useAutoFocus', () => ({ useAutoFocus: () => {} }));
vi.mock('@/hooks/useBackgroundTexture', () => ({ useBackgroundTexture: () => ({ applyBackgroundTexture: () => {} }) }));
vi.mock('@/hooks/useTranslation', () => ({ useTranslation: () => (text: string) => text }));
vi.mock('@/styles/fonts', () => ({ mountAdditionalFonts: () => {}, mountCustomFont: () => {} }));
vi.mock('@/utils/style', () => ({
  applyFixedlayoutStyles: () => {}, applyImageStyle: () => {}, applyScrollbarStyle: () => {},
  applyScrollModeClass: () => {}, applyTableStyle: () => {}, applyThemeModeClass: fixture.style,
  getStyles: () => '', keepTextAlignment: () => {}, transformStylesheet: () => '',
}));
vi.mock('@/utils/insets', () => ({ getViewInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }) }));
vi.mock('../utils/iframeEventHandlers');
vi.mock('./ImageViewer', () => ({ default: () => null }));
vi.mock('./TableViewer', () => ({ default: () => null }));

const book: BookDoc = {
  metadata: { title: 'Book', author: '', language: 'en' },
  rendition: { layout: 'reflowable' }, dir: 'ltr', sections: [],
  splitTOCHref: () => [], getCover: async () => null,
};
const insets = { top: 0, right: 0, bottom: 0, left: 0 };
const makeDocument = () => {
  const frame = document.createElement('iframe');
  document.body.append(frame);
  if (!frame.contentDocument) throw new Error('Iframe document unavailable');
  return frame.contentDocument;
};
class FastView extends HTMLElement {
  book = book;
  renderer = Object.assign(document.createElement('div'), {
    setStyles: vi.fn(), getContents: () => [], atEnd: false,
  });
  doc = makeDocument();
  open = vi.fn(async () => { await fixture.openGate; });
  addAnnotation = vi.fn();
  getCFI = vi.fn(() => 'cfi');
  resolveNavigation = vi.fn(() => ({ index: 0 }));
  init = vi.fn(() => this.navigate());
  goToFraction = vi.fn(() => this.navigate());
  navigate() {
    this.doc.body.innerHTML = '<p>First page</p>';
    this.dispatchEvent(new CustomEvent('load', { detail: { doc: this.doc, index: 0 } }));
    this.dispatchEvent(new CustomEvent('relocate', { detail: {
      cfi: 'initial-cfi', location: { current: 0, next: 1, total: 10 },
      section: { current: 0 },
    } }));
    this.renderer.dispatchEvent(new CustomEvent('relocate', { detail: {
      reason: 'page', index: 0, fraction: 0.5,
    } }));
    this.renderer.dispatchEvent(new Event('stabilized'));
  }
}
customElements.define('foliate-view', FastView);
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
let root: ReturnType<typeof createRoot> | undefined;
let host: HTMLDivElement;
beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  fixture.dark = false;
  fixture.openGate = Promise.resolve();
  fixture.reader.getView.mockReturnValue({ renderer: { goTo: fixture.parallelGoTo } });
  vi.stubGlobal('IntersectionObserver', class {
    observe = fixture.observe;
    disconnect() {}
  });
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  if (root) await act(async () => root?.unmount());
  root = undefined;
  document.body.replaceChildren();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
const render = async (lastLocation?: string) => {
  await act(async () => root!.render(<StrictMode><FoliateViewer
    bookKey='book-view' bookDoc={book} config={{ updatedAt: 0, location: lastLocation }}
    gridInsets={insets} contentInsets={insets}
  /></StrictMode>));
  await act(async () => { await vi.dynamicImportSettled(); });
  const view = host.querySelector('foliate-view');
  if (!(view instanceof FastView)) throw new Error('View was not created');
  return view;
};
it.each([undefined, 'saved-cfi'])('handles initial navigation before the loading timer with location %s', async (location) => {
  const start = Date.now();
  const view = await render(location);
  expect(Date.now()).toBe(start);
  expect(view.open).toHaveBeenCalledTimes(1);
  expect(location ? view.init : view.goToFraction).toHaveBeenCalledTimes(1);
  expect(fixture.style).toHaveBeenCalledWith(view.doc, false);
  expect(view.doc.querySelector('#marginalia-skip-link')).not.toBeNull();
  expect(fixture.observe).toHaveBeenCalledExactlyOnceWith(view.doc.querySelector('p'));
  expect(fixture.reader.setProgress).toHaveBeenCalledWith(
    'book-view', 'initial-cfi', undefined, { current: 0 },
    { current: 0, next: 1, total: 10 }, undefined, undefined,
  );
  expect(fixture.parallelGoTo).toHaveBeenCalledExactlyOnceWith({ index: 0, anchor: 0.5 });
});
it('uses current callbacks and removes the view listeners and a11y session on unmount', async () => {
  const view = await render();
  fixture.dark = true;
  await render();
  const replacement = makeDocument();
  replacement.body.innerHTML = '<p>New document</p>';
  fixture.style.mockClear();
  await act(async () => view.dispatchEvent(new CustomEvent('load', { detail: { doc: replacement, index: 1 } })));
  expect(fixture.style).toHaveBeenCalledExactlyOnceWith(replacement, true);
  expect(replacement.querySelector('#marginalia-skip-link')).not.toBeNull();
  const removeView = vi.spyOn(view, 'removeEventListener');
  const removeRenderer = vi.spyOn(view.renderer, 'removeEventListener');
  await act(async () => root!.unmount());
  root = undefined;
  expect(removeView.mock.calls.map(([type]) => type).sort()).toEqual(['load', 'relocate']);
  expect(removeRenderer.mock.calls.map(([type]) => type).sort()).toEqual(['relocate', 'relocate', 'scroll', 'stabilized']);
  fixture.style.mockClear();
  fixture.reader.setProgress.mockClear();
  fixture.parallelGoTo.mockClear();
  view.navigate();
  expect(fixture.style).not.toHaveBeenCalled();
  expect(fixture.reader.setProgress).not.toHaveBeenCalled();
  expect(fixture.parallelGoTo).not.toHaveBeenCalled();
});

it('disposes a session created when open resolves after unmount', async () => {
  let finishOpen = () => {};
  fixture.openGate = new Promise<void>((resolve) => { finishOpen = resolve; });
  const view = await render();
  expect(view.open).toHaveBeenCalledTimes(1);
  expect(view.goToFraction).not.toHaveBeenCalled();
  const removeRenderer = vi.spyOn(view.renderer, 'removeEventListener');
  await act(async () => root!.unmount());
  root = undefined;
  await act(async () => { finishOpen(); await fixture.openGate; });
  expect(fixture.reader.setView).not.toHaveBeenCalled();
  expect(view.goToFraction).not.toHaveBeenCalled();
  expect(removeRenderer.mock.calls.map(([type]) => type).sort()).toEqual(['relocate', 'scroll']);
});
