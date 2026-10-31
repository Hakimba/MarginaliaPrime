import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { BookDoc } from '@/libs/document';
import { addToGlossary, loadGlossary, type GlossaryEntry } from '@/services/glossary';
import { useGlossaryStore } from '@/store/glossaryStore';
import GlossaryView from './GlossaryView';

const boundary = vi.hoisted(() => ({ goTo: vi.fn(), fixed: true }));
vi.mock('@/services/glossary', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/services/glossary')>()),
  loadGlossary: vi.fn(),
  addToGlossary: vi.fn(),
}));
vi.mock('@/store/readerStore', () => ({ useReaderStore: {
  getState: () => ({ getProgress: () => ({ section: { current: 1 } }), getView: () => ({ goTo: boundary.goTo }) }),
} }));
vi.mock('@/store/bookDataStore', () => ({
  useBookDataStore: (select: (state: { getBookData: () => { isFixedLayout: boolean } }) => unknown) => select({ getBookData: () => ({ isFixedLayout: boundary.fixed }) }),
}));

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
const bookDoc = { sections: Array.from({ length: 5 }) } as BookDoc;
const entry: GlossaryEntry = { term: '⊤', latex: '\\top', explanation: 'Le type sommet.', page: 2, date: 1 };
let root: ReturnType<typeof createRoot>;
let host: HTMLDivElement;

async function render(bookKey = 'a-view') {
  await act(async () => root.render(<GlossaryView key={bookKey} bookKey={bookKey} bookDoc={bookDoc} />));
}

async function click(text: string) {
  const button = Array.from(host.querySelectorAll('button')).find((b) => b.textContent === text);
  if (!button) throw new Error(`Missing button: ${text}`);
  await act(async () => button.click());
}

async function fill(label: string, value: string) {
  const wrapper = Array.from(host.querySelectorAll('label')).find((l) => l.textContent?.startsWith(label));
  const field = wrapper?.querySelector('input,textarea');
  if (!(field instanceof HTMLInputElement || field instanceof HTMLTextAreaElement)) throw new Error(`Missing field: ${label}`);
  const prototype = field instanceof HTMLInputElement ? HTMLInputElement.prototype : HTMLTextAreaElement.prototype;
  await act(async () => {
    Object.getOwnPropertyDescriptor(prototype, 'value')?.set?.call(field, value);
    field.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

beforeEach(() => {
  vi.resetAllMocks();
  boundary.fixed = true;
  vi.mocked(loadGlossary).mockResolvedValue([]);
  vi.mocked(addToGlossary).mockResolvedValue([entry]);
  useGlossaryStore.setState({ books: {}, focusRequest: null });
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
});

it('adds a Unicode entry manually, renders its math and navigates to its definition', async () => {
  await render();
  expect(host.textContent).toContain('Aucun terme pour ce livre');
  await click('Ajouter un terme');
  await fill('Terme ou symbole', '⊤');
  await fill('LaTeX facultatif', '\\top');
  await fill('Explication', 'Le type sommet.');
  await click('Enregistrer');
  expect(addToGlossary).toHaveBeenCalledWith('a', { term: '⊤', latex: '\\top', explanation: 'Le type sommet.', page: 2 });
  expect(host.querySelector('.katex')).not.toBeNull();
  expect(host.querySelector('form')).toBeNull();
  await click('p. 2');
  expect(boundary.goTo).toHaveBeenCalledWith(1);
});

it('retains the draft and shows the actual error on failed save, then retries', async () => {
  vi.mocked(addToGlossary).mockRejectedValueOnce(new Error('Disque plein')).mockResolvedValueOnce([entry]);
  await render();
  await click('Ajouter un terme');
  await fill('Terme ou symbole', '⊤');
  await fill('Explication', 'Le type sommet.');
  await click('Enregistrer');
  expect(host.textContent).toContain('Disque plein');
  expect(host.querySelector('input')?.value).toBe('⊤');
  await click('Enregistrer');
  expect(host.querySelector('form')).toBeNull();
});

it('uses an EPUB section for navigation and clears a manual draft on book switch', async () => {
  boundary.fixed = false;
  vi.mocked(loadGlossary).mockResolvedValue([entry]);
  await render();
  await click('section 2');
  expect(boundary.goTo).toHaveBeenCalledWith(1);
  await click('Ajouter un terme');
  await fill('Terme ou symbole', 'brouillon');
  await render('b-view');
  expect(host.querySelector('form')).toBeNull();
  expect(loadGlossary).toHaveBeenLastCalledWith('b');
});

it('consumes a glossary reference after focusing it, so a future book switch cannot replay it', async () => {
  vi.mocked(loadGlossary).mockResolvedValue([entry]);
  Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', { value: vi.fn(), configurable: true });
  useGlossaryStore.getState().focus('a', '⊤');
  await render();
  expect(document.activeElement?.getAttribute('data-glossary-term')).toBe('⊤');
  expect(useGlossaryStore.getState().focusRequest).toBeNull();
  Reflect.deleteProperty(HTMLElement.prototype, 'scrollIntoView');
});
