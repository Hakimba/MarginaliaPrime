/**
 * Engine backed by the `claude` CLI, launched as a child process by the Tauri
 * backend (see `src-tauri/src/engine.rs`).
 *
 * One process per conversation, kept alive so the CLI owns the history and the
 * prompt cache stays warm. Nothing here reads a token or calls the API: the
 * CLI authenticates with the user's own Claude Code login.
 */
import { invoke } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';

import { buildHarness, buildTurnMessage } from './harness';
import { parseCliLine } from './parseCliEvent';
import type {
  Engine,
  EngineContext,
  EngineEvent,
  EngineStartInfo,
  EngineStartOptions,
} from './types';

interface LinePayload {
  id: string;
  line: string;
}

interface ExitPayload {
  id: string;
  code: number | null;
}

interface RustStartInfo {
  binary: string;
  args: string[];
  cwd: string;
}

/**
 * Build the CLI argument list. Kept separate and pure so the Inspect overlay
 * and the tests can read exactly what will be launched.
 *
 * Notes on the non-obvious flags:
 * - `--verbose` is mandatory with `-p --output-format stream-json`.
 * - No `--bare`: bare mode ignores the subscription login and demands an API key.
 * - `--tools ""` removes the 31 built-in tools, which cost ~11k tokens of system
 *   prompt per turn and would let the model read the book file directly.
 * - `--setting-sources project` keeps the user's personal plugins and skills out.
 * - `--strict-mcp-config` with no `--mcp-config` means no MCP server at all (the
 *   reader's own server arrives in a later task).
 * - `--system-prompt-snapshot off` so an edited harness applies on the next
 *   conversation instead of being frozen for the session's lifetime.
 */
export const buildCliArgs = (options: EngineStartOptions): string[] => {
  const args = [
    '-p',
    '--verbose',
    '--input-format',
    'stream-json',
    '--output-format',
    'stream-json',
    '--include-partial-messages',
    '--replay-user-messages',
    '--strict-mcp-config',
    '--setting-sources',
    'project',
    '--permission-prompts',
    'none',
    '--system-prompt-snapshot',
    'off',
    '--tools',
    // An empty value removes every built-in tool; the flag itself must stay.
    options.webSearch ? 'WebSearch' : '',
    '--model',
    options.model.id,
  ];

  // Pre-approving a tool only makes sense when one is available.
  if (options.webSearch) args.push('--allowedTools', 'WebSearch');

  if (options.model.effort) args.push('--effort', options.model.effort);

  if (options.resumeSessionId) {
    args.push('--resume', options.resumeSessionId);
  } else {
    args.push('--session-id', newSessionId());
  }

  return args;
};

/** UUID for a new CLI session, with a fallback for non-secure contexts. */
const newSessionId = (): string => {
  const uuid = globalThis.crypto?.randomUUID?.();
  if (uuid) return uuid;
  const hex = (n: number) =>
    Array.from({ length: n }, () => Math.floor(Math.random() * 16).toString(16)).join('');
  return `${hex(8)}-${hex(4)}-4${hex(3)}-a${hex(3)}-${hex(12)}`;
};

export class ClaudeCliEngine implements Engine {
  readonly backendId = 'claude';

  private conversationId = '';
  private listeners = new Set<(event: EngineEvent) => void>();
  private unlisten: UnlistenFn[] = [];
  private running = false;
  private session: string | null = null;
  private chapterSent = '';
  private turnCount = 0;
  private resumed = false;
  /** Last lines the CLI wrote to stderr: it explains failures there. */
  private stderrTail: string[] = [];

  /** True when this process was started with `--resume`. */
  wasResumed(): boolean {
    return this.resumed;
  }

  isRunning(): boolean {
    return this.running;
  }

  sessionId(): string | null {
    return this.session;
  }

  subscribe(listener: (event: EngineEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async start(options: EngineStartOptions): Promise<EngineStartInfo> {
    await this.detach();
    this.conversationId = options.conversationId;
    this.session = options.resumeSessionId ?? null;
    this.chapterSent = '';
    this.turnCount = 0;
    this.resumed = Boolean(options.resumeSessionId);
    this.stderrTail = [];

    const args = buildCliArgs(options);
    const harness = buildHarness({ ...options.harnessContext, webSearch: options.webSearch });

    this.unlisten.push(
      await listen<LinePayload>('engine://line', ({ payload }) => {
        if (payload.id !== this.conversationId) return;
        for (const event of parseCliLine(payload.line)) this.dispatch(event);
      }),
    );
    this.unlisten.push(
      await listen<LinePayload>('engine://stderr', ({ payload }) => {
        if (payload.id !== this.conversationId) return;
        this.stderrTail = [...this.stderrTail.slice(-4), payload.line];
      }),
    );
    this.unlisten.push(
      await listen<ExitPayload>('engine://exit', ({ payload }) => {
        if (payload.id !== this.conversationId) return;
        this.running = false;
        this.dispatch({ kind: 'exit', code: payload.code });
      }),
    );

    let info: RustStartInfo;
    try {
      info = await invoke<RustStartInfo>('engine_start', {
        id: options.conversationId,
        bookKey: options.bookKey,
        args,
        harness,
      });
    } catch (error) {
      await this.detach();
      throw new Error(messageOf(error));
    }

    this.running = true;
    return { ...info, harness };
  }

  async send(text: string, context: EngineContext): Promise<void> {
    if (!this.running) throw new Error('The engine is not running.');

    // The chapter travels once per conversation, and again when it changes.
    const chapterKey = `${context.chapterTitle}::${context.chapterText.length}`;
    const includeChapter = context.chapterText.trim().length > 0 && chapterKey !== this.chapterSent;

    const message = buildTurnMessage(text, context, { includeChapter });
    try {
      await invoke('engine_send', {
        id: this.conversationId,
        line: JSON.stringify(message),
      });
    } catch (error) {
      throw new Error(messageOf(error));
    }
    if (includeChapter) this.chapterSent = chapterKey;
    this.turnCount += 1;
  }

  /** Number of turns sent through this process, for diagnostics. */
  turns(): number {
    return this.turnCount;
  }

  async abort(): Promise<void> {
    if (this.conversationId) {
      try {
        await invoke('engine_stop', { id: this.conversationId });
      } catch {
        // The process may already be gone; nothing to recover.
      }
    }
    await this.detach();
  }

  private async detach(): Promise<void> {
    this.running = false;
    for (const off of this.unlisten) off();
    this.unlisten = [];
  }

  private dispatch(event: EngineEvent): void {
    if (event.kind === 'ready' && event.sessionId) this.session = event.sessionId;
    // The CLI explains a failure on stderr and returns a generic message on
    // stdout; show the explanation rather than "failed during execution".
    if (event.kind === 'error') {
      const detail = this.stderrTail.filter((l) => /error/i.test(l)).at(-1);
      if (detail && !event.message.includes(detail)) {
        event = { ...event, message: `${event.message} ${detail}`.trim() };
      }
    }
    for (const listener of this.listeners) listener(event);
  }
}

/** Path and version of the CLI, or a message explaining why it is unusable. */
export const claudeBinaryInfo = async (): Promise<{ path: string; version: string }> =>
  invoke<{ path: string; version: string }>('engine_binary_info');

const messageOf = (error: unknown): string =>
  typeof error === 'string' ? error : error instanceof Error ? error.message : String(error);
