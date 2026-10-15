import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import useBookShortcuts from './useBookShortcuts';

const fixture = vi.hoisted(() => {
  const view = { renderer: { setAttribute: vi.fn() }, next: vi.fn() };
  const settings = { scrolled: true, defaultFontSize: 16, lineHeight: 1.5 };
  const state = {
    getView: () => view,
    getViewSettings: () => settings,
    setViewSettings: vi.fn(),
    viewStates: { book: { viewSettings: settings } },
  };
  return { view, state };
});

vi.mock('@/store/readerStore', () => ({
  useReaderStore: <T,>(select: (state: typeof fixture.state) => T) => select(fixture.state),
}));
vi.mock('@/store/sidebarStore', () => ({
  useSidebarStore: () => ({ toggleSideBar: vi.fn(), setSideBarBookKey: vi.fn() }),
}));
vi.mock('@/store/settingsStore', () => ({
  useSettingsStore: () => ({ setSettingsDialogOpen: vi.fn() }),
}));
vi.mock('@/store/bookDataStore', () => ({
  useBookDataStore: <T,>(select: (state: { getBookData: () => undefined }) => T) =>
    select({ getBookData: () => undefined }),
}));
vi.mock('@/store/notebookStore', () => ({
  useNotebookStore: () => ({ toggleNotebook: vi.fn() }),
}));
vi.mock('@/components/command-palette', () => ({
  useCommandPalette: () => ({ open: vi.fn() }),
}));
vi.mock('./useBooksManager', () => ({ default: () => ({ getNextBookKey: vi.fn() }) }));
vi.mock('./usePagination', () => ({ viewPagination: vi.fn() }));

it('changes scroll mode without also advancing, and keeps PageDown navigation', async () => {
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  const Harness = () => {
    useBookShortcuts({ sideBarBookKey: 'book', bookKeys: ['book'] });
    return null;
  };
  try {
    await act(async () => root.render(<Harness />));
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'J', shiftKey: true }));
    expect(fixture.view.renderer.setAttribute).toHaveBeenCalledExactlyOnceWith('flow', 'paginated');
    expect(fixture.view.next).not.toHaveBeenCalled();
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'PageDown' }));
    expect(fixture.view.next).toHaveBeenCalledExactlyOnceWith(72);
  } finally {
    await act(async () => root.unmount());
    host.remove();
  }
});
