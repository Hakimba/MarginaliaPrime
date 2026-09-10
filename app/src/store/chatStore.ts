import { create } from 'zustand';
import { persist } from 'zustand/middleware';

import { DEFAULT_BACKEND_ID, DEFAULT_MODEL_ID } from '@/services/engine';
import type { EngineSelection } from '@/services/engine';

interface ChatState {
  isOpen: boolean;
  isPinned: boolean;
  panelWidth: number;
  /**
   * Selections waiting to be sent. A list from the start: composing several
   * passages into one question is the point of the next task, and the engine
   * already accepts them.
   */
  pendingSelections: EngineSelection[];

  bookTitle: string;
  bookAuthor: string;
  bookHash: string;
  currentChapter: string;
  currentChapterText: string;
  /** Reading position label, e.g. "p. 30 / 417". */
  position: string;
  /**
   * Bumped when the chat needs the chapter text now rather than when the
   * reader next goes idle. The viewer owns the extraction and watches this.
   */
  chapterRequest: number;

  conversationId: string;

  /** Model backend, e.g. 'claude'. A second one is planned for Codex. */
  backendId: string;
  modelId: string;
  webSearchEnabled: boolean;

  togglePanel: () => void;
  setOpen: (open: boolean) => void;
  setPinned: (pinned: boolean) => void;
  setPanelWidth: (width: number) => void;
  addSelection: (selection: EngineSelection) => void;
  removeSelection: (index: number) => void;
  clearSelections: () => void;
  updateBookContext: (title: string, author: string, chapter: string, chapterText: string) => void;
  setPosition: (position: string) => void;
  requestChapter: () => void;
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
      isPinned: false,
      panelWidth: 380,
      pendingSelections: [],

      bookTitle: '',
      bookAuthor: '',
      bookHash: '',
      currentChapter: '',
      currentChapterText: '',
      position: '',
      chapterRequest: 0,

      conversationId: generateId(),

      backendId: DEFAULT_BACKEND_ID,
      modelId: DEFAULT_MODEL_ID,
      webSearchEnabled: false,

      togglePanel: () => set((s) => ({ isOpen: !s.isOpen })),
      setOpen: (open) => set({ isOpen: open }),
      setPinned: (pinned) => set({ isPinned: pinned }),
      setPanelWidth: (width) => set({ panelWidth: width }),
      addSelection: (selection) =>
        set((s) => ({ pendingSelections: [...s.pendingSelections, selection] })),
      removeSelection: (index) =>
        set((s) => ({ pendingSelections: s.pendingSelections.filter((_, i) => i !== index) })),
      clearSelections: () => set({ pendingSelections: [] }),
      updateBookContext: (title, author, chapter, chapterText) =>
        set({
          bookTitle: title,
          bookAuthor: author,
          currentChapter: chapter,
          currentChapterText: chapterText,
        }),
      setPosition: (position) => set({ position }),
      requestChapter: () => set((s) => ({ chapterRequest: s.chapterRequest + 1 })),
      setBookHash: (hash) => set({ bookHash: hash }),
      setConversationId: (id) => set({ conversationId: id }),
      setModel: (backendId, modelId) => set({ backendId, modelId }),
      setWebSearchEnabled: (enabled) => set({ webSearchEnabled: enabled }),
    }),
    {
      name: 'marginalia-chat',
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
