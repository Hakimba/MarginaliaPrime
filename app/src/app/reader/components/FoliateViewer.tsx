import clsx from 'clsx';
import React, { useEffect, useRef, useState, useCallback } from 'react';
import { convertBlobUrlToDataUrl, BookDoc, getDirection } from '@/libs/document';
import { BookConfig, PageInfo } from '@/types/book';
import { FoliateView, wrappedFoliateView } from '@/types/view';
import { Insets } from '@/types/misc';
import { useEnv } from '@/context/EnvContext';
import { useThemeStore } from '@/store/themeStore';
import { useReaderStore } from '@/store/readerStore';
import { useBookDataStore } from '@/store/bookDataStore';
import { useSettingsStore } from '@/store/settingsStore';
import { useCustomFontStore } from '@/store/customFontStore';
import { useParallelViewStore } from '@/store/parallelViewStore';
import { useChatStore } from '@/store/chatStore';
import { useMouseEvent, useTouchEvent, useLongPressEvent } from '../hooks/useIframeEvents';
import { usePagination } from '../hooks/usePagination';
import { useFoliateEvents } from '../hooks/useFoliateEvents';
import { useProgressAutoSave } from '../hooks/useProgressAutoSave';
import { useBackgroundTexture } from '@/hooks/useBackgroundTexture';
import { useAutoFocus } from '@/hooks/useAutoFocus';
import { useTranslation } from '@/hooks/useTranslation';
import {
  applyFixedlayoutStyles,
  applyImageStyle,
  applyScrollbarStyle,
  applyScrollModeClass,
  applyTableStyle,
  applyThemeModeClass,
  getStyles,
  keepTextAlignment,
  transformStylesheet,
} from '@/utils/style';
import { mountAdditionalFonts, mountCustomFont } from '@/styles/fonts';
import { getBookDirFromLanguage, getBookDirFromWritingMode } from '@/utils/book';
import { getIndexFromCfi } from '@/utils/cfi';
import { useUICSS } from '@/hooks/useUICSS';
import {
  handleKeydown,
  handleKeyup,
  handleMousedown,
  handleMouseup,
  handleClick,
  handleWheel,
  handleTouchStart,
  handleTouchMove,
  handleTouchEnd,
  addLongPressListeners,
} from '../utils/iframeEventHandlers';
import { getMaxInlineSize } from '@/utils/config';
import { getDirFromUILanguage } from '@/utils/rtl';
import { isTauriAppPlatform } from '@/services/environment';
import { TransformContext } from '@/services/transformers/types';
import { transformContent } from '@/services/transformService';
import { lockScreenOrientation } from '@/utils/bridge';
import { useBookCoverAutoSave } from '../hooks/useAutoSaveBookCover';
import { manageSyntaxHighlighting } from '@/utils/highlightjs';
import { getViewInsets } from '@/utils/insets';
import { handleA11yNavigation } from '@/utils/a11y';
import { isCJKLang } from '@/utils/lang';
import { getLocale } from '@/utils/misc';
import { isFontType } from '@/utils/font';
import {
  extractChapterText,
  extractPages,
  findTopLevelAncestor,
} from '@/services/chapterExtraction';
import { ensureBookIndex } from '@/services/bookIndex';
import { readingOf } from '@/store/chatStore';
import { nextMaxPage } from '@/utils/readingProgress';
import { perfMark, perfSpan } from '@/utils/perf';
import { useSelectionProbe } from '../hooks/useSelectionProbe';
import Spinner from '@/components/Spinner';
import ImageViewer from './ImageViewer';
import TableViewer from './TableViewer';

declare global {
  interface Window {
    eval(script: string): void;
  }
}

/** Pages on each side of the reader sent as context for a fixed-layout book. */
const CONTEXT_PAGE_WINDOW = 5;
/** How far the reader may move from the window's centre before it follows. */
const CONTEXT_PAGE_RECENTER = 2;
/** Pages past the furthest read the window may reach, for the anti-spoiler. */
const CONTEXT_PAGE_AHEAD = 2;

const FoliateViewer: React.FC<{
  bookKey: string;
  bookDoc: BookDoc;
  config: BookConfig;
  gridInsets: Insets;
  contentInsets: Insets;
}> = ({ bookKey, bookDoc, config, gridInsets, contentInsets: insets }) => {
  const _ = useTranslation();
  const { appService, envConfig } = useEnv();
  const { themeCode, isDarkMode } = useThemeStore();
  const { settings } = useSettingsStore();
  const { loadFont, loadCustomFonts, getLoadedFonts, getAvailableFonts } = useCustomFontStore();
  const { getView, setView: setFoliateView, setViewInited, setProgress } = useReaderStore();
  const { getViewState, getProgress, getViewSettings, setViewSettings } = useReaderStore();
  const { getParallels } = useParallelViewStore();
  const { getBookData } = useBookDataStore();
  const { applyBackgroundTexture } = useBackgroundTexture();
  const _bookData = getBookData(bookKey);
  const viewState = getViewState(bookKey);
  const viewSettings = getViewSettings(bookKey);

  const viewRef = useRef<FoliateView | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const isViewCreated = useRef(false);
  const doubleClickDisabled = useRef(!!viewSettings?.disableDoubleClick);
  const [toastMessage, setToastMessage] = useState('');
  const [loading, setLoading] = useState(false);
  const [scrollMargins, setScrollMargins] = useState({ top: 0, bottom: 0 });
  const docLoaded = useRef(false);
  const lastChapterHref = useRef('');
  const firstRelocate = useRef(true);
  // Chapter text is extracted lazily: only when the chat panel is open. Until
  // then we remember what to extract so opening the panel can trigger it.
  const pendingChapter = useRef<{
    tocItem: Parameters<typeof extractChapterText>[1];
    toc: Parameters<typeof extractChapterText>[2];
    bookTitle: string;
    bookAuthor: string;
    chapterTitle: string;
    sectionIdx?: number;
  } | null>(null);
  const chatOpen = useChatStore((s) => s.isOpen);
  const bookHash = bookKey.split('-')[0] ?? '';
  /**
   * Fixed layout: the page the context window should be centred on, waiting
   * to be extracted, and the page the current window was centred on. The
   * window follows the reader, not the table of contents: a PDF may have none,
   * and one entry of it can span a hundred pages.
   */
  const pendingWindow = useRef<number | null>(null);
  const windowCenter = useRef<number | null>(null);
  const pageTexts = useRef(new Map<number, string>());
  const windowRun = useRef(0);

  /**
   * Extracting a chapter walks every section of it, which is heavy enough to
   * delay the first page render. Run it when the reader goes idle so an open
   * chat panel never costs anything at book-opening time.
   */
  const runChapterExtraction = () => {
    if (!pendingChapter.current && pendingWindow.current === null) return;
    const idle = (window as unknown as { requestIdleCallback?: typeof setTimeout })
      .requestIdleCallback;
    if (typeof idle === 'function') {
      (window as unknown as { requestIdleCallback: (cb: () => void, o?: unknown) => void })
        .requestIdleCallback(() => extractPendingChapter(), { timeout: 3000 });
    } else {
      setTimeout(() => extractPendingChapter(), 500);
    }
  };

  /**
   * Last section index the reader may be shown without asking: two past the
   * furthest read, for a proof that runs over. Infinity with spoilers allowed
   * or nothing recorded.
   */
  const readUpToIndex = (): number => {
    const reading = readingOf(useChatStore.getState(), bookHash);
    return reading && !reading.spoilersAllowed && reading.maxPage > 0
      ? reading.maxPage - 1 + CONTEXT_PAGE_AHEAD
      : Infinity;
  };
  /** The chapter text was cut at this section; reading past it extracts again. */
  const chapterCut = useRef<number | null>(null);
  /** The stored reading state has been read: the furthest page may move. */
  const stateLoaded = useRef(false);

  const extractPendingWindow = () => {
    const center = pendingWindow.current;
    if (center === null) return;
    pendingWindow.current = null;
    const run = ++windowRun.current;
    const first = center - CONTEXT_PAGE_WINDOW;
    // Not far past what the reader has read: the pages sent unasked must not
    // tell what comes next. Two pages ahead, for a proof that runs over.
    const last = Math.min(center + CONTEXT_PAGE_WINDOW, Math.max(center, readUpToIndex()));
    const endExtract = perfSpan('context:pages', { first: first + 1, last: last + 1 });
    const cache = pageTexts.current;
    extractPages(bookDoc, first, last, cache)
      .then((pages) => {
        endExtract({ pages: pages.length, chars: pages.reduce((n, p) => n + p.text.length, 0) });
        // The reader moved on during the extraction: a newer run owns the store.
        if (run !== windowRun.current || disposed.current) return;
        // Pages far behind are dropped; the window never needs them again.
        for (const key of cache.keys()) {
          if (Math.abs(key - center) > 4 * CONTEXT_PAGE_WINDOW) cache.delete(key);
        }
        useChatStore.getState().setContextPages(pages, bookKey);
        if (pendingWindow.current === null) useChatStore.getState().setContextPending(false);
      })
      .catch((e) => {
        console.warn('context: page window extraction failed', e);
        if (run === windowRun.current && !disposed.current) {
          useChatStore.getState().setContextPending(false);
        }
      });
  };

  const extractPendingChapter = () => {
    extractPendingWindow();
    const pending = pendingChapter.current;
    if (!pending) return;
    pendingChapter.current = null;
    const { tocItem, toc, bookTitle, bookAuthor, chapterTitle, sectionIdx } = pending;
    const endExtract = perfSpan('chapter:extract', { chapter: chapterTitle });
    const cut = readUpToIndex();
    chapterCut.current = Number.isFinite(cut) ? cut : null;
    extractChapterText(bookDoc, tocItem, toc, {
      currentSectionIdx: sectionIdx,
      ...(Number.isFinite(cut) ? { readUpToIdx: cut } : {}),
    }).then((text) => {
      endExtract({ chars: text.length });
      if (disposed.current) return;
      useChatStore.getState().updateBookContext(bookTitle, bookAuthor, chapterTitle, text);
      if (!pendingChapter.current) useChatStore.getState().setContextPending(false);
    });
  };

  const chapterRequest = useChatStore((s) => s.chapterRequest);

  // A book just opened: the context of the previous one is not its own, and an
  // extraction still running for a closed book must not land in the store.
  const disposed = useRef(false);
  /**
   * The index the reader's tools search, built once per book: after the first
   * page is on screen, one page at a time when the browser is idle.
   */
  const indexStarted = useRef(false);
  const startBookIndex = () => {
    if (indexStarted.current) return;
    indexStarted.current = true;
    const hash = bookKey.split('-')[0] ?? '';
    const book = getBookData(bookKey)?.book;
    if (!hash || !book) return;
    const chat = useChatStore.getState;
    const idle = () =>
      new Promise<void>((resolve) => {
        const ric = (window as unknown as {
          requestIdleCallback?: (cb: () => void, o?: unknown) => void;
        }).requestIdleCallback;
        if (typeof ric === 'function') ric(() => resolve(), { timeout: 1000 });
        // WebKitGTK has no idle callback: a pause between pages leaves the
        // main thread to the reader most of the time.
        else setTimeout(resolve, 80);
      });
    const endIndex = perfSpan('index:build', { hash });
    let lastPercent = -1;
    void (async () => {
      const { invoke } = await import('@tauri-apps/api/core');
      const index = await ensureBookIndex(
        bookDoc,
        { hash, title: book.title, fixedLayout: bookDoc.rendition?.layout === 'pre-paginated' },
        {
          load: (h) => invoke<string | null>('book_index_load', { hash: h }),
          write: (h, content) => invoke('book_index_write', { hash: h, content }),
        },
        {
          cancelled: () => disposed.current,
          pause: idle,
          // Shown in whole percents: one store update per page re-rendered
          // the chat panel four hundred times.
          onProgress: (done, total) => {
            const percent = Math.floor((100 * done) / total);
            if (done < total && percent === lastPercent) return;
            lastPercent = percent;
            chat().setIndexStatus(done < total ? { hash, done, total } : null);
          },
        },
      );
      endIndex({ pages: index?.pages.length ?? 0, complete: !!index?.complete });
      if (disposed.current) return;
      chat().setIndexStatus(null);
      chat().setBookNotation(
        index?.notation
          ? {
              hash,
              text: index.notation,
              ...(index.notationPage ? { page: index.notationPage } : {}),
            }
          : null,
      );
    })().catch((e) => {
      console.warn('index: book index failed', e);
      if (!disposed.current) chat().setIndexStatus(null);
    });
  };

  // The reading state, loaded once and written whenever it changes, for the
  // tools to filter by. Page turns are written after a short pause.
  useEffect(() => {
    if (!bookHash) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let lastWritten = '';
    // Nothing is written before the stored state is read: the first page turn
    // would otherwise replace a further page read with the current one.
    let loaded = false;
    stateLoaded.current = false;
    const writeNow = async () => {
      if (!loaded) return;
      const reading = readingOf(useChatStore.getState(), bookHash);
      if (!reading) return;
      const { hash: _hash, ...state } = reading;
      const content = JSON.stringify(state);
      if (content === lastWritten) return;
      const { invoke } = await import('@tauri-apps/api/core');
      try {
        await invoke('book_state_write', {
          hash: bookHash,
          content: JSON.stringify({ ...state, updatedAt: Date.now() }),
        });
        lastWritten = content;
      } catch (e) {
        console.warn('reading state: write failed', e);
      }
    };
    // One write at a time, in order: two in flight could land the older last.
    let chain = Promise.resolve();
    const write = () => {
      chain = chain.then(writeNow);
      return chain;
    };
    void (async () => {
      try {
        const { invoke } = await import('@tauri-apps/api/core');
        const raw = await invoke<string | null>('book_state_load', { hash: bookHash });
        if (cancelled) return;
        loaded = true;
        stateLoaded.current = true;
        if (!raw) {
          // A book never read here: it starts at the page on screen.
          const current = readingOf(useChatStore.getState(), bookHash);
          if (current?.currentPage) {
            useChatStore.getState().updateReading(bookHash, { maxPage: current.currentPage });
          }
          void write();
          return;
        }
        const stored = JSON.parse(raw) as { maxPage?: number; spoilersAllowed?: boolean };
        const current = readingOf(useChatStore.getState(), bookHash);
        useChatStore.getState().updateReading(bookHash, {
          // The stored value, not the page the book reopened on: that may be
          // the index where the reader last looked something up.
          maxPage: stored.maxPage || current?.currentPage || 0,
          spoilersAllowed: Boolean(stored.spoilersAllowed),
          // A window opened for a turn never outlives the app.
          allowedWindow: null,
        });
      } catch (e) {
        // Left unwritten: a page turn must not replace a state that could
        // not be read with a smaller one.
        console.warn('reading state: load failed', e);
      }
    })();
    const unsubscribe = useChatStore.subscribe((s, before) => {
      const now = s.readings[bookHash];
      const was = before.readings[bookHash];
      if (!now || now === was) return;
      const urgent =
        now.allowedWindow !== was?.allowedWindow || now.spoilersAllowed !== was?.spoilersAllowed;
      if (timer) clearTimeout(timer);
      // A permission is written at once: the question follows right after.
      timer = setTimeout(() => void write(), urgent ? 0 : 400);
    });
    return () => {
      cancelled = true;
      unsubscribe();
      if (timer) clearTimeout(timer);
      void write();
    };
  }, [bookHash]);

  useEffect(() => {
    disposed.current = false;
    useChatStore.getState().setContextPages([], bookKey);
    useChatStore.getState().setContextPending(false);
    return () => {
      disposed.current = true;
      windowRun.current += 1;
      pendingWindow.current = null;
      pendingChapter.current = null;
      // Only this book's context: another one open beside it keeps its own.
      useChatStore.getState().releaseContext(bookKey);
      // Only this book's: another one open beside it keeps its own.
      const hash = bookKey.split('-')[0] ?? '';
      const chat = useChatStore.getState();
      if (chat.indexStatus?.hash === hash) chat.setIndexStatus(null);
      if (chat.bookNotation?.hash === hash) chat.setBookNotation(null);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (chatOpen) runChapterExtraction();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chatOpen]);

  // The chat is about to send a question and needs the chapter now.
  useEffect(() => {
    if (chapterRequest > 0) extractPendingChapter();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chapterRequest]);

  useAutoFocus<HTMLDivElement>({ ref: containerRef });

  useEffect(() => {
    const timer = setTimeout(() => setToastMessage(''), 2000);
    return () => clearTimeout(timer);
  }, [toastMessage]);

  useUICSS(bookKey);
  useProgressAutoSave(bookKey);
  useSelectionProbe(bookKey);
  useBookCoverAutoSave(bookKey);
  const progressRelocateHandler = (event: Event) => {
    const detail = (event as CustomEvent).detail;
    const atEnd = viewRef.current?.renderer.atEnd || false;
    const { current, next, total } = detail.location as PageInfo;
    const currentPage = atEnd && total > 0 ? total - 1 : current;
    const pageInfo = { current: currentPage, next, total };
    if (firstRelocate.current) {
      firstRelocate.current = false;
      perfMark('book:first-relocate', { bookKey, page: currentPage, total });
      // Well after the first page: opening a book is the one wait allowed.
      setTimeout(() => {
        if (!disposed.current) startBookIndex();
      }, 3000);
    }
    setProgress(
      bookKey,
      detail.cfi,
      detail.tocItem,
      detail.section,
      pageInfo,
      detail.time,
      detail.range,
    );

    // Update chat store with current chapter context
    try {
      const bookData = getBookData(bookKey);
      const chapterTitle = detail.tocItem?.label || '';
      const bookTitle = bookData?.book?.title || '';
      const bookAuthor = bookData?.book?.author || '';

      // Reading position, sent to the model with every question.
      // A PDF counts pages; the location counter is in the renderer's own
      // units (135 / 278 on page 202 of 417).
      const isFixed = bookDoc.rendition?.layout === 'pre-paginated';
      const pageIndex = (detail.section as PageInfo | undefined)?.current;
      // The furthest page read, for the anti-spoiler (rule and reasons in
      // utils/readingProgress.ts).
      if (pageIndex !== undefined) {
        const reading = readingOf(useChatStore.getState(), bookHash);
        useChatStore.getState().updateReading(bookHash, {
          currentPage: pageIndex + 1,
          maxPage: nextMaxPage({
            known: reading?.maxPage ?? 0,
            previous: reading?.currentPage ?? 0,
            page: pageIndex + 1,
            loaded: stateLoaded.current,
          }),
          fixedLayout: isFixed,
        });
      }
      useChatStore
        .getState()
        .setPosition(
          isFixed && pageIndex !== undefined
            ? `p. ${pageIndex + 1} / ${bookDoc.sections.length}`
            : pageInfo.total > 0
              ? `page ${currentPage + 1} / ${pageInfo.total}`
              : '',
        );

      if (isFixed) {
        // One section is one page. The window is re-centred once the reader is
        // a few pages away from its centre, and only the new pages travel.
        const page = (detail.section as PageInfo | undefined)?.current ?? currentPage;
        // No chapter text for a fixed-layout book: the pages are the context.
        useChatStore.getState().updateBookContext(bookTitle, bookAuthor, chapterTitle, '');
        const center = windowCenter.current;
        if (center === null || Math.abs(page - center) > CONTEXT_PAGE_RECENTER) {
          windowCenter.current = page;
          pendingWindow.current = page;
          useChatStore.getState().setContextPending(true);
          if (useChatStore.getState().isOpen) runChapterExtraction();
        }
        return;
      }

      if (useChatStore.getState().contextPages.length) useChatStore.getState().setContextPages([]);

      // Resolve to top-level chapter so we cache at chapter granularity,
      // not subsection — navigating between 5.1 and 5.2 won't re-extract
      const toc = bookDoc.toc ?? [];
      const topLevel = detail.tocItem ? findTopLevelAncestor(toc, detail.tocItem) : null;
      const chapterHref = topLevel?.href || detail.tocItem?.href || '';

      // Only re-extract when the top-level chapter actually changes
      if (chapterHref && chapterHref !== lastChapterHref.current) {
        lastChapterHref.current = chapterHref;
        // Update immediately with title (text arrives async)
        useChatStore.getState().updateBookContext(bookTitle, bookAuthor, chapterTitle, '');
        pendingChapter.current = {
          tocItem: detail.tocItem,
          toc,
          bookTitle,
          bookAuthor,
          chapterTitle,
          sectionIdx: (detail.section as PageInfo | undefined)?.current,
        };
        useChatStore.getState().setContextPending(true);
        // Extract now only if the chat is open; otherwise defer until it opens.
        if (useChatStore.getState().isOpen) runChapterExtraction();
      } else if (
        !pendingChapter.current &&
        chapterCut.current !== null &&
        ((detail.section as PageInfo | undefined)?.current ?? 0) + CONTEXT_PAGE_AHEAD >
          chapterCut.current
      ) {
        // Same chapter, but the text sent stops near where the reader now is:
        // extract it again, up to the new furthest section.
        pendingChapter.current = {
          tocItem: detail.tocItem,
          toc,
          bookTitle,
          bookAuthor,
          chapterTitle,
          sectionIdx: (detail.section as PageInfo | undefined)?.current,
        };
        useChatStore.getState().setContextPending(true);
        if (useChatStore.getState().isOpen) runChapterExtraction();
      } else if (pendingChapter.current) {
        // Same chapter, extraction still deferred: keep the window centered on the reader
        pendingChapter.current.sectionIdx = (detail.section as PageInfo | undefined)?.current;
        pendingChapter.current.chapterTitle = chapterTitle;
        if (useChatStore.getState().isOpen) runChapterExtraction();
      } else {
        // Same chapter — just update metadata
        const { currentChapterText } = useChatStore.getState();
        useChatStore.getState().updateBookContext(bookTitle, bookAuthor, chapterTitle, currentChapterText);
      }
    } catch {
      // Best-effort context extraction
    }
  };

  const getDocTransformHandler = ({ width, height }: { width: number; height: number }) => {
    return (event: Event) => {
      const { detail } = event as CustomEvent;
      detail.data = Promise.resolve(detail.data)
        .then((data) => {
          const viewSettings = getViewSettings(bookKey);
          const bookData = getBookData(bookKey);
          if (viewSettings && detail.type === 'text/css')
            return transformStylesheet(data, width, height, viewSettings.vertical);
          const isHtml = detail.type === 'application/xhtml+xml' || detail.type === 'text/html';
          if (viewSettings && bookData && isHtml) {
            const ctx: TransformContext = {
              bookKey,
              viewSettings,
              width,
              height,
              isFixedLayout: bookData.isFixedLayout,
              primaryLanguage: bookData.book?.primaryLanguage,
              userLocale: getLocale(),
              content: data,
              sectionHref: detail.name,
              transformers: [
                'style',
                'punctuation',
                'footnote',
                'whitespace',
                'language',
                'sanitizer',
              ],
            };
            return Promise.resolve(transformContent(ctx));
          }
          return data;
        })
        .catch((e) => {
          console.error(new Error(`Failed to load ${detail.name}`, { cause: e }));
          return '';
        });
    };
  };

  const skipToReadingPosition = useCallback(() => {
    const view = getView(bookKey);
    const progress = getProgress(bookKey);
    if (view && progress) {
      view.renderer.scrollToAnchor?.(progress.range);
    }
  }, [getView, getProgress, bookKey]);

  const docLoadHandler = (event: Event) => {
    docLoaded.current = true;
    if (bookDoc.rendition?.layout === 'pre-paginated') {
      setLoading(false); // Fixed layout doesn't emit 'stabilized' event
    }
    const detail = (event as CustomEvent).detail;

    if (detail.doc) {
      const writingDir = viewRef.current?.renderer.setStyles && getDirection(detail.doc);
      const viewSettings = getViewSettings(bookKey)!;
      const bookData = getBookData(bookKey)!;

      const newVertical =
        writingDir?.vertical || viewSettings.writingMode.includes('vertical') || false;
      const newRtl =
        writingDir?.rtl ||
        getDirFromUILanguage() === 'rtl' ||
        viewSettings.writingMode.includes('rl') ||
        false;
      if (viewSettings.vertical !== newVertical || viewSettings.rtl !== newRtl) {
        viewSettings.vertical = newVertical;
        viewSettings.rtl = newRtl;
        setViewSettings(bookKey, { ...viewSettings });
      }

      if (!bookData?.isFixedLayout) {
        mountAdditionalFonts(detail.doc, isCJKLang(bookData.book?.primaryLanguage));
      }

      getLoadedFonts().forEach((font) => {
        mountCustomFont(detail.doc, font);
      });

      if (bookDoc.rendition?.layout === 'pre-paginated') {
        applyFixedlayoutStyles(detail.doc, viewSettings);
      }

      applyImageStyle(detail.doc);
      applyTableStyle(detail.doc);
      applyThemeModeClass(detail.doc, isDarkMode);
      applyScrollModeClass(detail.doc, viewSettings.scrolled || false);
      applyScrollbarStyle(document, viewSettings.hideScrollbar || false);
      keepTextAlignment(detail.doc);
      handleA11yNavigation(viewRef.current, detail.doc, detail.index, {
        skipToLastPosCallback: skipToReadingPosition,
        skipToLastPosLabel: _('Skip to last reading position'),
      });

      // Inline scripts in tauri platforms are not executed by default
      if (viewSettings.allowScript && isTauriAppPlatform()) {
        evalInlineScripts(detail.doc);
      }

      // only call on load if we have highlighting turned on.
      if (viewSettings.codeHighlighting) {
        manageSyntaxHighlighting(detail.doc, viewSettings);
      }

      setTimeout(() => {
        const sectionIndex = detail.index;
        const booknotes = config.booknotes || [];
        booknotes
          .filter(
            (item) =>
              !item.deletedAt &&
              item.type === 'annotation' &&
              item.style &&
              getIndexFromCfi(item.cfi) === sectionIndex,
          )
          .map((annotation) => {
            try {
              viewRef.current?.addAnnotation(annotation);
            } catch (_err) {

            }
          });
      }, 100);

      if (!detail.doc.isEventListenersAdded) {
        // listened events in iframes are posted to the main window
        // and then used by useMouseEvent and useTouchEvent
        // and more gesture events can be detected in the iframeEventHandlers
        detail.doc.isEventListenersAdded = true;
        detail.doc.addEventListener('keydown', handleKeydown.bind(null, bookKey));
        detail.doc.addEventListener('keyup', handleKeyup.bind(null, bookKey));
        detail.doc.addEventListener('mousedown', handleMousedown.bind(null, bookKey));
        detail.doc.addEventListener('mouseup', handleMouseup.bind(null, bookKey));
        detail.doc.addEventListener('click', handleClick.bind(null, bookKey, doubleClickDisabled));
        detail.doc.addEventListener('wheel', handleWheel.bind(null, bookKey));
        detail.doc.addEventListener('touchstart', handleTouchStart.bind(null, bookKey));
        detail.doc.addEventListener('touchmove', handleTouchMove.bind(null, bookKey));
        detail.doc.addEventListener('touchend', handleTouchEnd.bind(null, bookKey));
        addLongPressListeners(bookKey, detail.doc);
      }
    }
  };

  const evalInlineScripts = (doc: Document) => {
    if (doc.defaultView && doc.defaultView.frameElement) {
      const iframe = doc.defaultView.frameElement as HTMLIFrameElement;
      const scripts = doc.querySelectorAll('script:not([src])');
      scripts.forEach((script, index) => {
        const scriptContent = script.textContent || script.innerHTML;
        try {

          iframe.contentWindow?.eval(scriptContent);
        } catch (error) {
          console.error(`Error executing iframe script ${index + 1}:`, error);
        }
      });
    }
  };

  const stabilizedHandler = useCallback(() => {
    setLoading(false);
  }, []);

  const docRelocateHandler = (event: Event) => {
    const detail = (event as CustomEvent).detail;
    if (detail.reason !== 'scroll' && detail.reason !== 'page') return;

    const parallelViews = getParallels(bookKey);
    if (parallelViews && parallelViews.size > 0) {
      parallelViews.forEach((key) => {
        if (key !== bookKey) {
          const target = getView(key)?.renderer;
          if (target) {
            target.goTo?.({ index: detail.index, anchor: detail.fraction });
          }
        }
      });
    }
  };

  const { handlePageFlip, handleContinuousScroll } = usePagination(bookKey, viewRef, containerRef);
  const mouseHandlers = useMouseEvent(bookKey, handlePageFlip, handleContinuousScroll);
  const touchHandlers = useTouchEvent(bookKey, handlePageFlip, handleContinuousScroll);

  const [selectedImage, setSelectedImage] = useState<string | null>(null);
  const [selectedTableHtml, setSelectedTableHtml] = useState<string | null>(null);
  const [imageList, setImageList] = useState<{ src: string; cfi: string | null }[]>([]);
  const [currentImageIndex, setCurrentImageIndex] = useState<number>(0);

  const handleImagePress = useCallback(async (src: string) => {
    try {
      // Get all images from the current document
      const docs = viewRef.current?.renderer.getContents();
      const allImages: { src: string; cfi: string | null }[] = [];

      docs?.forEach(({ doc, index }) => {
        const elements = doc.querySelectorAll('img, svg');
        elements.forEach((el) => {
          if (index === undefined) return;
          if (el.localName === 'img') {
            const img = el as HTMLImageElement;
            if (img.src && img.parentNode) {
              const range = doc.createRange();
              range.selectNodeContents(img);
              const cfi = viewRef.current?.getCFI(index, range) || null;
              allImages.push({ src: img.src, cfi });
            }
          } else if (el.localName === 'svg') {
            const svg = el as unknown as SVGSVGElement;
            const svgImage = svg.querySelector('image');
            const href =
              svgImage?.getAttribute('href') ||
              svgImage?.getAttributeNS('http://www.w3.org/1999/xlink', 'href');
            if (href) {
              const range = doc.createRange();
              range.selectNodeContents(svg);
              const cfi = viewRef.current?.getCFI(index, range) || null;
              allImages.push({ src: href, cfi });
            }
          }
        });
      });

      // Find the index of the pressed image
      const index = allImages.findIndex((img) => img.src === src);

      setImageList(allImages);
      setCurrentImageIndex(index >= 0 ? index : 0);

      const dataUrl = await convertBlobUrlToDataUrl(src);
      setSelectedImage(dataUrl);
    } catch (error) {
      console.error('Failed to load image:', error);
    }
  }, []);

  const handleTablePress = useCallback((html: string) => {
    setSelectedTableHtml(html);
  }, []);

  const handlePreviousImage = useCallback(async () => {
    if (currentImageIndex > 0 && imageList.length > 0) {
      const newIndex = currentImageIndex - 1;
      setCurrentImageIndex(newIndex);
      try {
        const { src, cfi } = imageList[newIndex]!;
        const dataUrl = await convertBlobUrlToDataUrl(src);
        setSelectedImage(dataUrl);
        if (cfi && viewRef.current) {
          viewRef.current?.goTo(cfi);
        }
      } catch (error) {
        console.error('Failed to load previous image:', error);
      }
    }
  }, [currentImageIndex, imageList]);

  const handleNextImage = useCallback(async () => {
    if (currentImageIndex < imageList.length - 1 && imageList.length > 0) {
      const newIndex = currentImageIndex + 1;
      setCurrentImageIndex(newIndex);
      try {
        const { src, cfi } = imageList[newIndex]!;
        const dataUrl = await convertBlobUrlToDataUrl(src);
        setSelectedImage(dataUrl);
        if (cfi && viewRef.current) {
          viewRef.current?.goTo(cfi);
        }
      } catch (error) {
        console.error('Failed to load next image:', error);
      }
    }
  }, [currentImageIndex, imageList]);

  const handleCloseImage = useCallback(() => {
    setSelectedImage(null);
    setImageList([]);
    setCurrentImageIndex(0);
  }, []);

  useLongPressEvent(bookKey, handleImagePress, handleTablePress);

  useFoliateEvents(viewRef.current, {
    onLoad: docLoadHandler,
    onStabilized: stabilizedHandler,
    onRelocate: progressRelocateHandler,
    onRendererRelocate: docRelocateHandler,
  });

  useEffect(() => {
    if (isViewCreated.current) return;
    isViewCreated.current = true;

    setTimeout(() => setLoading(true), 200);

    const openBook = async () => {

      await import('foliate-js/view.js');
      const view = wrappedFoliateView(document.createElement('foliate-view') as FoliateView);
      view.id = `foliate-view-${bookKey}`;
      containerRef.current?.appendChild(view);

      const viewSettings = getViewSettings(bookKey)!;
      const writingMode = viewSettings.writingMode;
      if (writingMode) {
        const settingsDir = getBookDirFromWritingMode(writingMode);
        const languageDir = getBookDirFromLanguage(bookDoc.metadata.language);
        if (settingsDir !== 'auto') {
          bookDoc.dir = settingsDir;
        } else if (languageDir !== 'auto') {
          bookDoc.dir = languageDir;
        }
      }

      if (bookDoc.rendition?.layout === 'pre-paginated' && bookDoc.sections) {
        bookDoc.rendition.spread = viewSettings.spreadMode;
        const coverSide = bookDoc.dir === 'rtl' ? 'right' : 'left';
        bookDoc.sections[0]!.pageSpread = viewSettings.keepCoverSpread ? '' : coverSide;
      }

      const endViewOpen = perfSpan('book:view-open', { bookKey });
      await view.open(bookDoc);
      endViewOpen({ sections: bookDoc.sections?.length, layout: bookDoc.rendition?.layout });
      // make sure we can listen renderer events after opening book
      viewRef.current = view;
      setFoliateView(bookKey, view);

      const { book } = view;

      book.transformTarget?.addEventListener('load', async (event: Event) => {
        const { detail } = event as CustomEvent<{
          isScript: boolean;
          type: string;
          href: string;
          url?: string;
          allow?: boolean;
        }>;
        if (detail.isScript) {
          detail.allow = viewSettings.allowScript ?? false;
        }
        if (isFontType(detail.type) && detail.href?.startsWith('fonts/')) {
          const fontFileName = detail.href.split('/').pop()?.toLowerCase();
          getAvailableFonts().forEach(async (font) => {
            const customFontFileName = font.path.split('/').pop()?.toLowerCase();
            if (fontFileName && fontFileName === customFontFileName) {
              if (!font.loaded) {
                const loadedFont = await loadFont(envConfig, font.id);
                font.blobUrl = loadedFont?.blobUrl;
              }
              if (font.blobUrl) {
                detail.url = font.blobUrl;
              }
            }
          });
        }
      });
      const viewWidth = appService?.isMobile ? screen.width : window.innerWidth;
      const viewHeight = appService?.isMobile ? screen.height : window.innerHeight;
      const width = viewWidth - insets.left - insets.right;
      const height = viewHeight - insets.top - insets.bottom;
      book.transformTarget?.addEventListener('data', getDocTransformHandler({ width, height }));
      view.renderer.setStyles?.(getStyles(viewSettings));

      doubleClickDisabled.current = viewSettings.disableDoubleClick!;
      const animated = viewSettings.animated!;
      const maxColumnCount = viewSettings.maxColumnCount!;
      const maxInlineSize = getMaxInlineSize(viewSettings);
      const maxBlockSize = viewSettings.maxBlockSize!;
      const screenOrientation = viewSettings.screenOrientation!;
      if (appService?.isMobileApp) {
        await lockScreenOrientation({ orientation: screenOrientation });
      }
      if (animated) {
        view.renderer.setAttribute('animated', '');
      } else {
        view.renderer.removeAttribute('animated');
      }
      if (bookDoc?.rendition?.layout === 'pre-paginated') {
        view.renderer.setAttribute('zoom', viewSettings.zoomMode);
        view.renderer.setAttribute('spread', viewSettings.spreadMode);
        view.renderer.setAttribute('scale-factor', viewSettings.zoomLevel);
      } else {
        view.renderer.setAttribute('max-column-count', maxColumnCount);
        view.renderer.setAttribute('max-inline-size', `${maxInlineSize}px`);
        view.renderer.setAttribute('max-block-size', `${maxBlockSize}px`);
      }
      applyMarginAndGap();

      const lastLocation = config.location;
      if (lastLocation) {
        perfMark('book:init-start', { bookKey, lastLocation: String(lastLocation).slice(0, 80) });
        await view.init({ lastLocation });
      } else {
        perfMark('book:init-start', { bookKey, lastLocation: null });
        await view.goToFraction(0);
      }
      setViewInited(bookKey, true);
      perfMark('book:view-inited', { bookKey });
    };

    perfMark('book:open-start', { bookKey });
    openBook();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const applyMarginAndGap = () => {
    const viewSettings = getViewSettings(bookKey)!;
    const viewInsets = getViewInsets(viewSettings);
    const showDoubleBorder = viewSettings.vertical && viewSettings.doubleBorder;
    const showDoubleBorderHeader = showDoubleBorder && viewSettings.showHeader;
    const showDoubleBorderFooter = showDoubleBorder && viewSettings.showFooter;
    const showTopHeader = viewSettings.showHeader && !viewSettings.vertical;
    const showBottomFooter = viewSettings.showFooter && !viewSettings.vertical;
    const moreTopInset = showTopHeader ? Math.max(0, 44 - insets.top) : 0;
    const moreBottomInset = showBottomFooter
      ? Math.max(0, 52 - insets.bottom)
      : 0;
    const moreRightInset = showDoubleBorderHeader ? 32 : 0;
    const moreLeftInset = showDoubleBorderFooter ? 32 : 0;
    const topMargin = (showTopHeader ? insets.top : viewInsets.top) + moreTopInset;
    const rightMargin = insets.right + moreRightInset;
    const bottomMargin = (showBottomFooter ? insets.bottom : viewInsets.bottom) + moreBottomInset;
    const leftMargin = insets.left + moreLeftInset;
    const viewMargins = viewSettings.showMarginsOnScroll && viewSettings.scrolled;

    viewRef.current?.renderer.setAttribute('margin-top', `${viewMargins ? 0 : topMargin}px`);
    viewRef.current?.renderer.setAttribute('margin-right', `${rightMargin}px`);
    viewRef.current?.renderer.setAttribute('margin-bottom', `${viewMargins ? 0 : bottomMargin}px`);
    viewRef.current?.renderer.setAttribute('margin-left', `${leftMargin}px`);
    if (viewMargins) {
      const showBarsOnScroll = viewSettings.showBarsOnScroll;
      const headerVisible = showTopHeader && showBarsOnScroll;
      const footerVisible = showBottomFooter && showBarsOnScroll;
      const safeBottomPadding = appService?.hasSafeAreaInset ? gridInsets.bottom * 0.33 : 0;
      const footerBarHeight = 52 + safeBottomPadding;
      const scrollTop = headerVisible ? gridInsets.top + 44 : 0;
      const scrollBottom = footerVisible ? footerBarHeight : 0;
      setScrollMargins({ top: scrollTop, bottom: scrollBottom });
    } else {
      setScrollMargins({ top: 0, bottom: 0 });
    }
    viewRef.current?.renderer.setAttribute('gap', `${viewSettings.gapPercent}%`);
    if (viewSettings.scrolled) {
      viewRef.current?.renderer.setAttribute('flow', 'scrolled');
    }
  };

  useEffect(() => {
    if (viewRef.current && viewRef.current.renderer) {
      const viewSettings = getViewSettings(bookKey)!;
      viewRef.current.renderer.setStyles?.(getStyles(viewSettings));
      const docs = viewRef.current.renderer.getContents();
      docs.forEach(({ doc }) => {
        if (bookDoc.rendition?.layout === 'pre-paginated') {
          applyFixedlayoutStyles(doc, viewSettings);
        }
        applyThemeModeClass(doc, isDarkMode);
        applyScrollModeClass(doc, viewSettings.scrolled || false);
        applyScrollbarStyle(document, viewSettings.hideScrollbar || false);
      });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    themeCode,
    isDarkMode,
    viewSettings?.scrolled,
    viewSettings?.overrideColor,
    viewSettings?.invertImgColorInDark,
    viewSettings?.hideScrollbar,
  ]);

  useEffect(() => {
    const mountCustomFonts = async () => {
      await loadCustomFonts(envConfig);
      getLoadedFonts().forEach((font) => {
        mountCustomFont(document, font);
        const docs = viewRef.current?.renderer.getContents();
        docs?.forEach(({ doc }) => mountCustomFont(doc, font));
      });
    };
    if (settings.customFonts) {
      mountCustomFonts();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settings.customFonts, envConfig]);

  useEffect(() => {
    if (!viewSettings) return;
    applyBackgroundTexture(envConfig, viewSettings);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    viewSettings?.backgroundTextureId,
    viewSettings?.backgroundOpacity,
    viewSettings?.backgroundSize,
    applyBackgroundTexture,
  ]);

  useEffect(() => {
    if (viewRef.current && viewRef.current.renderer) {
      doubleClickDisabled.current = !!viewSettings?.disableDoubleClick;
    }
  }, [viewSettings?.disableDoubleClick]);

  useEffect(() => {
    if (viewRef.current && viewRef.current.renderer && viewSettings) {
      applyMarginAndGap();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    insets.top,
    insets.right,
    insets.bottom,
    insets.left,
    viewSettings?.doubleBorder,
    viewSettings?.showHeader,
    viewSettings?.showFooter,
    viewSettings?.showBarsOnScroll,
    viewSettings?.showMarginsOnScroll,
    viewSettings?.scrolled,
  ]);

  return (
    <>
      {selectedImage && (
        <ImageViewer
          gridInsets={gridInsets}
          src={selectedImage}
          onClose={handleCloseImage}
          onPrevious={currentImageIndex > 0 ? handlePreviousImage : undefined}
          onNext={currentImageIndex < imageList.length - 1 ? handleNextImage : undefined}
        />
      )}
      {selectedTableHtml && (
        <TableViewer
          gridInsets={gridInsets}
          html={selectedTableHtml}
          isDarkMode={isDarkMode}
          onClose={() => setSelectedTableHtml(null)}
        />
      )}
      <div
        ref={containerRef}
        role='main'
        aria-label={_('Book Content')}
        className={clsx(
          'foliate-viewer absolute h-[100%] w-[100%] focus:outline-none',
          viewState?.loading && 'bg-base-100',
        )}
        style={{
          paddingTop: scrollMargins.top,
          paddingBottom: scrollMargins.bottom,
        }}
        {...mouseHandlers}
        {...touchHandlers}
      />
      {((!docLoaded.current && loading) || viewState?.loading) && (
        <div className='bg-base-100/85 absolute left-0 top-0 z-10 flex h-full w-full items-center justify-center'>
          <Spinner loading={true} />
        </div>
      )}
    </>
  );
};

export default FoliateViewer;
