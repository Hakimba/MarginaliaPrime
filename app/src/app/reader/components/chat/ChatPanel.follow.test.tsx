import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Engine, EngineEvent, EngineStartInfo } from '@/services/engine';
import type { ChatMessage, ConversationMeta } from '@/services/chat/persistence';
import { useChatStore } from '@/store/chatStore';
import { useSidebarStore } from '@/store/sidebarStore';
import { useGlossaryStore } from '@/store/glossaryStore';
import type { GlossaryEntry } from '@/services/glossary';
import ChatPanel from './ChatPanel';

const boundary = vi.hoisted(() => ({
  listeners: new Set<(event: EngineEvent) => void>(),
  startGate: Promise.resolve(),
  loadGate: Promise.resolve(),
  transcripts: new Map<string, ChatMessage[]>(),
  send: vi.fn<Engine['send']>().mockResolvedValue(undefined),
  glossary: vi.fn<(hash: string) => Promise<GlossaryEntry[]>>().mockResolvedValue([]),
  resumeSession: undefined as string | undefined,
}));

vi.mock('@/services/glossary', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/services/glossary')>(),
  loadGlossary: boundary.glossary,
}));

vi.mock('@/services/engine/claudeCliEngine', () => ({
  claudeBinaryInfo: vi.fn().mockResolvedValue({}),
  ClaudeCliEngine: class implements Engine {
    readonly backendId = 'claude';
    running = false;
    async start(): Promise<EngineStartInfo> {
      await boundary.startGate;
      this.running = true;
      return { binary: 'fixture', args: [], cwd: '/fixture', harness: '' };
    }
    send = boundary.send;
    plan() { return { includeChapter: false, pages: [] }; }
    async abort() { this.running = false; }
    isRunning() { return this.running; }
    sessionId() { return null; }
    wasResumed() { return false; }
    subscribe(listener: (event: EngineEvent) => void) {
      boundary.listeners.add(listener);
      return () => boundary.listeners.delete(listener);
    }
  },
}));

vi.mock('@/services/chat/persistence', () => ({
  loadConversationIndex: async (): Promise<ConversationMeta[]> => [
    { id: 'recent', name: 'Recent', createdAt: 1, lastMessageAt: 20, messageCount: 6, engineSessionId: boundary.resumeSession },
    { id: 'older', name: 'Older', createdAt: 1, lastMessageAt: 10, messageCount: 6 },
  ],
  loadMessages: async (hash: string, id: string) => {
    await boundary.loadGate;
    return boundary.transcripts.get(`${hash}/${id}`) ?? [];
  },
  saveMessages: vi.fn().mockResolvedValue(undefined),
  saveConversationIndex: vi.fn().mockResolvedValue(undefined),
  deleteConversation: vi.fn().mockResolvedValue(undefined),
}));

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
const initialChat = useChatStore.getState();
const initialSidebar = useSidebarStore.getState();
const viewportSelector = '.chat-panel > .overflow-y-auto';
const history = Array.from({ length: 6 }, (_, index): ChatMessage => ({
  role: index % 2 ? 'assistant' : 'user',
  content: `Historical message ${index + 1}.`,
  timestamp: index + 1,
}));
let root: ReturnType<typeof createRoot>;
let host: HTMLDivElement;
let restoreGeometry: () => void;

function viewport() {
  const element = host.querySelector(viewportSelector);
  if (!(element instanceof HTMLDivElement)) throw new Error('Missing chat transcript viewport');
  return element;
}

function bubbleTexts() {
  return Array.from(viewport().querySelectorAll('.chat-bubble'), (bubble) => bubble.textContent?.trim());
}

// jsdom has no layout. Each real bubble contributes a fixed row and text height;
// writes clamp as a browser would, including the old end-marker scrollIntoView.
function installGeometry() {
  const offsets = new WeakMap<HTMLElement, number>();
  const originalScrollIntoView = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'scrollIntoView');
  vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockImplementation(function (this: HTMLElement) {
    return this.matches(viewportSelector) ? 300 : 0;
  });
  vi.spyOn(HTMLElement.prototype, 'scrollHeight', 'get').mockImplementation(function (this: HTMLElement) {
    if (!this.matches(viewportSelector)) return 0;
    return Math.max(300, Array.from(this.querySelectorAll('.chat-bubble'))
      .reduce((height, bubble) => height + 100 + (bubble.textContent?.length ?? 0) * 5, 0));
  });
  vi.spyOn(HTMLElement.prototype, 'scrollTop', 'get').mockImplementation(function (this: HTMLElement) {
    return Math.min(offsets.get(this) ?? 0, Math.max(0, this.scrollHeight - this.clientHeight));
  });
  vi.spyOn(HTMLElement.prototype, 'scrollTop', 'set').mockImplementation(function (this: HTMLElement, value: number) {
    offsets.set(this, Math.max(0, Math.min(value, this.scrollHeight - this.clientHeight)));
  });
  Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', {
    configurable: true,
    value(this: HTMLElement) {
      const target = this.closest(viewportSelector);
      if (target instanceof HTMLElement) target.scrollTop = target.scrollHeight;
    },
  });
  return () => {
    if (originalScrollIntoView) Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', originalScrollIntoView);
    else Reflect.deleteProperty(HTMLElement.prototype, 'scrollIntoView');
  };
}

async function scrollTo(top: number) {
  await act(async () => {
    viewport().scrollTop = top;
    viewport().dispatchEvent(new Event('scroll'));
  });
}

async function emit(event: EngineEvent) {
  expect(boundary.listeners.size).toBeGreaterThan(0);
  await act(async () => {
    for (const listener of boundary.listeners) listener(event);
  });
}

async function ask(question: string) {
  await act(async () => useChatStore.getState().requestAsk(question));
}

function expectBottom() {
  expect(viewport().scrollTop).toBe(viewport().scrollHeight - viewport().clientHeight);
}

beforeEach(async () => {
  vi.useFakeTimers();
  boundary.listeners.clear();
  boundary.send.mockClear();
  boundary.glossary.mockReset().mockResolvedValue([]);
  boundary.resumeSession = undefined;
  useGlossaryStore.setState({ books: {}, focusRequest: null });
  boundary.startGate = Promise.resolve();
  boundary.loadGate = Promise.resolve();
  boundary.transcripts.clear();
  boundary.transcripts.set('book/recent', history);
  boundary.transcripts.set('book/older', history.map(message => ({ ...message, content: `Older ${message.content}` })));
  boundary.transcripts.set('next/recent', history.map(message => ({ ...message, content: `Next ${message.content}` })));
  useChatStore.setState({ ...initialChat, isOpen: true, contextPending: false });
  useSidebarStore.setState({ ...initialSidebar, sideBarBookKey: 'book-view' });
  restoreGeometry = installGeometry();
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  await act(async () => root.render(<ChatPanel />));
  expect(bubbleTexts()).toEqual(history.map(message => message.content));
  expectBottom();
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  restoreGeometry();
  vi.restoreAllMocks();
  vi.clearAllTimers();
  vi.useRealTimers();
  useChatStore.setState(initialChat);
  useSidebarStore.setState(initialSidebar);
});

describe('ChatPanel transcript following', () => {
  it('keeps the turn busy while recovering an expired CLI session', async () => {
    boundary.resumeSession = 'expired-session';
    await act(async () => useSidebarStore.getState().setSideBarBookKey('next-view'));
    await ask('A question to recover');
    let resumeStartup = () => {};
    boundary.startGate = new Promise<void>((resolve) => { resumeStartup = resolve; });
    await emit({ kind: 'error', message: 'Session not found', fatal: true });
    await ask('Must wait for the recovered answer');
    expect(boundary.send).toHaveBeenCalledTimes(1);
    await act(async () => resumeStartup());
    expect(boundary.send).toHaveBeenCalledTimes(2);
    await ask('Still busy');
    expect(boundary.send).toHaveBeenCalledTimes(2);
    await emit({ kind: 'done', text: 'Recovered answer.' });
    await ask('Now available');
    expect(boundary.send).toHaveBeenCalledTimes(3);
  });

  it('can send again after a streaming conversation is replaced', async () => {
    await ask('Old question');
    await emit({ kind: 'text', text: 'Interrupted answer' });
    const previousListeners = Array.from(boundary.listeners);
    await act(async () => useChatStore.getState().updateReading('book', { allowedWindow: [20, 21] }));
    const newConversation = host.querySelector('button[title="Nouvelle conversation"]');
    if (!(newConversation instanceof HTMLButtonElement)) throw new Error('Missing new conversation button');
    await act(async () => newConversation.click());
    expect(useChatStore.getState().readings['book']?.allowedWindow).toBeNull();
    await ask('New question');
    expect(boundary.send).toHaveBeenCalledTimes(2);
    await emit({ kind: 'text', text: 'New answer' });
    expect(bubbleTexts()).toEqual(['New question', 'New answer']);
    for (const previous of previousListeners) expect(boundary.listeners.has(previous)).toBe(false);
  });

  it('refreshes memory after a matched tool result and recalls it in another conversation', async () => {
    const entry: GlossaryEntry = { term: '⊤', latex: '\\top', explanation: 'Le type sommet.', page: 2, date: 1 };
    await ask('Que signifie ⊤ ?');
    expect(boundary.send.mock.calls.at(-1)?.[1].glossaryTerms).toEqual([]);
    const loads = boundary.glossary.mock.calls.length;
    await emit({ kind: 'tool_use', id: 'add', name: 'mcp__reader__add_to_glossary' });
    await emit({ kind: 'tool_use', id: 'search', name: 'mcp__reader__search_book' });
    await emit({ kind: 'tool_result', id: 'search', isError: false });
    expect(boundary.glossary).toHaveBeenCalledTimes(loads);
    boundary.glossary.mockResolvedValue([entry, { ...entry, term: 'Futur', page: 50 }]);
    await emit({ kind: 'tool_result', id: 'add', isError: false });
    expect(useGlossaryStore.getState().books['book']?.entries).toHaveLength(2);
    await emit({ kind: 'done', text: 'Le type sommet. [⊤](#glossary-%E2%8A%A4)' });
    const link = host.querySelector('a[href="#glossary-%E2%8A%A4"]');
    if (!(link instanceof HTMLAnchorElement)) throw new Error('Missing glossary reference');
    await act(async () => link.click());
    expect(useSidebarStore.getState().isSideBarVisible).toBe(true);
    expect(useGlossaryStore.getState().focusRequest).toMatchObject({ hash: 'book', term: '⊤' });
    const newConversation = host.querySelector('button[title="Nouvelle conversation"]');
    if (!(newConversation instanceof HTMLButtonElement)) throw new Error('Missing new conversation button');
    await act(async () => {
      useChatStore.getState().updateReading('book', { maxPage: 2, currentPage: 2 });
      newConversation.click();
    });
    await ask('Que signifie ⊤ à nouveau ?');
    expect(boundary.send.mock.calls.at(-1)?.[1].glossaryTerms).toEqual(['⊤']);
  });

  it('abandons a pending send when its book changes during glossary loading', async () => {
    let resolveLoad: (value: GlossaryEntry[]) => void = () => {};
    boundary.glossary.mockImplementation((hash) => hash === 'book' ? new Promise((resolve) => { resolveLoad = resolve; }) : Promise.resolve([]));
    await ask('A question for the old book');
    await act(async () => useSidebarStore.getState().setSideBarBookKey('next-view'));
    await act(async () => resolveLoad([]));
    expect(boundary.send).not.toHaveBeenCalled();
    expect(bubbleTexts()).not.toContain('A question for the old book');
  });

  it('follows growth at the bottom, then preserves old history through fragments and final replacement', async () => {
    await ask('A new question');
    await emit({ kind: 'text', text: 'First fragment. ' });
    expectBottom();
    const oldBubble = viewport().querySelector('.chat-bubble');
    await scrollTo(120);
    await emit({ kind: 'text', text: 'Second fragment.' });
    expect(viewport().scrollTop).toBe(120);
    expect(bubbleTexts()).toEqual([...history.map(message => message.content), 'A new question', 'First fragment. Second fragment.']);
    await emit({ kind: 'done', text: 'First fragment. Second fragment. Final chunk.' });
    expect(viewport().scrollTop).toBe(120);
    expect(bubbleTexts()).toEqual([...history.map(message => message.content), 'A new question', 'First fragment. Second fragment. Final chunk.']);
    expect(viewport().querySelector('.chat-bubble')).toBe(oldBubble);
  });

  it('holds a small upward scroll before the next streamed fragment can pull it back', async () => {
    await ask('Continue');
    await emit({ kind: 'text', text: 'Beginning. ' });
    const readingPosition = viewport().scrollTop - 21;
    await scrollTo(readingPosition);
    await emit({ kind: 'text', text: 'A new fragment grows the answer.' });
    expect(viewport().scrollTop).toBe(readingPosition);
    expect(bubbleTexts()).toEqual([...history.map(message => message.content), 'Continue', 'Beginning. A new fragment grows the answer.']);
  });

  it('resumes following on returning within 32 pixels of the bottom, using intent before growth', async () => {
    await ask('Continue');
    await emit({ kind: 'text', text: 'Beginning. ' });
    await scrollTo(viewport().scrollHeight - viewport().clientHeight - 33);
    const held = viewport().scrollTop;
    await emit({ kind: 'text', text: 'Still reading history. ' });
    expect(viewport().scrollTop).toBe(held);
    await scrollTo(viewport().scrollHeight - viewport().clientHeight - 32);
    await emit({ kind: 'text', text: 'A large enough fragment to grow by more than thirty-two pixels.' });
    expectBottom();
    await emit({ kind: 'done', text: '' });
    expectBottom();
    expect(bubbleTexts()).toEqual([...history.map(message => message.content), 'Continue', 'Beginning. Still reading history. A large enough fragment to grow by more than thirty-two pixels.']);
  });

  it('a valid send resumes following, while an empty or duplicate send leaves reader intent alone', async () => {
    await scrollTo(120);
    await ask('');
    expect(boundary.send).not.toHaveBeenCalled();
    expect(viewport().scrollTop).toBe(120);
    await ask('Accepted question');
    expectBottom();
    await emit({ kind: 'text', text: 'Answer begins. ' });
    await scrollTo(120);
    await ask('Duplicate while streaming');
    await emit({ kind: 'text', text: 'Answer ends.' });
    expect(viewport().scrollTop).toBe(120);
    expect(boundary.send).toHaveBeenCalledTimes(1);
    expect(bubbleTexts()).toEqual([...history.map(message => message.content), 'Accepted question', 'Answer begins. Answer ends.']);
  });

  it('a user scroll after accepting a send overrides follow while engine startup is pending', async () => {
    let releaseStart = () => {};
    boundary.startGate = new Promise<void>(resolve => { releaseStart = resolve; });
    await scrollTo(120);
    await ask('Delayed question');
    expect(boundary.send).not.toHaveBeenCalled();
    await scrollTo(100);
    await act(async () => releaseStart());
    expect(boundary.send).toHaveBeenCalledTimes(1);
    expect(viewport().scrollTop).toBe(100);
    await emit({ kind: 'text', text: 'Delayed answer.' });
    expect(viewport().scrollTop).toBe(100);
    expect(bubbleTexts()).toEqual([...history.map(message => message.content), 'Delayed question', 'Delayed answer.']);
  });

  it('follows committed conversation and book replacements and reopened transcript DOM', async () => {
    await scrollTo(120);
    let releaseLoad = () => {};
    boundary.loadGate = new Promise<void>(resolve => { releaseLoad = resolve; });
    const selector = host.querySelector('.chat-panel select:not([title])');
    if (!(selector instanceof HTMLSelectElement)) throw new Error('Missing conversation selector');
    await act(async () => {
      selector.value = 'older';
      selector.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await scrollTo(100);
    await act(async () => releaseLoad());
    expectBottom();
    expect(bubbleTexts()).toEqual(history.map(message => `Older ${message.content}`));
    await scrollTo(120);
    await act(async () => useSidebarStore.getState().setSideBarBookKey('next-view'));
    expectBottom();
    expect(bubbleTexts()).toEqual(history.map(message => `Next ${message.content}`));
    await scrollTo(120);
    const oldViewport = viewport();
    await act(async () => useChatStore.getState().setOpen(false));
    expect(host.querySelector(viewportSelector)).toBeNull();
    await act(async () => useChatStore.getState().setOpen(true));
    expect(viewport()).not.toBe(oldViewport);
    expectBottom();
    expect(bubbleTexts()).toEqual(history.map(message => `Next ${message.content}`));
    const newConversation = host.querySelector('button[title="Nouvelle conversation"]');
    if (!(newConversation instanceof HTMLButtonElement)) throw new Error('Missing new conversation button');
    await act(async () => newConversation.click());
    expect(bubbleTexts()).toEqual([]);
    expect(viewport().scrollTop).toBe(0);
    await ask('Fresh conversation');
    await emit({ kind: 'text', text: 'Fresh answer.' });
    expectBottom();
    expect(bubbleTexts()).toEqual(['Fresh conversation', 'Fresh answer.']);
  });
});
