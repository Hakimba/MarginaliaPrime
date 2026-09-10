'use client';

import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from 'react';
import { FiCode, FiGlobe, FiPlus, FiSearch, FiSend, FiTrash2, FiX } from 'react-icons/fi';
import { BsPin, BsPinFill } from 'react-icons/bs';
import clsx from 'clsx';
import DOMPurify from 'dompurify';
import { marked } from 'marked';

import { useChatStore } from '@/store/chatStore';
import { useSidebarStore } from '@/store/sidebarStore';

import {
  ClaudeCliEngine,
  buildTurnMessage,
  buildTurnText,
  claudeBinaryInfo,
  findModel,
} from '@/services/engine';
import type {
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
import ModelSelector from './ModelSelector';
import InspectOverlay, { type InspectData } from './InspectOverlay';

/** Where a scripted smoke scenario parks its remaining steps across a reload. */
const SMOKE_RESUME_KEY = 'marginalia-smoke-resume';

function generateId(): string {
  return Date.now().toString(36) + Math.random().toString(36).substring(2, 8);
}

const ChatPanel: React.FC = () => {
  const {
    isOpen,
    isPinned,
    panelWidth,
    pendingSelections,
    currentChapter,
    currentChapterText,
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
    clearSelections,
    setConversationId,
    setWebSearchEnabled,
  } = useChatStore();

  const isResizing = useRef(false);

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
      setPanelWidth(Math.max(280, Math.min(800, startWidth + delta)));
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
  const chapterSentFor = useRef('');
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
    chapterSentFor.current = '';
    setStartInfo(null);
    if (engine) await engine.abort();
  }, []);

  // Switch book: load its conversations and drop the running process.
  useEffect(() => {
    if (!sideBarBookKey) return;
    const hash = sideBarBookKey.split('-')[0] || '';
    if (!hash || hash === currentBookHash.current) return;
    currentBookHash.current = hash;
    useChatStore.getState().setBookHash(hash);
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

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, streamingContent]);

  useEffect(() => {
    if (isOpen) setTimeout(() => inputRef.current?.focus(), 100);
  }, [isOpen]);

  // Persist messages and the conversation index, debounced.
  const saveTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (messages.length === 0 || !bookHash || !conversationId) return;
    if (saveTimeoutRef.current) clearTimeout(saveTimeoutRef.current);
    saveTimeoutRef.current = setTimeout(() => {
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
    }, 500);
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
      position: s.position,
      selections: s.pendingSelections,
    };
  }, []);

  const chapterKey = `${currentChapter}::${currentChapterText.length}`;
  const willIncludeChapter =
    currentChapterText.trim().length > 0 && chapterKey !== chapterSentFor.current;

  const handleSend = async () => {
    const text = input.trim();
    if ((!text && pendingSelections.length === 0) || isStreaming) return;

    // The chapter is extracted lazily; ask for it now and give it a moment,
    // so the very first question of a session is not sent without it.
    if (!useChatStore.getState().currentChapterText && useChatStore.getState().currentChapter) {
      useChatStore.getState().requestChapter();
      for (let i = 0; i < 20 && !useChatStore.getState().currentChapterText; i += 1) {
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    }

    // Recorded before the engine starts: a failure can arrive immediately.
    const context = buildContext();
    lastTurn.current = { text, context };
    resumeRetried.current = false;

    const engine = await ensureEngine();
    if (!engine) return;
    const userMsg: ChatMessage = {
      role: 'user',
      content: text || 'Explique ce passage.',
      timestamp: Date.now(),
      ...(pendingSelections[0]
        ? {
            selection: {
              text: pendingSelections.map((s) => s.text).join('\n\n— — —\n\n'),
              chapter: pendingSelections[0].location ?? currentChapter,
            },
          }
        : {}),
    };

    setMessages((prev) => [...prev, userMsg]);
    setInput('');
    if (inputRef.current) inputRef.current.style.height = 'auto';
    clearSelections();
    setIsStreaming(true);
    setStreamingContent('');
    accumulated.current = '';
    setError(null);

    try {
      await engine.send(text, context);
      if (willIncludeChapter) chapterSentFor.current = chapterKey;
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

  const handleNewConversation = () => void resetConversation(generateId());

  const handleDeleteConversation = async () => {
    if (bookHash && conversationId) {
      await deleteConversation(bookHash, conversationId);
      const updated = conversationsRef.current.filter((c) => c.id !== conversationId);
      conversationsRef.current = updated;
      setConversations(updated);
      await saveConversationIndex(bookHash, updated).catch(() => {});
      // The debounced save must not resurrect it from a stale transcript.
      messagesRef.current = [];
      if (saveTimeoutRef.current) clearTimeout(saveTimeoutRef.current);
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
  const smokeQueue = useRef<string[]>([]);
  const runSmokeStepRef = useRef<(() => Promise<void>) | null>(null);
  useEffect(() => {
    if (smokeFired.current || !bookHash || !currentChapter) return;
    let cancelled = false;
    void (async () => {
      try {
        const { invoke } = await import('@tauri-apps/api/core');
        const question = await invoke<string>('get_environment_variable', {
          name: 'MARGINALIA_SMOKE_ASK',
        });
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
  }, [bookHash, currentChapter]);

  const handleSendRef = useRef<(() => Promise<void>) | null>(null);
  handleSendRef.current = handleSend;

  /**
   * Runs one step of a scripted smoke scenario. Steps are separated by "|" in
   * MARGINALIA_SMOKE_ASK; a step is a question unless it starts with a verb:
   *   newconv          start a new conversation
   *   delete           delete the current conversation
   *   book:<hash>      switch to another book without leaving the app
   *   model:<id>       change model mid-conversation
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
      await resetConversation(generateId());
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

  const renderMarkdown = (content: string) => {
    const html = marked.parse(content, { async: false }) as string;
    return DOMPurify.sanitize(html);
  };

  const inspectData = (): InspectData => {
    const context = buildContext();
    const message = buildTurnMessage(input, context, { includeChapter: willIncludeChapter });
    return {
      start: startInfo,
      sessionId,
      nextMessage: buildTurnText(input, context, willIncludeChapter),
      includesChapter: willIncludeChapter,
      imageCount: message.message.content.filter((b) => b.type === 'image').length,
      lastUsage,
      lastCostUsd,
      rawLines,
    };
  };

  if (!isOpen) return null;

  return (
    <div
      className={clsx(
        'chat-panel border-base-300 bg-base-100 flex flex-col border-l',
        isPinned ? 'relative' : 'fixed top-0 right-0 bottom-0 z-[45] shadow-xl',
      )}
      style={{ width: panelWidth, minWidth: 280, maxWidth: 800 }}
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
          onClick={handleNewConversation}
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

      <div className='border-base-300 flex items-center gap-2 border-b px-3 py-1'>
        {currentChapter && (
          <span className='text-base-content/50 flex-1 truncate text-xs'>{currentChapter}</span>
        )}
        {conversations.length > 1 && (
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
        )}
      </div>

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
                  {msg.selection && (
                    <div className='mb-2 line-clamp-3 border-l-2 border-white/40 pl-2 text-xs italic opacity-80'>
                      &ldquo;{msg.selection.text}&rdquo;
                      {msg.selection.chapter && (
                        <div className='mt-0.5 text-[10px] not-italic opacity-60'>
                          {msg.selection.chapter}
                        </div>
                      )}
                    </div>
                  )}
                  <span className='whitespace-pre-wrap'>{msg.content}</span>
                </div>
              ) : (
                <div
                  className='prose prose-sm max-w-none'
                  dangerouslySetInnerHTML={{ __html: renderMarkdown(msg.content) }}
                />
              )}
            </div>
          </div>
        ))}
        {streamingContent && (
          <div className='chat chat-start'>
            <div className='chat-bubble bg-base-200 text-base-content text-sm'>
              <div
                className='prose prose-sm max-w-none'
                dangerouslySetInnerHTML={{ __html: renderMarkdown(streamingContent) }}
              />
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
        <div className='border-base-300 bg-base-200/50 flex flex-col gap-1 border-t px-3 py-2'>
          {pendingSelections.map((selection, index) => (
            <div key={index} className='flex items-start gap-2'>
              {pendingSelections.length > 1 && (
                <span className='text-base-content/50 shrink-0 text-xs'>{index + 1}.</span>
              )}
              <div className='text-base-content/70 flex-1 line-clamp-3 text-xs italic'>
                &ldquo;{selection.text}&rdquo;
              </div>
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

      <div className='border-base-300 border-t px-3 py-2'>
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
