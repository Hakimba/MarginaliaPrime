import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useGlossaryStore } from './glossaryStore';
import { addToGlossary, loadGlossary, type GlossaryEntry } from '@/services/glossary';

vi.mock('@/services/glossary', () => ({ loadGlossary: vi.fn(), addToGlossary: vi.fn() }));
const entry: GlossaryEntry = { term: '⊤', latex: '\\top', explanation: 'Le type sommet.', page: 2, date: 1 };

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

beforeEach(() => {
  vi.resetAllMocks();
  useGlossaryStore.setState({ books: {}, focusRequest: null });
});

describe('per-book glossary operations', () => {
  it('keeps different books independent when loads finish backwards', async () => {
    const first = deferred<GlossaryEntry[]>();
    vi.mocked(loadGlossary).mockImplementation((hash) => hash === 'a' ? first.promise : Promise.resolve([]));
    const a = useGlossaryStore.getState().reload('a');
    await useGlossaryStore.getState().reload('b');
    first.resolve([entry]);
    await a;
    expect(useGlossaryStore.getState().books['a']?.entries).toEqual([entry]);
    expect(useGlossaryStore.getState().books['b']?.entries).toEqual([]);
  });

  it('loads after an in-flight write so the panel cannot regress to a stale list', async () => {
    const write = deferred<GlossaryEntry[]>();
    vi.mocked(addToGlossary).mockReturnValue(write.promise);
    vi.mocked(loadGlossary).mockResolvedValue([entry]);
    const add = useGlossaryStore.getState().add('a', entry);
    const reload = useGlossaryStore.getState().reload('a');
    await Promise.resolve();
    expect(loadGlossary).not.toHaveBeenCalled();
    write.resolve([entry]);
    await Promise.all([add, reload]);
    expect(useGlossaryStore.getState().books['a']).toEqual({ kind: 'ready', entries: [entry] });
  });

  it('retains known entries on a failed reload and permits a retry', async () => {
    useGlossaryStore.setState({ books: { a: { kind: 'ready', entries: [entry] } } });
    vi.mocked(loadGlossary).mockRejectedValueOnce(new Error('JSON illisible')).mockResolvedValueOnce([entry]);
    await expect(useGlossaryStore.getState().reload('a')).rejects.toThrow('JSON illisible');
    expect(useGlossaryStore.getState().books['a']).toEqual({ kind: 'error', entries: [entry], message: 'JSON illisible' });
    await useGlossaryStore.getState().reload('a');
    expect(useGlossaryStore.getState().books['a']?.kind).toBe('ready');
  });

  it('keeps the glossary ready when an add is refused: the input failed, not the glossary', async () => {
    useGlossaryStore.setState({ books: { a: { kind: 'ready', entries: [entry] } } });
    vi.mocked(addToGlossary).mockRejectedValueOnce(new Error('La page 9 dépasse les 5 du livre.'));
    await expect(useGlossaryStore.getState().add('a', { term: 'x', latex: '', explanation: 'd', page: 9 }))
      .rejects.toThrow('dépasse');
    expect(useGlossaryStore.getState().books['a']).toEqual({ kind: 'ready', entries: [entry] });
  });
});
