import { create } from 'zustand';
import { addToGlossary, loadGlossary, type GlossaryEntry, type GlossaryInput } from '@/services/glossary';

type GlossaryLoad =
  | { kind: 'loading' | 'ready'; entries: GlossaryEntry[] }
  | { kind: 'error'; entries: GlossaryEntry[]; message: string };

interface GlossaryState {
  books: Record<string, GlossaryLoad>;
  focusRequest: { hash: string; term: string; seq: number } | null;
  reload: (hash: string) => Promise<GlossaryEntry[]>;
  add: (hash: string, entry: GlossaryInput) => Promise<void>;
  focus: (hash: string, term: string) => void;
  acknowledgeFocus: (seq: number) => void;
}

const messageOf = (error: unknown): string => error instanceof Error ? error.message : String(error);

export const useGlossaryStore = create<GlossaryState>((set, get) => {
  const generations = new Map<string, number>();
  const queues = new Map<string, Promise<GlossaryEntry[]>>();
  let focusSequence = 0;
  /**
   * `inputError`: the operation is an add, whose failure is a refused input,
   * not a glossary that failed to load: the book keeps its entries, ready.
   */
  const update = async (
    hash: string,
    operation: () => Promise<GlossaryEntry[]>,
    inputError = false,
  ) => {
    const generation = (generations.get(hash) ?? 0) + 1;
    generations.set(hash, generation);
    const entries = get().books[hash]?.entries ?? [];
    set((s) => ({ books: { ...s.books, [hash]: { kind: 'loading', entries } } }));
    const pending = (queues.get(hash) ?? Promise.resolve()).catch(() => {}).then(operation);
    queues.set(hash, pending);
    try {
      const loaded = await pending;
      if (generations.get(hash) === generation) {
        set((s) => ({ books: { ...s.books, [hash]: { kind: 'ready', entries: loaded } } }));
      }
      return loaded;
    } catch (error) {
      if (generations.get(hash) === generation) {
        set((s) => {
          const entries = s.books[hash]?.entries ?? [];
          return {
            books: {
              ...s.books,
              [hash]: inputError
                ? { kind: 'ready', entries }
                : { kind: 'error', entries, message: messageOf(error) },
            },
          };
        });
      }
      throw error;
    } finally {
      if (queues.get(hash) === pending) queues.delete(hash);
    }
  };
  return {
    books: {},
    focusRequest: null,
    reload: (hash) => update(hash, () => loadGlossary(hash)),
    add: async (hash, entry) => {
      await update(hash, () => addToGlossary(hash, entry), true);
    },
    focus: (hash, term) => set({ focusRequest: { hash, term, seq: ++focusSequence } }),
    acknowledgeFocus: (seq) => set((s) => s.focusRequest?.seq === seq ? { focusRequest: null } : {}),
  };
});
