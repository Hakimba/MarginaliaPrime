/**
 * Engine abstraction: what the chat panel needs from a model backend, with no
 * knowledge of how the backend is reached.
 *
 * The only implementation for now drives the `claude` CLI as a child process
 * (see `claudeCliEngine.ts`). A second one for `codex exec` is planned, which
 * is why images are described as data rather than as CLI-specific content
 * blocks.
 */

/** One passage the reader selected in the book. */
export interface EngineSelection {
  text: string;
  /** Text immediately around the selection, when the reader gave us one. */
  surroundingText?: string;
  /** Human-readable location, e.g. "p. 202" or "6.5 Gaussian Distribution". */
  location?: string;
  /** PNG of the selected region, base64 without a data: prefix (PDF only). */
  imageBase64?: string;
}

/** Everything the model should know about where the reader is right now. */
export interface EngineContext {
  bookTitle: string;
  bookAuthor: string;
  chapterTitle: string;
  /** Full chapter text; sent once per conversation, not on every turn. */
  chapterText: string;
  /** e.g. "30 / 417" or a chapter-relative position. */
  position?: string;
  selections: EngineSelection[];
}

export type EngineEvent =
  /** The CLI accepted the session and reported its configuration. */
  | { kind: 'ready'; sessionId: string; model: string; tools: string[]; cwd?: string }
  /** A chunk of the assistant's answer. */
  | { kind: 'text'; text: string }
  /** The model started using a tool. */
  | { kind: 'tool_use'; id: string; name: string; input?: unknown }
  /** A tool returned. */
  | { kind: 'tool_result'; id?: string; isError: boolean }
  /** The turn finished. `text` is the CLI's authoritative final answer. */
  | { kind: 'done'; text: string; usage?: EngineUsage; costUsd?: number }
  /** The turn or the process failed. Recoverable unless `fatal`. */
  | { kind: 'error'; message: string; fatal?: boolean }
  /** Usage limit information reported mid-turn. */
  | { kind: 'rate_limit'; status: string; resetsAt?: number }
  /** Our own message echoed back by the CLI, used by the Inspect overlay. */
  | { kind: 'user_replay'; content: unknown }
  /** The child process exited. */
  | { kind: 'exit'; code: number | null };

export interface EngineUsage {
  inputTokens?: number;
  outputTokens?: number;
  cacheReadInputTokens?: number;
  cacheCreationInputTokens?: number;
}

/** Model choice, split so the UI can offer backend then model. */
export interface EngineModel {
  /** Stable id passed to the backend, e.g. `claude-opus-5`. */
  id: string;
  label: string;
  /** Reasoning effort, when the backend supports it. */
  effort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max';
}

export interface EngineStartOptions {
  /** Identifies the process; one per conversation. */
  conversationId: string;
  /** Used to pick the per-book working directory. */
  bookKey: string;
  model: EngineModel;
  /** Reuse a CLI session recorded earlier, after an app restart. */
  resumeSessionId?: string;
  webSearch: boolean;
  /** Book-level facts that belong in the stable system prompt. */
  harnessContext: { bookTitle: string; bookAuthor: string };
}

/** What was actually launched, for the Inspect overlay. */
export interface EngineStartInfo {
  binary: string;
  args: string[];
  cwd: string;
  harness: string;
}

export interface Engine {
  readonly backendId: string;
  /** Launch the backend. Throws with a human-readable message on failure. */
  start(options: EngineStartOptions): Promise<EngineStartInfo>;
  /** Send one turn. Resolves when the turn is accepted, not when it ends. */
  send(text: string, context: EngineContext): Promise<void>;
  /** Interrupt the current turn and drop the backend. */
  abort(): Promise<void>;
  /** True while a process is running. */
  isRunning(): boolean;
  /** CLI session id, once known; store it to resume later. */
  sessionId(): string | null;
  /** True when the backend was started by resuming a recorded session. */
  wasResumed(): boolean;
  /** Subscribe to events. Returns an unsubscribe function. */
  subscribe(listener: (event: EngineEvent) => void): () => void;
}
