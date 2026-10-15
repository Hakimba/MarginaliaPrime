import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import type { TextSelection } from '@/utils/sel';
import Annotator from './Annotator';

const fixture = vi.hoisted(() => ({
  view: Object.assign(new EventTarget(), { renderer: new EventTarget() }),
  scroll: vi.fn(),
  setSelection: (_selection: TextSelection) => {},
  position: vi.fn((selection: TextSelection) => ({ point: { x: selection.index * 10, y: 20 }, dir: 'up' })),
}));
vi.mock('@/utils/perf', () => ({ perfRender: () => {} }));
vi.mock('@/context/EnvContext', () => ({ useEnv: () => ({ envConfig: {}, appService: null }) }));
vi.mock('@/hooks/useTranslation', () => ({ useTranslation: () => (text: string) => text }));
vi.mock('@/hooks/useResponsiveSize', () => ({ useResponsiveSize: (size: number) => size }));
vi.mock('@/hooks/useShortcuts', () => ({ default: () => {} }));
vi.mock('@/store/settingsStore', () => ({ useSettingsStore: () => ({ settings: { globalReadSettings: { highlightStyle: 'highlight', highlightStyles: { highlight: 'yellow' } } } }) }));
vi.mock('@/store/themeStore', () => ({ useThemeStore: () => ({ isDarkMode: false }) }));
vi.mock('@/store/bookDataStore', () => ({ useBookDataStore: () => ({ getConfig: () => ({ booknotes: [] }), getBookData: () => ({ book: {} }) }) }));
vi.mock('@/store/readerStore', () => ({ useReaderStore: () => ({ getView: () => fixture.view, getProgress: () => null, getViewSettings: () => ({ vertical: false }) }) }));
vi.mock('@/store/notebookStore', () => ({ useNotebookStore: () => ({}) }));
vi.mock('@/store/deviceStore', () => ({ useDeviceControlStore: () => ({}) }));
vi.mock('./AnnotationRangeEditor', () => ({ default: () => null }));
vi.mock('./ExportMarkdownDialog', () => ({ default: () => null }));
vi.mock('@/utils/sel', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/utils/sel')>(),
  getPosition: fixture.position,
  getPopupPosition: (position: unknown) => position,
}));
vi.mock('../../hooks/useTextSelector', () => ({ useTextSelector: (_key: string, setSelection: typeof fixture.setSelection) => {
  fixture.setSelection = setSelection;
  const noop = () => {};
  return {
    isTextSelected: { current: false }, isInstantAnnotating: { current: false },
    handleScroll: fixture.scroll, handleTouchStart: noop, handleTouchMove: noop,
    handleTouchEnd: noop, handlePointerDown: noop, handlePointerMove: noop,
    handlePointerCancel: noop, handlePointerUp: noop, handleSelectionchange: noop,
    handleShowPopup: noop, handleUpToPopup: noop, handleContextmenu: noop,
  };
} }));
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
let root: ReturnType<typeof createRoot> | undefined;
afterEach(async () => {
  if (root) await act(async () => root?.unmount());
  root = undefined;
  document.body.replaceChildren();
  vi.useRealTimers();
});
it('keeps one scroll subscription across loads, uses current selection and handler, then unsubscribes', async () => {
  vi.useFakeTimers();
  const host = document.createElement('div');
  host.id = 'gridcell-book-view';
  document.body.append(host);
  root = createRoot(host);
  const activeScroll = new Set<EventListenerOrEventListenerObject>();
  const renderer = fixture.view.renderer;
  const add = renderer.addEventListener.bind(renderer);
  const remove = renderer.removeEventListener.bind(renderer);
  vi.spyOn(renderer, 'addEventListener').mockImplementation((type, listener, options) => {
    if (type === 'scroll' && listener) activeScroll.add(listener);
    add(type, listener, options);
  });
  vi.spyOn(renderer, 'removeEventListener').mockImplementation((type, listener, options) => {
    if (type === 'scroll' && listener) activeScroll.delete(listener);
    remove(type, listener, options);
  });
  await act(async () => root!.render(<Annotator bookKey='book-view' />));
  for (let index = 0; index < 100; index++) {
    fixture.view.dispatchEvent(new CustomEvent('load', { detail: { doc: document.implementation.createHTMLDocument(), index } }));
  }
  expect(activeScroll.size).toBe(1);
  const firstScroll = fixture.scroll;
  fixture.scroll = vi.fn();
  const range = document.createRange();
  await act(async () => fixture.setSelection({ key: 'book-view', text: 'latest', index: 7, range, cfi: 'cfi', page: 1 }));
  expect(host.querySelector('.selection-popup')).not.toBeNull();
  fixture.position.mockClear();
  await act(async () => fixture.view.renderer.dispatchEvent(new Event('scroll')));
  expect(firstScroll).not.toHaveBeenCalled();
  expect(fixture.scroll).toHaveBeenCalledTimes(1);
  expect(fixture.position).toHaveBeenCalledTimes(1);
  expect(fixture.position.mock.calls[0]?.[0].text).toBe('latest');
  expect(host.querySelector<HTMLElement>('.selection-popup')?.style.left).toBe('70px');
  expect(activeScroll.size).toBe(1);
  await act(async () => root!.unmount());
  root = undefined;
  expect(activeScroll.size).toBe(0);
  fixture.view.renderer.dispatchEvent(new Event('scroll'));
  expect(fixture.scroll).toHaveBeenCalledTimes(1);
});
