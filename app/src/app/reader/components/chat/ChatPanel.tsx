'use client';

import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from 'react';
import { FiCode, FiGlobe, FiImage, FiPlus, FiSearch, FiSend, FiTrash2, FiX } from 'react-icons/fi';
import { BsPin, BsPinFill } from 'react-icons/bs';
import clsx from 'clsx';
import 'katex/dist/katex.min.css';

import { useChatStore, type PendingSelection } from '@/store/chatStore';
import { perfMark } from '@/utils/perf';
import { useSidebarStore } from '@/store/sidebarStore';
import { useReaderStore } from '@/store/readerStore';

import {
  ClaudeCliEngine,
  buildTurnMessage,
  buildTurnText,
  claudeBinaryInfo,
  findModel,
  pageRanges,
  planContext,
} from '@/services/engine';
import type {
  ContextPlan,
  Engine,
  EngineContext,
  EngineEvent,
  EngineStartInfo,
  EngineUsage,
} from '@/services/engine';
import {
  deleteConversation,
  loadConversationIndex,
  loadMessages,
  saveConversationIndex,
  saveMessages,
  type ChatMessage,
  type ConversationMeta,
} from '@/services/chat/persistence';
import { renderChatMarkdown } from '@/services/chat/markdown';
import { splitTranscriptions } from '@/services/chat/transcriptions';
import { circled } from '../../utils/formulaOverlay';
import { attachPassage } from '../../utils/selectionToChat';
import { getTextFromRange } from '@/utils/sel';
import ModelSelector from './ModelSelector';
import InspectOverlay, { type InspectData } from './InspectOverlay';

/** Where a scripted smoke scenario parks its remaining steps across a reload. */
const SMOKE_RESUME_KEY = 'marginalia-smoke-resume';

function generateId(): string {
  return Date.now().toString(36) + Math.random().toString(36).substring(2, 8);
}

/**
 * One answer, rendered once. Without the memo every streamed chunk rendered
 * the whole transcript again, formulas included.
 */
const ChatMarkdown = React.memo(function ChatMarkdown({ content }: { content: string }) {
  const html = useMemo(() => renderChatMarkdown(content), [content]);
  return (
    <div
      className='chat-markdown prose prose-sm max-w-none'
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
});

type SentItem = NonNullable<NonNullable<ChatMessage['selection']>['items']>[number];

/** The passages of a sent message, older messages included (images only). */
const itemsOf = (message: ChatMessage | undefined): SentItem[] => {
  const selection = message?.role === 'user' ? message.selection : undefined;
  if (!selection) return [];
  if (selection.items) return selection.items;
  if (selection.images?.length) return selection.images.map((image) => ({ text: '', image }));
  return [{ text: selection.text, location: selection.chapter }];
};

/** An image rendered at 3 px per point, shown about the size it has on the page. */
const PageImage: React.FC<{ image: string; alt: string; className?: string }> = ({
  image,
  alt,
  className,
}) => (
  <img
    src={`data:image/png;base64,${image}`}
    alt={alt}
    onLoad={(e) => {
      const img = e.currentTarget;
      img.style.width = `${Math.round(img.naturalWidth * 0.45)}px`;
    }}
    className={clsx('max-w-full rounded bg-white p-1', className)}
  />
);

/**
 * An answer, with the image of each passage put back above its transcription:
 * the reader checks the transcription against the page without scrolling up.
 * An answer without a transcription, or a turn without images, is left as is.
 */
const Answer: React.FC<{ content: string; items: SentItem[] }> = ({ content, items }) => {
  if (!items.some((item) => item.image)) return <ChatMarkdown content={content} />;
  return (
    <>
      {splitTranscriptions(content).map((piece, j) => {
        const image = piece.passage !== undefined ? items[piece.passage]?.image : undefined;
        return (
          <div key={j}>
            {image && (
              <PageImage
                image={image}
                alt={`Original ${(piece.passage ?? 0) + 1}`}
                className='border-base-300 mb-1 border'
              />
            )}
            <ChatMarkdown content={piece.content} />
          </div>
        );
      })}
    </>
  );
};

/** The passages a question was sent with, numbered when there were several. */
const SentPassages: React.FC<{ items: SentItem[] }> = ({ items }) => {
  if (!items.length) return null;
  return (
    <div className='mb-2 flex flex-col gap-1.5'>
      {items.map((item, k) => (
        <div key={k} className='flex items-start gap-1.5'>
          {items.length > 1 && <span className='text-xs leading-5 opacity-80'>{circled(k + 1)}</span>}
          {item.image ? (
            <PageImage image={item.image} alt={`Passage ${k + 1}`} />
          ) : (
            <div className='line-clamp-3 border-l-2 border-white/40 pl-2 text-xs italic opacity-80'>
              &ldquo;{item.text}&rdquo;
              {item.location && (
                <div className='mt-0.5 text-[10px] not-italic opacity-60'>{item.location}</div>
              )}
            </div>
          )}
        </div>
      ))}
    </div>
  );
};

/**
 * Where the reader is, and what of the book the next question takes along:
 * nothing about the context goes to the model unseen.
 */
const ContextLine: React.FC<{
  position: string;
  chapter: string;
  pending: boolean;
  plan: ContextPlan;
  hasPages: boolean;
  hasChapter: boolean;
}> = ({ position, chapter, pending, plan, hasPages, hasChapter }) => {
  const sent = plan.pages.length
    ? `p. ${pageRanges(plan.pages.map((p) => p.page))} jointes`
    : plan.includeChapter
      ? 'chapitre joint'
      : hasPages
        ? 'pages déjà transmises'
        : hasChapter
          ? 'chapitre déjà transmis'
          : '';
  const parts = [position, chapter, pending ? 'lecture du contexte…' : sent].filter(Boolean);
  if (!parts.length) return null;
  return (
    <div
      className='text-base-content/50 border-base-300 truncate border-t px-3 pt-1.5 text-[11px]'
      title={parts.join(' · ')}
    >
      {parts.join(' · ')}
    </div>
  );
};

/**
 * The range of a page's text layer that reads `wanted`, spaces ignored: what a
 * scripted scenario selects instead of dragging the mouse.
 */
const findPassage = (doc: Document, wanted: string): Range | null => {
  const layer = doc.querySelector('.textLayer');
  if (!layer) return null;
  const target = wanted.replace(/\s+/g, '');
  const chars: { node: Text; offset: number }[] = [];
  let flat = '';
  const walker = doc.createTreeWalker(layer, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode() as Text | null; node; node = walker.nextNode() as Text | null) {
    const value = node.nodeValue ?? '';
    for (let i = 0; i < value.length; i += 1) {
      if (/\s/.test(value[i]!)) continue;
      chars.push({ node, offset: i });
      flat += value[i];
    }
  }
  // "start...end": from the first start to the first end after it.
  const [head = '', tail] = target.split('...');
  const at = head ? flat.indexOf(head) : -1;
  if (at < 0) return null;
  const endAt = tail ? flat.indexOf(tail, at + head.length) : at;
  if (endAt < 0) return null;
  const first = chars[at]!;
  const last = chars[endAt + (tail ?? head).length - 1]!;
  const range = doc.createRange();
  range.setStart(first.node, first.offset);
  range.setEnd(last.node, last.offset + 1);
  return range;
};

/** Words of a passage, for the chip. */
const wordCount = (text: string): number => text.split(/\s+/).filter(Boolean).length;

/** "p. 202 · (6.82) · 6.5 Gaussian Distribution · 34 mots". */
const chipLabel = (selection: PendingSelection): string =>
  [
    selection.page ? `p. ${selection.page}` : '',
    selection.label,
    selection.section ?? (selection.page ? '' : selection.location),
    selection.label ? '' : `${wordCount(selection.text)} mots`,
  ]
    .filter(Boolean)
    .join(' · ');

/** What goes to the engine: the reader's choices applied, the chip's fields dropped. */
const toEngineSelection = ({ text, surroundingText, location, page, imageBase64, imageOff }: PendingSelection) => ({
  text,
  ...(surroundingText ? { surroundingText } : {}),
  ...(location ? { location } : {}),
  ...(page ? { page } : {}),
  ...(imageBase64 && !imageOff ? { imageBase64 } : {}),
});

const ChatPanel: React.FC = () => {
  const {
    isOpen,
    isPinned,
    panelWidth,
    pendingSelections,
    currentChapter,
    currentChapterText,
    contextPages,
    contextPending,
    position,
    bookTitle,
    bookAuthor,
    bookHash,
    conversationId,
    backendId,
    modelId,
    webSearchEnabled,
    setOpen,
    setPinned,
    setPanelWidth,
    removeSelection,
    toggleSelectionImage,
    clearSelections,
    setConversationId,
    setWebSearchEnabled,
  } = useChatStore();

  const isResizing = useRef(false);

  /**
   * The panel may never take the whole window: a width remembered from a large
   * window left the reader six pixels wide in a small one, and the pages were
   * being rendered at one percent of their size.
   */
  const maxPanelWidth = () => Math.max(280, Math.min(800, Math.round(window.innerWidth * 0.6)));
  const [windowWidth, setWindowWidth] = useState(0);
  useEffect(() => {
    const onResize = () => setWindowWidth(window.innerWidth);
    onResize();
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);
  const shownWidth = windowWidth ? Math.min(panelWidth, maxPanelWidth()) : panelWidth;

  const handleResizeStart = (e: ReactPointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.stopPropagation();
    isResizing.current = true;
    const startX = e.clientX;
    const startWidth = panelWidth;
    // Capture the pointer: without it the reader's iframe swallows the moves as
    // soon as the cursor leaves the 4-pixel handle.
    const handle = e.currentTarget;
    try {
      handle.setPointerCapture(e.pointerId);
    } catch {
      // Older engines fall back to document-level listeners below.
    }

    const onMove = (ev: globalThis.PointerEvent) => {
      const delta = startX - ev.clientX;
      setPanelWidth(Math.max(280, Math.min(maxPanelWidth(), startWidth + delta)));
    };
    const onUp = () => {
      isResizing.current = false;
      try {
        handle.releasePointerCapture(e.pointerId);
      } catch {
        // Nothing to release.
      }
      handle.removeEventListener('pointermove', onMove);
      handle.removeEventListener('pointerup', onUp);
      document.removeEventListener('pointermove', onMove);
      document.removeEventListener('pointerup', onUp);
    };
    handle.addEventListener('pointermove', onMove);
    handle.addEventListener('pointerup', onUp);
    document.addEventListener('pointermove', onMove);
    document.addEventListener('pointerup', onUp);
  };

  const { sideBarBookKey } = useSidebarStore();
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [conversations, setConversations] = useState<ConversationMeta[]>([]);
  const [input, setInput] = useState('');
  const [isStreaming, setIsStreaming] = useState(false);
  const [streamingContent, setStreamingContent] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [showInspect, setShowInspect] = useState(false);
  const [activeTool, setActiveTool] = useState<string | null>(null);
  const [startInfo, setStartInfo] = useState<EngineStartInfo | null>(null);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [lastUsage, setLastUsage] = useState<EngineUsage | undefined>(undefined);
  const [lastCostUsd, setLastCostUsd] = useState<number | undefined>(undefined);
  const [rawLines, setRawLines] = useState<string[]>([]);

  /** Show an error in the panel, and trace it for the scenario driver. */
  const reportError = useCallback((message: string) => {
    console.info(`panel error: ${message}`);
    setError(message);
  }, []);

  const engineRef = useRef<Engine | null>(null);
  /**
   * Conversation index in a ref as well as in state: the engine may start
   * before React has re-rendered with the loaded index, and it needs the
   * recorded session id to resume yesterday's conversation.
   */
  const conversationsRef = useRef<ConversationMeta[]>([]);
  /** Live copy of the transcript: the engine must not resume an empty one. */
  const messagesRef = useRef<ChatMessage[]>([]);
  /** Resolves once the conversation index for the current book is loaded. */
  const conversationsReady = useRef<Promise<void>>(Promise.resolve());
  /** Last turn sent, replayed once if a resumed session turns out to be gone. */
  const lastTurn = useRef<{ text: string; context: EngineContext } | null>(null);
  const resumeRetried = useRef(false);
  /**
   * Whether the engine currently starting was asked to resume. Recorded before
   * the process starts: a bad session id fails so fast that the error can
   * arrive before `engineRef` is even assigned.
   */
  const startedWithResume = useRef(false);
  /** Identifies the process configuration; a change means restart. */
  const engineSignature = useRef('');
  const accumulated = useRef('');
  /**
   * The debounced save still waiting to run, if any. Leaving a conversation
   * runs it at once: cancelled, it lost the answer that had just arrived when
   * the reader opened a new conversation within half a second.
   */
  const pendingSave = useRef<(() => void) | null>(null);
  /** A turn is being prepared: set before the first await of a send. */
  const sending = useRef(false);
  const flushPendingSave = () => {
    const save = pendingSave.current;
    if (save) save();
  };
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const currentBookHash = useRef<string>('');

  /**
   * Tell the reader that the CLI is missing before they type, but never during
   * book opening: probing it spawns a process, which would compete with the
   * first page render. Only when the panel is open, and only once.
   */
  const binaryChecked = useRef(false);
  useEffect(() => {
    if (!isOpen || binaryChecked.current) return;
    binaryChecked.current = true;
    const check = () =>
      claudeBinaryInfo().catch((e: unknown) => {
        setError(typeof e === 'string' ? e : e instanceof Error ? e.message : String(e));
      });
    const idle = (window as unknown as { requestIdleCallback?: (cb: () => void, o?: unknown) => void })
      .requestIdleCallback;
    if (typeof idle === 'function') idle(() => void check(), { timeout: 4000 });
    else setTimeout(() => void check(), 1000);
  }, [isOpen]);

  const model = useMemo(() => findModel(backendId, modelId), [backendId, modelId]);

  const stopEngine = useCallback(async () => {
    const engine = engineRef.current;
    engineRef.current = null;
    engineSignature.current = '';
    setStartInfo(null);
    if (engine) await engine.abort();
  }, []);

  // Switch book: load its conversations and drop the running process.
  useEffect(() => {
    if (!sideBarBookKey) return;
    const hash = sideBarBookKey.split('-')[0] || '';
    if (!hash || hash === currentBookHash.current) return;
    flushPendingSave();
    currentBookHash.current = hash;
    useChatStore.getState().setBookHash(hash);
    // Passages of the previous book would go into this book's conversation.
    useChatStore.getState().clearSelections();
    void stopEngine();

    conversationsReady.current = loadConversationIndex(hash).then((convos) => {
      conversationsRef.current = convos;
      setConversations(convos);
      const latest = [...convos].sort((a, b) => b.lastMessageAt - a.lastMessageAt)[0];
      if (!latest) {
        setConversationId(generateId());
        setMessages([]);
        return;
      }
      return loadMessages(hash, latest.id).then((loaded) => {
        if (loaded.length > 0) {
          setConversationId(latest.id);
          setMessages(loaded);
          messagesRef.current = loaded;
          return;
        }
        // Index entry with no messages on disk: drop it and start clean.
        const pruned = convos.filter((c) => c.id !== latest.id);
        conversationsRef.current = pruned;
        setConversations(pruned);
        saveConversationIndex(hash, pruned).catch(() => {});
        setConversationId(generateId());
        setMessages([]);
        messagesRef.current = [];
      });
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sideBarBookKey, setConversationId]);

  useEffect(() => {
    messagesRef.current = messages;
  }, [messages]);

  // Leaving the reader within half a second of an answer must not lose it.
  useEffect(() => () => flushPendingSave(), []);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, streamingContent]);

  // Docked, the panel takes its width from the reader instead of covering it;
  // the mark records what the page is actually left with.
  useEffect(() => {
    if (!isOpen) return;
    perfMark('chat:panel-open', {
      docked: isPinned,
      panel: shownWidth,
      reader: document.querySelector('.books-grid')?.clientWidth ?? 0,
      window: window.innerWidth,
    });
  }, [isOpen, isPinned, shownWidth]);

  useEffect(() => {
    if (isOpen) setTimeout(() => inputRef.current?.focus(), 100);
  }, [isOpen]);

  // Persist messages and the conversation index, debounced.
  const saveTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (messages.length === 0 || !bookHash || !conversationId) return;
    if (saveTimeoutRef.current) clearTimeout(saveTimeoutRef.current);
    const save = () => {
      if (saveTimeoutRef.current) clearTimeout(saveTimeoutRef.current);
      saveTimeoutRef.current = null;
      pendingSave.current = null;
      saveMessages(bookHash, conversationId, messages).catch(() => {});
      const known = conversationsRef.current.find((c) => c.id === conversationId);
      // Keep the recorded session id when this run has not started an engine
      // yet: loading a conversation triggers a save, and dropping the id here
      // would lose the ability to resume it.
      const engineSessionId = sessionId ?? known?.engineSessionId;
      const meta: ConversationMeta = {
        id: conversationId,
        name: messages[0]?.content.substring(0, 50) || 'Nouvelle conversation',
        createdAt: known?.createdAt || messages[0]?.timestamp || Date.now(),
        lastMessageAt: messages[messages.length - 1]?.timestamp || Date.now(),
        messageCount: messages.length,
        ...(engineSessionId ? { engineSessionId } : {}),
      };
      const updated = [...conversationsRef.current.filter((c) => c.id !== conversationId), meta];
      conversationsRef.current = updated;
      setConversations(updated);
      saveConversationIndex(bookHash, updated).catch(() => {});
    };
    pendingSave.current = save;
    saveTimeoutRef.current = setTimeout(save, 500);
    return () => {
      if (saveTimeoutRef.current) clearTimeout(saveTimeoutRef.current);
    };
  }, [messages, bookHash, conversationId, sessionId]);

  const onEngineEvent = useCallback((event: EngineEvent) => {
    const line = `${event.kind}: ${summarize(event)}`;
    setRawLines((prev) => [...prev.slice(-199), line]);
    // Also on the console, so the smoke test can read the whole exchange.
    console.info(`engine event: ${line}`);
    switch (event.kind) {
      case 'ready':
        setSessionId(event.sessionId);
        break;
      case 'text':
        accumulated.current += event.text;
        setStreamingContent(accumulated.current);
        break;
      case 'tool_use':
        setActiveTool(event.name);
        break;
      case 'tool_result':
        setActiveTool(null);
        break;
      case 'done': {
        const text = event.text || accumulated.current;
        accumulated.current = '';
        setStreamingContent('');
        setIsStreaming(false);
        setActiveTool(null);
        setLastUsage(event.usage);
        setLastCostUsd(event.costUsd);
        // Smoke test: continue the scripted scenario, if one is running.
        if (smokeQueue.current.length) setTimeout(() => void runSmokeStepRef.current?.(), 300);
        if (text.trim()) {
          setMessages((prev) => [
            ...prev,
            { role: 'assistant', content: text, timestamp: Date.now() },
          ]);
        } else {
          // The engine can finish a turn with nothing visible; say so rather
          // than leaving the panel looking stuck.
          setError('Le moteur a terminé sans produire de réponse. Reformule ou réessaie.');
        }
        break;
      }
      case 'rate_limit':
        setError(
          event.resetsAt
            ? `Limite d'usage atteinte (${event.status}). Réessaie après ${new Date(
                event.resetsAt * 1000,
              ).toLocaleTimeString()}.`
            : `Limite d'usage atteinte (${event.status}).`,
        );
        break;
      case 'error':
        // A resumed session the CLI no longer knows about fails before any
        // text arrives; replay the turn once on a fresh session. A refusal or
        // an API error is reported as-is: replaying it would spend the quota
        // twice and fail the same way.
        if (!/API Error/i.test(event.message) && retryWithoutResume()) break;
        reportError(event.message);
        accumulated.current = '';
        setStreamingContent('');
        setIsStreaming(false);
        setActiveTool(null);
        if (event.fatal) void stopEngine();
        break;
      case 'exit':
        if (event.code !== 0 && retryWithoutResume()) break;
        setIsStreaming(false);
        setActiveTool(null);
        // A clean exit after an answer is normal; a mid-turn exit is not.
        if (accumulated.current || streamingContentRef.current) {
          setError('Le moteur s\'est arrêté avant la fin de la réponse.');
        }
        accumulated.current = '';
        setStreamingContent('');
        engineRef.current = null;
        engineSignature.current = '';
        break;
      default:
        break;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /**
   * The CLI prunes old sessions, so `--resume` can fail on a conversation left
   * for a few weeks. When that happens before any text has arrived, restart
   * without resuming and replay the pending turn once. The local transcript is
   * still on screen; only the model's own memory of it is lost.
   */
  const retryWithoutResume = (): boolean => {
    const turn = lastTurn.current;
    if (!startedWithResume.current || resumeRetried.current || !turn) return false;
    if (accumulated.current || streamingContentRef.current) return false;
    resumeRetried.current = true;
    void (async () => {
      const fresh = await ensureEngineRef.current?.(false);
      if (!fresh) return;
      try {
        await fresh.send(turn.text, turn.context);
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
        setIsStreaming(false);
      }
    })();
    return true;
  };

  // Mirror the streaming text so the exit handler can read it without a dep.
  const streamingContentRef = useRef('');
  useEffect(() => {
    streamingContentRef.current = streamingContent;
  }, [streamingContent]);

  /** Start the backend if needed. Returns null and sets an error on failure. */
  const ensureEngine = useCallback(async (allowResume = true): Promise<Engine | null> => {
    // The index carries the session id of an earlier conversation; starting
    // before it lands would silently lose yesterday's context. Read the
    // conversation id from the store afterwards, not from this closure, which
    // may predate the index landing.
    await conversationsReady.current;
    const conversationId = useChatStore.getState().conversationId;

    const signature = `${backendId}:${model.id}:${webSearchEnabled}:${conversationId}`;
    // `allowResume: false` is the recovery path: the running process is the one
    // that just failed, so reusing it would send the turn into a dead pipe.
    if (allowResume && engineRef.current?.isRunning() && engineSignature.current === signature) {
      return engineRef.current;
    }
    await stopEngine();

    const engine = new ClaudeCliEngine();
    engine.subscribe(onEngineEvent);
    // Resuming only makes sense when the reader can see the history that the
    // model will remember. An empty transcript always starts a fresh session.
    const resume =
      allowResume && messagesRef.current.length > 0
        ? conversationsRef.current.find((c) => c.id === conversationId)?.engineSessionId
        : undefined;
    startedWithResume.current = Boolean(resume);
    console.info(
      `engine start: conversation=${conversationId} resume=${resume ?? 'none'} ` +
        `known=${conversationsRef.current.length}`,
    );
    try {
      const info = await engine.start({
        conversationId,
        bookKey: bookHash || 'default',
        model,
        webSearch: webSearchEnabled,
        harnessContext: { bookTitle, bookAuthor },
        ...(resume ? { resumeSessionId: resume } : {}),
      });
      engineRef.current = engine;
      engineSignature.current = signature;
      setStartInfo(info);
      setError(null);
      return engine;
    } catch (e) {
      reportError(e instanceof Error ? e.message : String(e));
      return null;
    }
  }, [
    backendId,
    model,
    webSearchEnabled,
    bookHash,
    bookTitle,
    bookAuthor,
    onEngineEvent,
    stopEngine,
    reportError,
  ]);

  const ensureEngineRef = useRef<((allowResume?: boolean) => Promise<Engine | null>) | null>(null);
  ensureEngineRef.current = ensureEngine;

  /** Context for the next turn, shared by send and the Inspect overlay. */
  const buildContext = useCallback((): EngineContext => {
    // Read the store, not this render's closure: the chapter text may have
    // landed while the turn was being prepared.
    const s = useChatStore.getState();
    return {
      bookTitle: s.bookTitle,
      bookAuthor: s.bookAuthor,
      chapterTitle: s.currentChapter,
      chapterText: s.currentChapterText,
      pages: s.contextPages,
      position: s.position,
      selections: s.pendingSelections.map(toEngineSelection),
    };
  }, []);

  /**
   * What the next turn adds besides the question: asked of the running
   * engine, which knows what it already sent; before it starts, everything.
   */
  const nextPlan = (context: EngineContext): ContextPlan => {
    const engine = engineRef.current;
    // A process with another configuration is replaced at the next send, and
    // the new one has sent nothing.
    const signature = `${backendId}:${model.id}:${webSearchEnabled}:${conversationId}`;
    return engine?.isRunning() && engineSignature.current === signature
      ? engine.plan(context)
      : planContext(context, { chapterKey: '', pages: new Set() });
  };

  /**
   * Send a turn. `question` comes from the page (Ctrl+E) and is sent as is;
   * the draft in the input box is left alone then.
   */
  const handleSend = async (question?: string) => {
    const fromPage = question !== undefined;
    const text = (question ?? input).trim();
    // The store, not this render: Ctrl+E adds the selection and asks at once.
    if (!text && useChatStore.getState().pendingSelections.length === 0) return;
    // Taken before the first await: the chapter wait and the engine start can
    // last two seconds, and Enter pressed meanwhile sent the turn twice, with
    // two processes answering into the same bubble.
    if (isStreaming || sending.current) return;
    sending.current = true;
    try {
      await sendTurn(text, fromPage);
    } finally {
      sending.current = false;
    }
  };

  const sendTurn = async (text: string, fromPage: boolean) => {

    // The context is extracted lazily; ask for it now and give it a moment,
    // so the very first question of a session is not sent without it.
    if (useChatStore.getState().contextPending) {
      useChatStore.getState().requestChapter();
      for (let i = 0; i < 30 && useChatStore.getState().contextPending; i += 1) {
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    }

    // Recorded before the engine starts: a failure can arrive immediately.
    const sentPending = useChatStore.getState().pendingSelections;
    const context = buildContext();
    lastTurn.current = { text, context };
    resumeRetried.current = false;

    const engine = await ensureEngine();
    if (!engine) return;
    // What the model gets is what the transcript shows, even if another
    // selection arrived while the engine was starting.
    const selections = context.selections;
    const sentIds = new Set(sentPending.map((p) => p.id));
    const userMsg: ChatMessage = {
      role: 'user',
      content: text || 'Explique ce passage.',
      timestamp: Date.now(),
      ...(selections[0]
        ? {
            selection: {
              text: selections.map((s) => s.text).join('\n\n— — —\n\n'),
              chapter: selections[0].location ?? currentChapter,
              items: selections.map((s) => ({
                text: s.text,
                ...(s.location ? { location: s.location } : {}),
                ...(s.imageBase64 ? { image: s.imageBase64 } : {}),
              })),
            },
          }
        : {}),
    };

    setMessages((prev) => [...prev, userMsg]);
    if (!fromPage) {
      setInput('');
      if (inputRef.current) inputRef.current.style.height = 'auto';
    }
    useChatStore.setState((s) => ({
      pendingSelections: s.pendingSelections.filter((p) => !sentIds.has(p.id)),
    }));
    setIsStreaming(true);
    setStreamingContent('');
    accumulated.current = '';
    setError(null);

    try {
      await engine.send(text, context);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setIsStreaming(false);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      void handleSend();
    }
    if (e.key === 'Escape') setOpen(false);
  };

  const resetConversation = async (id: string) => {
    await stopEngine();
    setConversationId(id);
    setMessages([]);
    setStreamingContent('');
    setSessionId(null);
    setLastUsage(undefined);
    setRawLines([]);
    setError(null);
  };

  const handleNewConversation = async () => {
    flushPendingSave();
    await resetConversation(generateId());
  };

  const handleDeleteConversation = async () => {
    if (bookHash && conversationId) {
      // Cancelled before anything is awaited: the debounced save firing
      // during the deletion wrote the conversation back.
      messagesRef.current = [];
      if (saveTimeoutRef.current) clearTimeout(saveTimeoutRef.current);
      pendingSave.current = null;
      await deleteConversation(bookHash, conversationId);
      const updated = conversationsRef.current.filter((c) => c.id !== conversationId);
      conversationsRef.current = updated;
      setConversations(updated);
      await saveConversationIndex(bookHash, updated).catch(() => {});
    }
    await resetConversation(generateId());
  };

  const handleAbort = () => {
    void stopEngine();
    setIsStreaming(false);
    setStreamingContent('');
    accumulated.current = '';
  };

  const handleSwitchConversation = async (id: string) => {
    if (id === conversationId) return;
    flushPendingSave();
    await stopEngine();
    setConversationId(id);
    setMessages(await loadMessages(bookHash, id));
    setStreamingContent('');
    setSessionId(conversations.find((c) => c.id === id)?.engineSessionId ?? null);
    setError(null);
  };

  /**
   * Smoke-test hook: with MARGINALIA_SMOKE_ASK set in the environment, the
   * panel opens and asks that question once the book context is loaded. It is
   * the only way to exercise the whole chain (React → Tauri → CLI → answer)
   * without a human clicking, so a release build can be checked automatically.
   */
  const smokeFired = useRef(false);
  const smokeChecked = useRef(false);
  const smokeQueue = useRef<string[]>([]);
  const runSmokeStepRef = useRef<(() => Promise<void>) | null>(null);
  useEffect(() => {
    // A PDF without an outline has a position but no chapter.
    if (smokeFired.current || smokeChecked.current || !bookHash || (!currentChapter && !position)) {
      return;
    }
    let cancelled = false;
    void (async () => {
      try {
        const { invoke } = await import('@tauri-apps/api/core');
        const question = await invoke<string>('get_environment_variable', {
          name: 'MARGINALIA_SMOKE_ASK',
        });
        // Asked once: normal use must not query the environment at every page.
        if (!question) smokeChecked.current = true;
        if (cancelled || !question || smokeFired.current) return;
        smokeFired.current = true;
        // Steps left over from a scripted book switch take precedence.
        let pending: string[] = [];
        try {
          const stored = localStorage.getItem(SMOKE_RESUME_KEY);
          if (stored) {
            pending = JSON.parse(stored) as string[];
            localStorage.removeItem(SMOKE_RESUME_KEY);
          }
        } catch {
          pending = [];
        }
        // A restored scenario has just performed its book switch; drop it so
        // the step is not replayed after the reload.
        while (pending[0]?.startsWith('book:')) pending.shift();
        smokeQueue.current = pending.length
          ? pending
          : question.split('|').map((q) => q.trim()).filter(Boolean);
        setOpen(true);
        // Let the store settle so the first turn carries chapter and position.
        setTimeout(() => void runSmokeStepRef.current?.(), 600);
      } catch {
        // Not running inside Tauri.
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bookHash, currentChapter, position]);

  const handleSendRef = useRef<((question?: string) => Promise<void>) | null>(null);
  handleSendRef.current = handleSend;

  /**
   * A question asked from the page (Ctrl+E). Sent at once; while an answer is
   * still streaming it waits in the input box instead, with its selection
   * pending, since one process cannot take two turns at a time. Consumed, so a
   * remounted panel never sends it twice.
   */
  const askRequest = useChatStore((s) => s.askRequest);
  useEffect(() => {
    if (!askRequest) return;
    useChatStore.setState({ askRequest: null });
    if (isStreaming || sending.current) {
      setInput((current) => current || askRequest.question);
      return;
    }
    void handleSendRef.current?.(askRequest.question);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [askRequest]);

  /**
   * Runs one step of a scripted smoke scenario. Steps are separated by "|" in
   * MARGINALIA_SMOKE_ASK; a step is a question unless it starts with a verb:
   *   newconv          start a new conversation
   *   delete           delete the current conversation
   *   book:<hash>      switch to another book without leaving the app
   *   model:<id>       change model mid-conversation
   *   page:<n>         go to page n of a PDF (1-based) and let the context follow
   *   select:<n>:<text> attach the passage of page n that reads <text> (spaces
   *                    ignored; "a...b" from a to b), through the same path as Ask AI
   *   toggleimg:<k>    take the image of pending passage k out, or back in
   *   remove:<k>       remove pending passage k;  clear: remove them all
   *   abort            stop the engine
   *   wait:<ms>        pause
   * Everything else is asked as a question. This is the only way to exercise
   * the panel's flows without a human clicking.
   */
  const runSmokeStep = async (): Promise<void> => {
    const step = smokeQueue.current.shift();
    if (!step) {
      console.info('smoke: scenario done');
      return;
    }
    console.info(`smoke: step ${JSON.stringify(step)}`);
    const next = () => setTimeout(() => void runSmokeStepRef.current?.(), 400);

    if (step === 'newconv') {
      await handleNewConversation();
      next();
      return;
    }
    if (step === 'delete') {
      await handleDeleteConversation();
      next();
      return;
    }
    if (step === 'abort') {
      handleAbort();
      next();
      return;
    }
    if (step.startsWith('wait:')) {
      setTimeout(() => void runSmokeStepRef.current?.(), Number(step.slice(5)) || 500);
      return;
    }
    if (step.startsWith('book:')) {
      // Hard navigation on purpose: importing the app's navigation helper into
      // this panel breaks the reader chunk at runtime. The remaining steps are
      // handed over through localStorage so the scenario survives the reload.
      try {
        localStorage.setItem(SMOKE_RESUME_KEY, JSON.stringify(smokeQueue.current));
      } catch {
        // Storage unavailable: the scenario simply stops after the switch.
      }
      window.location.href = `/reader.html?ids=${step.slice(5)}`;
      return;
    }
    if (step.startsWith('page:')) {
      const key = useSidebarStore.getState().sideBarBookKey;
      const view = key ? useReaderStore.getState().getView(key) : null;
      // One section per page: the CFI of page n is the n-th spine item.
      view?.goTo(`epubcfi(/6/${2 * Number(step.slice(5))})`);
      // The window follows at idle; the next question waits for it anyway.
      setTimeout(() => void runSmokeStepRef.current?.(), 1500);
      return;
    }
    if (step.startsWith('select:')) {
      const [, pageText, ...rest] = step.split(':');
      const key = useSidebarStore.getState().sideBarBookKey;
      const view = key ? useReaderStore.getState().getView(key) : null;
      const index = Number(pageText) - 1;
      const content = view?.renderer.getContents?.().find((c) => c.index === index);
      const range = content ? findPassage(content.doc, rest.join(':')) : null;
      if (!range) {
        const flat = (content?.doc.querySelector('.textLayer')?.textContent ?? '').replace(/\s+/g, '');
        console.info(`smoke: passage not found on page ${pageText}: ${flat.slice(0, 1500)}`);
      } else {
        const text = getTextFromRange(range);
        const section = key ? (useReaderStore.getState().getProgress(key)?.sectionLabel ?? '') : '';
        await attachPassage(view, { text, range, index }, section);
        const added = useChatStore.getState().pendingSelections.at(-1);
        console.info(
          `smoke: selected n=${useChatStore.getState().pendingSelections.length} ` +
            `p. ${added?.page} ${JSON.stringify(added?.text.slice(0, 120))} ` +
            `image=${added?.imageBase64 ? Math.round(added.imageBase64.length / 1365) + 'KB' : 'none'}`,
        );
        // In chunks: the log cuts long lines.
        const image = added?.imageBase64 ?? '';
        for (let at = 0; at < image.length; at += 1500) {
          console.info(`smoke: image ${added?.id} ${image.slice(at, at + 1500)}`);
        }
      }
      next();
      return;
    }
    if (step.startsWith('toggleimg:') || step.startsWith('remove:') || step === 'clear') {
      const chat = useChatStore.getState();
      const k = Number(step.split(':')[1]) - 1;
      if (step === 'clear') chat.clearSelections();
      else if (step.startsWith('remove:')) chat.removeSelection(k);
      else if (chat.pendingSelections[k]) chat.toggleSelectionImage(chat.pendingSelections[k]!.id);
      console.info(
        `smoke: pending ${JSON.stringify(
          useChatStore.getState().pendingSelections.map((p) => [p.page, !!p.imageBase64 && !p.imageOff]),
        )}`,
      );
      next();
      return;
    }
    if (step.startsWith('model:')) {
      useChatStore.getState().setModel(backendId, step.slice(6));
      next();
      return;
    }
    // "asknw:" asks without waiting for the answer, so the next step can
    // interrupt the turn in flight.
    const noWait = step.startsWith('asknw:');
    setInput(noWait ? step.slice(6) : step);
    // The question must be in state before handleSend reads it.
    setTimeout(() => {
      void handleSendRef.current?.();
      if (noWait) setTimeout(() => void runSmokeStepRef.current?.(), 1500);
    }, 200);
  };
  runSmokeStepRef.current = runSmokeStep;

  const inspectData = (): InspectData => {
    const context = buildContext();
    const plan = nextPlan(context);
    const message = buildTurnMessage(input, context, plan);
    return {
      start: startInfo,
      sessionId,
      nextMessage: buildTurnText(input, context, plan),
      includesChapter: plan.includeChapter,
      pages: pageRanges(plan.pages.map((p) => p.page)),
      images: message.message.content.flatMap((b) => (b.type === 'image' ? [b.source.data] : [])),
      lastUsage,
      lastCostUsd,
      rawLines,
    };
  };

  if (!isOpen) return null;

  const contextPlan = nextPlan(buildContext());

  return (
    <div
      className={clsx(
        'chat-panel border-base-300 bg-base-100 flex flex-col border-l',
        isPinned ? 'relative' : 'fixed top-0 right-0 bottom-0 z-[45] shadow-xl',
      )}
      style={{ width: shownWidth, minWidth: 280, maxWidth: 800 }}
    >
      {/* Wider hit zone than the visible line: 4 pixels are unusable. */}
      <div
        className='group absolute top-0 bottom-0 -left-1 z-20 w-3 cursor-col-resize touch-none select-none'
        onPointerDown={handleResizeStart}
        title='Redimensionner'
      >
        <div className='group-hover:bg-primary/40 group-active:bg-primary/60 absolute top-0 bottom-0 left-1 w-1' />
      </div>

      <div className='border-base-300 flex items-center gap-1 border-b px-3 py-2'>
        <ModelSelector />
        <div className='flex-1' />
        <button
          className='btn btn-ghost btn-xs btn-square'
          onClick={() => setShowInspect(true)}
          title='Voir le contexte envoyé'
        >
          <FiCode size={14} />
        </button>
        <button
          className='btn btn-ghost btn-xs btn-square'
          onClick={() => void handleNewConversation()}
          title='Nouvelle conversation'
        >
          <FiPlus size={14} />
        </button>
        <button
          className='btn btn-ghost btn-xs btn-square'
          onClick={() => void handleDeleteConversation()}
          title='Supprimer la conversation'
        >
          <FiTrash2 size={14} />
        </button>
        <button
          className='btn btn-ghost btn-xs btn-square'
          onClick={() => setPinned(!isPinned)}
          title={isPinned ? 'Détacher' : 'Épingler'}
        >
          {isPinned ? <BsPinFill size={14} /> : <BsPin size={14} />}
        </button>
        <button
          className='btn btn-ghost btn-xs btn-square'
          onClick={() => setOpen(false)}
          title='Fermer'
        >
          <FiX size={14} />
        </button>
      </div>

      {conversations.length > 1 && (
        <div className='border-base-300 flex items-center gap-2 border-b px-3 py-1'>
          <span className='text-base-content/50 flex-1 text-xs'>Conversation</span>
          <select
            className='select select-ghost select-xs max-w-[120px] text-xs'
            value={conversationId}
            onChange={(e) => void handleSwitchConversation(e.target.value)}
          >
            {[...conversations]
              .sort((a, b) => b.lastMessageAt - a.lastMessageAt)
              .map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name.substring(0, 30)}
                </option>
              ))}
          </select>
        </div>
      )}

      <div className='flex-1 space-y-3 overflow-y-auto px-3 py-2 select-text'>
        {messages.length === 0 && !streamingContent && (
          <div className='text-base-content/30 flex h-full items-center justify-center text-sm'>
            Sélectionne un passage, ou pose une question
          </div>
        )}
        {messages.map((msg, i) => (
          <div key={i} className={clsx('chat', msg.role === 'user' ? 'chat-end' : 'chat-start')}>
            <div
              className={clsx(
                'chat-bubble text-sm',
                msg.role === 'user'
                  ? 'chat-bubble-primary'
                  : 'chat-bubble bg-base-200 text-base-content',
              )}
            >
              {msg.role === 'user' ? (
                <div>
                  <SentPassages items={itemsOf(msg)} />
                  <span className='whitespace-pre-wrap'>{msg.content}</span>
                </div>
              ) : (
                <Answer content={msg.content} items={itemsOf(messages[i - 1])} />
              )}
            </div>
          </div>
        ))}
        {streamingContent && (
          <div className='chat chat-start'>
            <div className='chat-bubble bg-base-200 text-base-content text-sm'>
              <Answer content={streamingContent} items={itemsOf(messages[messages.length - 1])} />
            </div>
          </div>
        )}
        {isStreaming && !streamingContent && !activeTool && (
          <div className='chat chat-start'>
            <div className='chat-bubble bg-base-200 text-base-content text-sm'>
              <span className='loading loading-dots loading-xs' />
            </div>
          </div>
        )}
        {activeTool && (
          <div className='text-base-content/50 flex items-center gap-2 px-1 py-1 text-xs'>
            <FiSearch size={12} className='animate-pulse' />
            <span>{activeTool === 'WebSearch' ? 'Recherche web…' : `${activeTool}…`}</span>
          </div>
        )}
        {error && <div className='alert alert-error text-xs'>{error}</div>}
        <div ref={messagesEndRef} />
      </div>

      {pendingSelections.length > 0 && (
        <div className='border-base-300 bg-base-200/50 flex max-h-[40%] flex-col gap-1 overflow-y-auto border-t px-3 py-2'>
          {pendingSelections.length > 1 && (
            <div className='flex items-center'>
              <span className='text-base-content/50 flex-1 text-[11px]'>
                {pendingSelections.length} passages · désigne-les par leur numéro
              </span>
              <button
                className='btn btn-ghost btn-xs h-5 min-h-0 px-1 text-[11px]'
                onClick={clearSelections}
                title='Retirer tous les passages'
              >
                Vider
              </button>
            </div>
          )}
          {pendingSelections.map((selection, index) => (
            <div key={selection.id} className='flex items-start gap-2'>
              {pendingSelections.length > 1 && (
                <span className='text-base-content/70 shrink-0 text-sm leading-5'>
                  {circled(index + 1)}
                </span>
              )}
              {/* The passage as it will be sent, in full: what the model reads
                  is not always what the page shows, and it has to be checkable
                  before sending. */}
              {selection.imageBase64 && (
                <img
                  src={`data:image/png;base64,${selection.imageBase64}`}
                  alt={selection.location || 'Passage'}
                  className={clsx(
                    'border-base-300 h-10 max-w-[96px] shrink-0 rounded border bg-white object-contain',
                    selection.imageOff && 'opacity-25 grayscale',
                  )}
                />
              )}
              <details className='min-w-0 flex-1'>
                <summary
                  className='text-base-content/70 cursor-pointer list-none text-xs'
                  title='Afficher toute la sélection'
                >
                  <span className='block truncate'>{chipLabel(selection)}</span>
                  <span className='text-base-content/50 block truncate italic'>
                    {selection.label
                      ? selection.imageBase64 && !selection.imageOff
                        ? 'image + texte'
                        : 'texte seul'
                      : `\u201c${selection.text}\u201d`}
                  </span>
                </summary>
                {selection.imageBase64 && (
                  <div className='text-base-content/50 mt-1 text-[10px]'>
                    {selection.imageOff
                      ? 'Image retirée : seul le texte extrait partira.'
                      : 'Texte extrait du PDF, en secours : l\u2019image fait foi.'}
                  </div>
                )}
                <div className='text-base-content/70 mt-1 max-h-40 overflow-y-auto text-xs whitespace-pre-wrap select-text'>
                  {selection.text}
                </div>
                <div className='text-base-content/40 mt-1 text-[10px]'>
                  {selection.text.length} caractères
                  {selection.location ? ` · ${selection.location}` : ''}
                </div>
              </details>
              {selection.imageBase64 && (
                <button
                  className={clsx(
                    'btn btn-ghost btn-xs btn-square shrink-0',
                    selection.imageOff ? 'text-base-content/30' : 'text-primary',
                  )}
                  onClick={() => toggleSelectionImage(selection.id)}
                  title={selection.imageOff ? 'Remettre l\u2019image' : 'Envoyer sans l\u2019image'}
                  aria-pressed={!selection.imageOff}
                >
                  <FiImage size={12} />
                </button>
              )}
              <button
                className='btn btn-ghost btn-xs btn-square shrink-0'
                onClick={() => removeSelection(index)}
                title='Retirer'
              >
                <FiX size={12} />
              </button>
            </div>
          ))}
        </div>
      )}

      <ContextLine
        position={position}
        chapter={currentChapter}
        pending={contextPending}
        plan={contextPlan}
        hasPages={contextPages.length > 0}
        hasChapter={currentChapterText.trim().length > 0}
      />

      <div className='px-3 pt-1 pb-2'>
        <div className='border-base-300 bg-base-100 focus-within:border-primary flex items-center gap-2 rounded-lg border px-2 py-2'>
          <button
            className={clsx(
              'btn btn-xs btn-circle shrink-0',
              webSearchEnabled
                ? 'bg-primary/20 text-primary hover:bg-primary/30 border-0'
                : 'btn-ghost text-base-content/40',
            )}
            onClick={() => setWebSearchEnabled(!webSearchEnabled)}
            title={webSearchEnabled ? 'Désactiver la recherche web' : 'Activer la recherche web'}
          >
            <FiGlobe size={13} />
          </button>
          <textarea
            ref={inputRef}
            className='placeholder:text-base-content/40 max-h-[120px] min-h-[20px] flex-1 resize-none bg-transparent text-sm outline-none'
            placeholder={
              pendingSelections.length > 0
                ? 'Une question sur la sélection…'
                : 'Une question sur le livre…'
            }
            value={input}
            onChange={(e) => {
              setInput(e.target.value);
              e.target.style.height = 'auto';
              e.target.style.height = `${Math.min(e.target.scrollHeight, 120)}px`;
            }}
            onKeyDown={handleKeyDown}
            rows={1}
            disabled={isStreaming}
          />
          {isStreaming ? (
            <button
              className='btn btn-xs btn-circle btn-error'
              onClick={handleAbort}
              title='Arrêter'
            >
              <FiX size={12} />
            </button>
          ) : (
            <button
              className='btn btn-xs btn-circle btn-primary'
              onClick={() => void handleSend()}
              disabled={!input.trim() && pendingSelections.length === 0}
              title='Envoyer'
            >
              <FiSend size={12} />
            </button>
          )}
        </div>
      </div>

      {showInspect && (
        <InspectOverlay data={inspectData()} onClose={() => setShowInspect(false)} />
      )}
    </div>
  );
};

/** One-line summary of an engine event for the raw log in Inspect. */
const summarize = (event: EngineEvent): string => {
  switch (event.kind) {
    case 'ready':
      return `session=${event.sessionId} model=${event.model} tools=[${event.tools.join(',')}]`;
    case 'text':
      return JSON.stringify(event.text);
    case 'tool_use':
      return `${event.name} ${JSON.stringify(event.input ?? {}).slice(0, 120)}`;
    case 'tool_result':
      return event.isError ? 'error' : 'ok';
    case 'done':
      return `${event.text.length} chars, cache_read=${event.usage?.cacheReadInputTokens ?? 0}`;
    case 'error':
      return event.message.slice(0, 200);
    case 'rate_limit':
      return event.status;
    case 'exit':
      return `code=${event.code ?? 'null'}`;
    case 'user_replay':
      return JSON.stringify(event.content).slice(0, 200);
    default:
      return '';
  }
};

export default ChatPanel;
