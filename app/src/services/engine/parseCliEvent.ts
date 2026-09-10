/**
 * Translate one line of the `claude` CLI stream-json protocol into engine
 * events. Pure and synchronous so it can be tested against recorded lines.
 *
 * Message shapes observed on Claude Code 2.1.266 with
 * `-p --verbose --input-format stream-json --output-format stream-json
 *  --include-partial-messages --replay-user-messages`:
 *
 *   system/init            once per turn: session_id, model, tools, cwd
 *   system/status          transient ("requesting"), ignored
 *   system/thinking_tokens progress counter, ignored
 *   user                   our message replayed, or tool results
 *   stream_event           message_start / content_block_* / message_*
 *   assistant              the complete block list for the turn
 *   result                 final answer, usage, cost, or an error
 *   rate_limit_event       usage window information
 */
import type { EngineEvent } from './types';

interface ContentBlock {
  type?: string;
  text?: string;
  id?: string;
  name?: string;
  input?: unknown;
  is_error?: boolean;
  tool_use_id?: string;
}

/** Parse a raw stdout line. Returns [] for lines with nothing to report. */
export const parseCliLine = (line: string): EngineEvent[] => {
  const trimmed = line.trim();
  if (!trimmed) return [];
  if (!trimmed.startsWith('{')) {
    // The CLI prints plain-text errors for invalid flag combinations.
    return [{ kind: 'error', message: trimmed, fatal: true }];
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return [{ kind: 'error', message: `Unreadable engine output: ${trimmed.slice(0, 200)}` }];
  }
  return parseCliEvent(parsed as Record<string, unknown>);
};

export const parseCliEvent = (msg: Record<string, unknown>): EngineEvent[] => {
  const type = msg['type'] as string | undefined;
  const subtype = msg['subtype'] as string | undefined;

  if (type === 'system') {
    if (subtype === 'init') {
      return [
        {
          kind: 'ready',
          sessionId: (msg['session_id'] as string) ?? '',
          model: (msg['model'] as string) ?? '',
          tools: (msg['tools'] as string[]) ?? [],
          cwd: msg['cwd'] as string | undefined,
        },
      ];
    }
    return [];
  }

  if (type === 'stream_event') {
    const event = msg['event'] as Record<string, unknown> | undefined;
    if (event?.['type'] !== 'content_block_delta') return [];
    const delta = event['delta'] as Record<string, unknown> | undefined;
    // thinking_delta and signature_delta carry no displayable text.
    if (delta?.['type'] !== 'text_delta') return [];
    const text = delta['text'];
    return typeof text === 'string' && text ? [{ kind: 'text', text }] : [];
  }

  if (type === 'assistant') {
    const blocks = messageContent(msg);
    return blocks
      .filter((b) => b.type === 'tool_use')
      .map((b) => ({
        kind: 'tool_use' as const,
        id: b.id ?? '',
        name: b.name ?? 'tool',
        input: b.input,
      }));
  }

  if (type === 'user') {
    const blocks = messageContent(msg);
    const results = blocks.filter((b) => b.type === 'tool_result');
    if (results.length > 0) {
      return results.map((b) => ({
        kind: 'tool_result' as const,
        id: b.tool_use_id,
        isError: b.is_error === true,
      }));
    }
    // Replayed copy of what we sent: the Inspect overlay shows it verbatim.
    const message = msg['message'] as Record<string, unknown> | undefined;
    return [{ kind: 'user_replay', content: message?.['content'] ?? message }];
  }

  if (type === 'result') {
    if (msg['is_error'] === true || (subtype && subtype !== 'success')) {
      return [
        {
          kind: 'error',
          message: errorMessage(msg, subtype),
          // A refusal or a max-turns stop leaves the process usable.
          fatal: subtype === 'error_during_execution',
        },
      ];
    }
    const usage = msg['usage'] as Record<string, unknown> | undefined;
    return [
      {
        kind: 'done',
        text: typeof msg['result'] === 'string' ? (msg['result'] as string) : '',
        ...(usage
          ? {
              usage: {
                inputTokens: numberOr(usage['input_tokens']),
                outputTokens: numberOr(usage['output_tokens']),
                cacheReadInputTokens: numberOr(usage['cache_read_input_tokens']),
                cacheCreationInputTokens: numberOr(usage['cache_creation_input_tokens']),
              },
            }
          : {}),
        ...(typeof msg['total_cost_usd'] === 'number'
          ? { costUsd: msg['total_cost_usd'] as number }
          : {}),
      },
    ];
  }

  if (type === 'rate_limit_event') {
    const info = msg['rate_limit_info'] as Record<string, unknown> | undefined;
    const status = (info?.['status'] as string) ?? 'unknown';
    // Only surface states the reader can act on.
    if (status === 'allowed') return [];
    return [{ kind: 'rate_limit', status, resetsAt: numberOr(info?.['resetsAt']) }];
  }

  return [];
};

const messageContent = (msg: Record<string, unknown>): ContentBlock[] => {
  const message = msg['message'] as Record<string, unknown> | undefined;
  const content = message?.['content'];
  return Array.isArray(content) ? (content as ContentBlock[]) : [];
};

const numberOr = (value: unknown): number | undefined =>
  typeof value === 'number' ? value : undefined;

const errorMessage = (msg: Record<string, unknown>, subtype?: string): string => {
  const raw = msg['result'];
  if (typeof raw === 'string' && raw.trim()) return raw;
  if (subtype === 'error_max_turns') return 'The engine stopped after too many turns.';
  if (subtype === 'error_during_execution') return 'The engine failed during execution.';
  return `The engine returned an error (${subtype ?? 'unknown'}).`;
};
