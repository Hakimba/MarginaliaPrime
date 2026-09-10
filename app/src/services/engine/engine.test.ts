import { describe, expect, it } from 'vitest';

import { buildCliArgs } from './claudeCliEngine';
import { buildHarness, buildTurnMessage, buildTurnText } from './harness';
import { parseCliLine } from './parseCliEvent';
import type { EngineContext, EngineStartOptions } from './types';

/**
 * Lines recorded from Claude Code 2.1.266 with
 * `-p --verbose --input-format stream-json --output-format stream-json
 *  --include-partial-messages --replay-user-messages`.
 */
const recorded = {
  init: '{"type":"system","subtype":"init","session_id":"cb25ab10-4b00-4c87-9678-0a8518384630","model":"claude-haiku-4-5","tools":[],"mcp_servers":[],"cwd":"/tmp/clitest"}',
  status:
    '{"type":"system","subtype":"status","status":"requesting","session_id":"cb25ab10","uuid":"e446e174"}',
  thinkingTokens:
    '{"type":"system","subtype":"thinking_tokens","estimated_tokens":183,"session_id":"cb25ab10"}',
  replay:
    '{"type":"user","message":{"role":"user","content":[{"type":"text","text":"Reponds exactement: PONG"}]},"session_id":"cb25ab10","parent_tool_use_id":null}',
  thinkingDelta:
    '{"type":"stream_event","event":{"type":"content_block_delta","delta":{"type":"thinking_delta","thinking":""}}}',
  signatureDelta:
    '{"type":"stream_event","event":{"type":"content_block_delta","delta":{"type":"signature_delta","signature":"EtIFCrIB"}}}',
  textDelta:
    '{"type":"stream_event","event":{"type":"content_block_delta","delta":{"type":"text_delta","text":"PONG"}}}',
  messageStop: '{"type":"stream_event","event":{"type":"message_stop"}}',
  assistantToolUse:
    '{"type":"assistant","message":{"role":"assistant","content":[{"type":"tool_use","id":"toolu_1","name":"WebSearch","input":{"query":"x"}}]}}',
  toolResult:
    '{"type":"user","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"toolu_1","is_error":false,"content":"ok"}]}}',
  toolResultError:
    '{"type":"user","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"toolu_1","is_error":true,"content":"boom"}]}}',
  result:
    '{"type":"result","subtype":"success","is_error":false,"result":"PONG","usage":{"input_tokens":10,"output_tokens":5,"cache_read_input_tokens":6437,"cache_creation_input_tokens":289},"total_cost_usd":0.0144}',
  resultError:
    '{"type":"result","subtype":"error_during_execution","is_error":true,"result":"the engine blew up"}',
  rateLimitAllowed:
    '{"type":"rate_limit_event","rate_limit_info":{"status":"allowed","resetsAt":1788997200}}',
  rateLimitRejected:
    '{"type":"rate_limit_event","rate_limit_info":{"status":"rejected","resetsAt":1788997200}}',
  flagError: 'Error: When using --print, --output-format=stream-json requires --verbose',
};

describe('parseCliLine', () => {
  it('reports the session, model and tool list from init', () => {
    expect(parseCliLine(recorded.init)).toEqual([
      {
        kind: 'ready',
        sessionId: 'cb25ab10-4b00-4c87-9678-0a8518384630',
        model: 'claude-haiku-4-5',
        tools: [],
        cwd: '/tmp/clitest',
      },
    ]);
  });

  it('ignores transient status and progress lines', () => {
    expect(parseCliLine(recorded.status)).toEqual([]);
    expect(parseCliLine(recorded.thinkingTokens)).toEqual([]);
    expect(parseCliLine(recorded.messageStop)).toEqual([]);
    expect(parseCliLine('')).toEqual([]);
    expect(parseCliLine('   ')).toEqual([]);
  });

  it('emits displayable text only, not thinking or signature deltas', () => {
    expect(parseCliLine(recorded.textDelta)).toEqual([{ kind: 'text', text: 'PONG' }]);
    expect(parseCliLine(recorded.thinkingDelta)).toEqual([]);
    expect(parseCliLine(recorded.signatureDelta)).toEqual([]);
  });

  it('separates our replayed message from tool results', () => {
    expect(parseCliLine(recorded.replay)).toEqual([
      { kind: 'user_replay', content: [{ type: 'text', text: 'Reponds exactement: PONG' }] },
    ]);
    expect(parseCliLine(recorded.toolResult)).toEqual([
      { kind: 'tool_result', id: 'toolu_1', isError: false },
    ]);
    expect(parseCliLine(recorded.toolResultError)).toEqual([
      { kind: 'tool_result', id: 'toolu_1', isError: true },
    ]);
  });

  it('reports tool calls from the assistant message', () => {
    expect(parseCliLine(recorded.assistantToolUse)).toEqual([
      { kind: 'tool_use', id: 'toolu_1', name: 'WebSearch', input: { query: 'x' } },
    ]);
  });

  it('carries the final text, usage and cost on success', () => {
    expect(parseCliLine(recorded.result)).toEqual([
      {
        kind: 'done',
        text: 'PONG',
        usage: {
          inputTokens: 10,
          outputTokens: 5,
          cacheReadInputTokens: 6437,
          cacheCreationInputTokens: 289,
        },
        costUsd: 0.0144,
      },
    ]);
  });

  it('turns an error result into a fatal error event', () => {
    expect(parseCliLine(recorded.resultError)).toEqual([
      { kind: 'error', message: 'the engine blew up', fatal: true },
    ]);
  });

  it('surfaces a rate limit only when it blocks', () => {
    expect(parseCliLine(recorded.rateLimitAllowed)).toEqual([]);
    expect(parseCliLine(recorded.rateLimitRejected)).toEqual([
      { kind: 'rate_limit', status: 'rejected', resetsAt: 1788997200 },
    ]);
  });

  it('treats a plain-text line as a fatal error', () => {
    const events = parseCliLine(recorded.flagError);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ kind: 'error', fatal: true });
  });

  it('does not throw on malformed JSON', () => {
    const events = parseCliLine('{"type":"result",');
    expect(events[0]?.kind).toBe('error');
  });
});

const startOptions = (over: Partial<EngineStartOptions> = {}): EngineStartOptions => ({
  conversationId: 'conv-1',
  bookKey: 'hash-1',
  model: { id: 'claude-opus-5', label: 'Opus 5', effort: 'high' },
  webSearch: false,
  harnessContext: { bookTitle: 'Book', bookAuthor: 'Author' },
  ...over,
});

describe('buildCliArgs', () => {
  it('never uses --bare, which would bypass the subscription login', () => {
    expect(buildCliArgs(startOptions())).not.toContain('--bare');
  });

  it('removes every built-in tool when web search is off', () => {
    const args = buildCliArgs(startOptions());
    expect(args[args.indexOf('--tools') + 1]).toBe('');
    expect(args).not.toContain('--allowedTools');
  });

  it('allows only web search when it is on', () => {
    const args = buildCliArgs(startOptions({ webSearch: true }));
    expect(args[args.indexOf('--tools') + 1]).toBe('WebSearch');
    expect(args[args.indexOf('--allowedTools') + 1]).toBe('WebSearch');
  });

  it('keeps the personal configuration out and the protocol machine-readable', () => {
    const args = buildCliArgs(startOptions());
    expect(args).toContain('--verbose');
    expect(args[args.indexOf('--setting-sources') + 1]).toBe('project');
    expect(args).toContain('--strict-mcp-config');
    expect(args[args.indexOf('--permission-prompts') + 1]).toBe('none');
    expect(args[args.indexOf('--input-format') + 1]).toBe('stream-json');
    expect(args[args.indexOf('--output-format') + 1]).toBe('stream-json');
  });

  it('starts a fresh session by id, or resumes a recorded one', () => {
    const fresh = buildCliArgs(startOptions());
    expect(fresh[fresh.indexOf('--session-id') + 1]).toMatch(/^[0-9a-f-]{36}$/);
    expect(fresh).not.toContain('--resume');

    const resumed = buildCliArgs(startOptions({ resumeSessionId: 'abc-123' }));
    expect(resumed[resumed.indexOf('--resume') + 1]).toBe('abc-123');
    expect(resumed).not.toContain('--session-id');
  });

  it('passes the model and its effort level', () => {
    const args = buildCliArgs(startOptions());
    expect(args[args.indexOf('--model') + 1]).toBe('claude-opus-5');
    expect(args[args.indexOf('--effort') + 1]).toBe('high');
    const noEffort = buildCliArgs(
      startOptions({ model: { id: 'claude-haiku-4-5', label: 'Haiku' } }),
    );
    expect(noEffort).not.toContain('--effort');
  });
});

const context = (over: Partial<EngineContext> = {}): EngineContext => ({
  bookTitle: 'Mathematics for Machine Learning',
  bookAuthor: 'Deisenroth',
  chapterTitle: '6.5 Gaussian Distribution',
  chapterText: 'Chapitre entier.',
  position: 'p. 202',
  selections: [{ text: 'V[x] = ...', location: 'p. 202' }],
  ...over,
});

describe('buildTurnText', () => {
  it('includes the chapter only when asked', () => {
    expect(buildTurnText('Explique', context(), true)).toContain('<current-chapter');
    expect(buildTurnText('Explique', context(), false)).not.toContain('<current-chapter');
  });

  it('always carries the position, the selection and the question', () => {
    const text = buildTurnText('Explique', context(), false);
    expect(text).toContain('<reading-position>');
    expect(text).toContain('p. 202 · 6.5 Gaussian Distribution');
    expect(text).toContain('<selection location="p. 202">');
    expect(text).toContain('<question>');
    expect(text).toContain('Explique');
  });

  it('numbers the selections when there are several', () => {
    const text = buildTurnText('Comment se contredisent-ils ?', context({
      selections: [
        { text: 'premier passage', location: 'p. 10' },
        { text: 'second passage', location: 'p. 42' },
      ],
    }), false);
    expect(text).toContain('index="1"');
    expect(text).toContain('index="2"');
    expect(text).toContain('premier passage');
    expect(text).toContain('second passage');
  });

  it('falls back to a default question when the reader typed nothing', () => {
    expect(buildTurnText('   ', context(), false)).toContain('Explique ce passage.');
  });

  it('keeps the position on one line and attribute values free of quotes', () => {
    const text = buildTurnText('q', context({ position: 'p. "2"\n3' }), false);
    // Quotes are legitimate inside a tag body; only attributes replace them.
    expect(text).toContain('<reading-position>\np. "2" 3 · 6.5 Gaussian Distribution\n</reading-position>');
    expect(text).toContain('location="p. 202"');
  });

  it('escapes quotes and newlines inside attributes', () => {
    const text = buildTurnText('q', context({
      selections: [{ text: 'x', location: 'chapitre "6"\nsuite' }],
    }), false);
    expect(text).toContain('location="chapitre \'6\' suite"');
  });
});

describe('buildTurnMessage', () => {
  it('puts each selection image before the text that describes it', () => {
    const message = buildTurnMessage(
      'Transcris',
      context({ selections: [{ text: 'formule', imageBase64: 'AAAA' }] }),
      { includeChapter: false },
    );
    expect(message.type).toBe('user');
    expect(message.message.content[0]).toEqual({
      type: 'image',
      source: { type: 'base64', media_type: 'image/png', data: 'AAAA' },
    });
    expect(message.message.content[1]).toMatchObject({ type: 'text' });
    const last = message.message.content.at(-1);
    expect(last && 'text' in last ? last.text : '').toContain('<question>');
  });

  it('sends no image block when the selection has none', () => {
    const message = buildTurnMessage('q', context(), { includeChapter: false });
    expect(message.message.content.every((b) => b.type === 'text')).toBe(true);
  });
});

describe('buildHarness', () => {
  it('names the book and warns about PDF text extraction', () => {
    const harness = buildHarness({ bookTitle: 'TAPL', bookAuthor: 'Pierce', webSearch: false });
    expect(harness).toContain('TAPL');
    expect(harness).toContain('Pierce');
    expect(harness).toContain('crois l’image'.replace('’', "'"));
    expect(harness).not.toContain('recherche web');
  });

  it('mentions web search only when it is enabled', () => {
    const harness = buildHarness({ bookTitle: '', bookAuthor: '', webSearch: true });
    expect(harness).toContain('recherche web');
    expect(harness).toContain('un livre technique');
  });
});
