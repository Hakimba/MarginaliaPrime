import { create } from 'zustand';
import { persist } from 'zustand/middleware';

import { DEFAULT_BACKEND_ID, DEFAULT_MODEL_ID } from '@/services/engine';
import type { ContextPage, EngineSelection } from '@/services/engine';

/** A selection waiting in the chat, with what the reader chose to send of it. */
export interface PendingSelection extends EngineSelection {
  id: string;
  /** Section of the book, for the chip: "6.5 Gaussian Distribution". */
  section?: string;
  /** What was picked, when it has a name: "(6.82)", "zone". */
  label?: string;
  /** The reader took the image out: only the text goes. */
  imageOff?: boolean;
}

export type NewSelection = Omit<PendingSelection, 'id' | 'imageOff'>;

/** "6.5 Gaussian Distribution · p. 202 · (6.82)": the location the model reads. */
export const selectionLocation = ({ section, page, label }: NewSelection): string =>
  [section, page ? `p. ${page}` : '', label].filter(Boolean).join(' · ');

/** Same passage, same place: adding it again adds nothing. */
const samePassage = (a: PendingSelection, b: NewSelection): boolean =>
  a.text.trim() === b.text.trim() &&
  a.page === b.page &&
  a.section === b.section &&
  a.label === b.label;

interface ChatState {
  isOpen: boolean;
  isPinned: boolean;
  panelWidth: number;
  /**
   * Selections waiting to be sent, in the order they were added: the reader
   * refers to them by number (①, ②) in the question.
   */
  pendingSelections: PendingSelection[];

  bookTitle: string;
  bookAuthor: string;
  bookHash: string;
  currentChapter: string;
  currentChapterText: string;
  /** Fixed-layout books: the text of the pages around the reader. */
  contextPages: ContextPage[];
  /** The book whose reader owns the context above, side by side with others. */
  contextOwner: string;
  /** The reading context is being extracted; a question should wait for it. */
  contextPending: boolean;
  /** Reading position label, e.g. "p. 30 / 417". */
  position: string;
  /**
   * Bumped when the chat needs the chapter text now rather than when the
   * reader next goes idle. The viewer owns the extraction and watches this.
   */
  chapterRequest: number;
  /**
   * A question to send right away, with the pending selections: the reader
   * asked from the page (Ctrl+E) rather than from the panel. `seq` tells two
   * identical requests apart.
   */
  askRequest: { question: string; seq: number } | null;

  conversationId: string;

  /** Model backend, e.g. 'claude'. A second one is planned for Codex. */
  backendId: string;
  modelId: string;
  webSearchEnabled: boolean;

  togglePanel: () => void;
  setOpen: (open: boolean) => void;
  setPinned: (pinned: boolean) => void;
  setPanelWidth: (width: number) => void;
  addSelection: (selection: NewSelection) => void;
  removeSelection: (index: number) => void;
  toggleSelectionImage: (id: string) => void;
  clearSelections: () => void;
  setContextPages: (pages: ContextPage[], owner?: string) => void;
  /** Drop the context, if it is still this book's. */
  releaseContext: (owner: string) => void;
  setContextPending: (pending: boolean) => void;
  updateBookContext: (title: string, author: string, chapter: string, chapterText: string) => void;
  setPosition: (position: string) => void;
  requestChapter: () => void;
  requestAsk: (question: string) => void;
  setBookHash: (hash: string) => void;
  setConversationId: (id: string) => void;
  setModel: (backendId: string, modelId: string) => void;
  setWebSearchEnabled: (enabled: boolean) => void;
}

function generateId(): string {
  return Date.now().toString(36) + Math.random().toString(36).substring(2, 8);
}

export const useChatStore = create<ChatState>()(
  persist(
    (set) => ({
      isOpen: false,
      // Docked by default: the panel takes its own width and the page is laid
      // out next to it, instead of covering the text being read.
      isPinned: true,
      panelWidth: 380,
      pendingSelections: [],

      bookTitle: '',
      bookAuthor: '',
      bookHash: '',
      currentChapter: '',
      currentChapterText: '',
      contextPages: [],
      contextOwner: '',
      contextPending: false,
      position: '',
      chapterRequest: 0,
      askRequest: null,

      conversationId: generateId(),

      backendId: DEFAULT_BACKEND_ID,
      modelId: DEFAULT_MODEL_ID,
      webSearchEnabled: false,

      togglePanel: () => set((s) => ({ isOpen: !s.isOpen })),
      setOpen: (open) => set({ isOpen: open }),
      setPinned: (pinned) => set({ isPinned: pinned }),
      setPanelWidth: (width) => set({ panelWidth: width }),
      addSelection: (selection) =>
        set((s) => {
          const same = s.pendingSelections.find((p) => samePassage(p, selection));
          // Asked again after the image failed: the new one has it.
          if (same && selection.imageBase64 && !same.imageBase64) {
            return {
              pendingSelections: s.pendingSelections.map((p) =>
                p === same ? { ...p, imageBase64: selection.imageBase64 } : p,
              ),
            };
          }
          return same
            ? {}
            : {
                pendingSelections: [
                  ...s.pendingSelections,
                  {
                    ...selection,
                    location: selection.location ?? selectionLocation(selection),
                    id: generateId(),
                  },
                ],
              };
        }),
      removeSelection: (index) =>
        set((s) => ({ pendingSelections: s.pendingSelections.filter((_, i) => i !== index) })),
      toggleSelectionImage: (id) =>
        set((s) => ({
          pendingSelections: s.pendingSelections.map((p) =>
            p.id === id ? { ...p, imageOff: !p.imageOff } : p,
          ),
        })),
      clearSelections: () => set({ pendingSelections: [] }),
      setContextPages: (pages, owner) =>
        set((s) => ({ contextPages: pages, contextOwner: owner ?? s.contextOwner })),
      releaseContext: (owner) =>
        set((s) =>
          s.contextOwner === owner
            ? { contextPages: [], contextOwner: '', contextPending: false }
            : {},
        ),
      setContextPending: (pending) => set({ contextPending: pending }),
      updateBookContext: (title, author, chapter, chapterText) =>
        set({
          bookTitle: title,
          bookAuthor: author,
          currentChapter: chapter,
          currentChapterText: chapterText,
        }),
      setPosition: (position) => set({ position }),
      requestChapter: () => set((s) => ({ chapterRequest: s.chapterRequest + 1 })),
      requestAsk: (question) =>
        set((s) => ({ askRequest: { question, seq: (s.askRequest?.seq ?? 0) + 1 } })),
      setBookHash: (hash) => set({ bookHash: hash }),
      setConversationId: (id) => set({ conversationId: id }),
      setModel: (backendId, modelId) => set({ backendId, modelId }),
      setWebSearchEnabled: (enabled) => set({ webSearchEnabled: enabled }),
    }),
    {
      name: 'marginalia-chat',
      // 2: the panel docks instead of covering the reader.  Readers who had
      // the old default stored keep a floating panel otherwise.
      version: 2,
      migrate: (state, version) =>
        version < 2 ? { ...(state as object), isPinned: true } : state,
      partialize: (state) => ({
        isOpen: state.isOpen,
        isPinned: state.isPinned,
        panelWidth: state.panelWidth,
        backendId: state.backendId,
        modelId: state.modelId,
        webSearchEnabled: state.webSearchEnabled,
      }),
    },
  ),
);
