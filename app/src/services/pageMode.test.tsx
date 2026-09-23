import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadBookConfig, saveBookConfig } from './bookService';
import { getDefaultViewSettings } from './settingsService';
import { useReaderStore } from '@/store/readerStore';
import { useBookDataStore } from '@/store/bookDataStore';
import { useSettingsStore } from '@/store/settingsStore';
import { useLibraryStore } from '@/store/libraryStore';
import { Book } from '@/types/book';
import { BookDoc } from '@/libs/document';
import { FileSystem } from '@/types/system';
import { SystemSettings } from '@/types/settings';
import ViewMenu from '@/app/reader/components/ViewMenu';

const service = vi.hoisted(() => ({ saveBookConfig: vi.fn(), saveLibraryBooks: vi.fn() }));
vi.mock('@/context/EnvContext', () => ({
  useEnv: () => ({ envConfig: { getAppService: async () => service }, appService: null }),
}));
vi.mock('@/hooks/useTranslation', () => ({ useTranslation: () => (text: string) => text }));
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const makeStorage = () => {
  const files = new Map<string, string>();
  return {
    exists: async (path: string) => files.has(path),
    readFile: async (path: string) => files.get(path),
    writeFile: async (path: string, _base: string, text: string) => { files.set(path, text); },
  } as unknown as FileSystem;
};
const makeBook = (format: Book['format'], isFixedLayout?: boolean) => ({
  hash: 'book', title: 'Test', author: '', format, isFixedLayout,
  createdAt: 0, updatedAt: 0,
}) satisfies Book;
const makeSettings = (fs: FileSystem) => ({
  globalViewSettings: getDefaultViewSettings({ fs, isMobile: false, isAppDataSandbox: false }),
}) as SystemSettings;

afterEach(() => {
  vi.clearAllMocks();
});

describe('page mode persistence', () => {
  it.each([makeBook('PDF'), makeBook('CBZ'), makeBook('EPUB', true)])(
    'opens $format fixed-layout books on one page and preserves explicit choices', async (book) => {
      const fs = makeStorage();
      const settings = makeSettings(fs);
      const config = await loadBookConfig(fs, book, settings);
      expect(config.viewSettings!.spreadMode).toBe('none');
      config.viewSettings!.spreadMode = 'auto';
      await saveBookConfig(fs, book, config, settings);
      expect((await loadBookConfig(fs, book, settings)).viewSettings!.spreadMode).toBe('auto');
      config.viewSettings!.spreadMode = 'none';
      await saveBookConfig(fs, book, config, settings);
      expect((await loadBookConfig(fs, book, settings)).viewSettings!.spreadMode).toBe('none');
      expect(settings.globalViewSettings.spreadMode).toBe('auto');
    },
  );

  it('keeps reflowable EPUB layout settings unchanged', async () => {
    const fs = makeStorage();
    const settings = makeSettings(fs);
    expect((await loadBookConfig(fs, makeBook('EPUB'), settings)).viewSettings!.spreadMode).toBe('auto');
  });

  it('saves a menu choice immediately, without waiting for a page turn or closing the book', async () => {
    const fs = makeStorage();
    const settings = makeSettings(fs);
    const book = makeBook('PDF');
    const config = await loadBookConfig(fs, book, settings);
    const key = 'book-view';
    const renderer = document.createElement('div');
    useSettingsStore.setState({ settings, isSettingsGlobal: true });
    useLibraryStore.setState({ library: [book] });
    useBookDataStore.setState({ booksData: { book: {
      id: 'book', book, file: null, config, isFixedLayout: true,
      bookDoc: { rendition: { layout: 'pre-paginated' }, sections: [{}] } as BookDoc,
    } } });
    useReaderStore.setState({ bookKeys: [key], viewStates: {} });
    // Supply a real primary view so saveViewSettings goes through the real stores.
    const state = { key, isPrimary: true, viewSettings: config.viewSettings, view: { renderer } };
    useReaderStore.setState({ viewStates: { [key]: state } } as unknown as Partial<ReturnType<typeof useReaderStore.getState>>);
    service.saveBookConfig.mockImplementation((book, config, settings) => saveBookConfig(fs, book, config, settings));
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    try {
      await act(async () => root.render(<ViewMenu bookKey={key} />));
      for (const [label, mode] of [['Deux pages (auto)', 'auto'], ['Une page', 'none']]) {
        const button = Array.from(container.querySelectorAll('button')).find(button => button.textContent?.includes(label!))!;
        expect(button).toBeDefined();
        await act(async () => button.click());
        expect(renderer.getAttribute('spread')).toBe(mode);
        expect(button.getAttribute('aria-pressed')).toBe('true');
        expect((await loadBookConfig(fs, book, settings)).viewSettings!.spreadMode).toBe(mode);
      }
      expect(service.saveBookConfig).toHaveBeenCalledTimes(2);
      expect(settings.globalViewSettings.spreadMode).toBe('auto');
    } finally {
      await act(async () => root.unmount());
      container.remove();
    }
  });
});
