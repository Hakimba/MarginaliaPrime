import katex from 'katex';
import { describe, expect, it } from 'vitest';

import { buildCliArgs } from './claudeCliEngine';
import {
  ANNOTATED_EXAMPLE,
  buildHarness,
  buildTurnMessage,
  buildTurnText,
  pageRanges,
  planContext,
} from './harness';
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
        mcpServers: [],
      },
    ]);
  });

  it('reports whether the reader tools connected', () => {
    const line = JSON.stringify({
      type: 'system',
      subtype: 'init',
      session_id: 's',
      model: 'm',
      tools: ['mcp__reader__search_book'],
      mcp_servers: [{ name: 'reader', status: 'connected', source: 'dynamic' }],
    });
    const [ready] = parseCliLine(line);
    expect(ready).toMatchObject({ mcpServers: [{ name: 'reader', status: 'connected' }] });
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

  it('pre-approves the reader tools, alone or with web search', () => {
    const tools = buildCliArgs(startOptions({ readerTools: true }));
    expect(tools[tools.indexOf('--tools') + 1]).toBe('');
    expect(tools[tools.indexOf('--allowedTools') + 1]).toBe(
      'mcp__reader__search_book,mcp__reader__get_pages,mcp__reader__get_toc',
    );
    const both = buildCliArgs(startOptions({ readerTools: true, webSearch: true }));
    expect(both[both.indexOf('--allowedTools') + 1]).toBe(
      'WebSearch,mcp__reader__search_book,mcp__reader__get_pages,mcp__reader__get_toc',
    );
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
    expect(buildTurnText('Explique', context(), { includeChapter: true })).toContain('<current-chapter');
    expect(buildTurnText('Explique', context(), { includeChapter: false })).not.toContain('<current-chapter');
  });

  it('always carries the position, the selection and the question', () => {
    const text = buildTurnText('Explique', context(), { includeChapter: false });
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
    }), { includeChapter: false });
    expect(text).toContain('index="1"');
    expect(text).toContain('index="2"');
    expect(text).toContain('premier passage');
    expect(text).toContain('second passage');
  });

  it('falls back to a default question when the reader typed nothing', () => {
    expect(buildTurnText('   ', context(), { includeChapter: false })).toContain('Explique ce passage.');
  });

  it('keeps the position on one line and attribute values free of quotes', () => {
    const text = buildTurnText('q', context({ position: 'p. "2"\n3' }), { includeChapter: false });
    // Quotes are legitimate inside a tag body; only attributes replace them.
    expect(text).toContain('<reading-position>\np. "2" 3 · 6.5 Gaussian Distribution\n</reading-position>');
    expect(text).toContain('location="p. 202"');
  });

  it('escapes quotes and newlines inside attributes', () => {
    const text = buildTurnText('q', context({
      selections: [{ text: 'x', location: 'chapitre "6"\nsuite' }],
    }), { includeChapter: false });
    expect(text).toContain('location="chapitre \'6\' suite"');
  });
});

describe('page window', () => {
  const pages = [196, 197, 198, 199].map((page) => ({ page, text: `texte de la page ${page}` }));

  it('sends every page of the window at first', () => {
    const plan = planContext(context({ pages }), { chapterKey: '', pages: new Set() });
    expect(plan.pages.map((p) => p.page)).toEqual([196, 197, 198, 199]);
    const text = buildTurnText('q', context({ pages }), plan);
    expect(text).toContain('<book-pages pages="196–199">');
    expect(text).toContain('[p. 198]\ntexte de la page 198');
  });

  it('only sends the pages the model has not seen yet', () => {
    const plan = planContext(context({ pages }), { chapterKey: '', pages: new Set([196, 197]) });
    expect(plan.pages.map((p) => p.page)).toEqual([198, 199]);
    const none = planContext(context({ pages }), {
      chapterKey: '',
      pages: new Set([196, 197, 198, 199]),
    });
    expect(none.pages).toEqual([]);
    expect(buildTurnText('q', context({ pages }), none)).not.toContain('<book-pages');
  });

  it('skips pages with no text', () => {
    const plan = planContext(context({ pages: [{ page: 3, text: '  ' }] }), {
      chapterKey: '',
      pages: new Set(),
    });
    expect(plan.pages).toEqual([]);
  });

  it('writes page ranges compactly', () => {
    expect(pageRanges([199, 197, 198, 30])).toBe('30, 197–199');
    expect(pageRanges([5])).toBe('5');
    expect(pageRanges([])).toBe('');
  });
});

describe('composed selections', () => {
  it('numbers images and selections alike, each with its page', () => {
    const message = buildTurnMessage(
      'Compare 1 et 2',
      context({
        selections: [
          { text: 'premier', page: 202, location: '6.5 · p. 202', imageBase64: 'AAAA' },
          { text: 'second', page: 30, location: '2.2 · p. 30' },
          { text: 'troisième', page: 31, location: '2.2 · p. 31', imageBase64: 'BBBB' },
        ],
      }),
      { includeChapter: false },
    );
    const blocks = message.message.content;
    expect(blocks.filter((b) => b.type === 'image')).toHaveLength(2);
    expect(blocks[1]).toEqual({ type: 'text', text: '<selection-image index="1" />' });
    expect(blocks[3]).toEqual({ type: 'text', text: '<selection-image index="3" />' });
    const last = blocks.at(-1);
    const text = last && 'text' in last ? last.text : '';
    expect(text).toContain('<selection index="1" page="202" location="6.5 · p. 202" image="above">');
    expect(text).toContain('<selection index="2" page="30" location="2.2 · p. 30">');
    expect(text).toContain('<selection index="3" page="31"');
  });
});

describe('notation list', () => {
  it('travels once per conversation, first', () => {
    const withNotation = context({ notation: '⊗ produit tensoriel' });
    const first = planContext(withNotation, { chapterKey: '', pages: new Set() });
    expect(first.includeNotation).toBe(true);
    const text = buildTurnText('q', withNotation, first);
    expect(text.indexOf('<book-notation>')).toBe(0);
    const later = planContext(withNotation, { chapterKey: '', pages: new Set(), notation: true });
    expect(later.includeNotation).toBe(false);
    expect(buildTurnText('q', withNotation, later)).not.toContain('<book-notation>');
    expect(planContext(context(), { chapterKey: '', pages: new Set() }).includeNotation).toBe(false);
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

  it('describes the reader tools only when they are given', () => {
    const without = buildHarness({ bookTitle: '', bookAuthor: '', webSearch: false });
    expect(without).toContain('aucun outil');
    expect(without).not.toContain('search_book');
    const tools = buildHarness({
      bookTitle: '',
      bookAuthor: '',
      webSearch: false,
      readerTools: true,
      fixedLayout: true,
    });
    expect(tools).toContain('search_book');
    expect(tools).toContain('get_pages');
    expect(tools).not.toContain('aucun outil');
    // Page references in the answers are what the reader clicks, on a PDF.
    expect(tools).toContain('« p. 208 »');
    expect(buildHarness({ bookTitle: '', bookAuthor: '', webSearch: false })).not.toContain(
      '« p. 208 »',
    );
  });

  it('separates the messages of a turn that used a tool', () => {
    const line = '{"type":"stream_event","event":{"type":"message_start","message":{}}}';
    expect(parseCliLine(line)).toEqual([{ kind: 'message_start' }]);
  });

  it('mentions web search only when it is enabled', () => {
    const harness = buildHarness({ bookTitle: '', bookAuthor: '', webSearch: true });
    expect(harness).toContain('recherche web');
    expect(harness).toContain('un livre technique');
  });

  const renders = (tex: string): boolean => {
    try {
      katex.renderToString(tex, { displayMode: true, throwOnError: true, strict: 'ignore' });
      return true;
    } catch {
      return false;
    }
  };

  it('prescribes only what KaTeX renders', () => {
    const harness = buildHarness({ bookTitle: '', bookAuthor: '', webSearch: false });
    const colours = [...new Set([...harness.matchAll(/#[0-9a-f]{6}/g)].map((m) => m[0]))];
    expect(colours).toHaveLength(5);
    const prescribed = [
      '\\underbrace{a+b}_{\\text{somme}}',
      '\\overbrace{a}^{\\text{terme}}',
      '\\boxed{x}',
      ...colours.map((c) => `\\textcolor{${c}}{x}`),
      '\\overset{\\textcircled{1}}{P(A)}',
      '\\dfrac{\\dfrac{}{\\vdash \\mathsf{0} : \\mathsf{Nat}}\\;\\textsf{(T-Zero)} \\quad t}{\\vdash \\mathsf{succ}\\ \\mathsf{0}}\\;\\textsf{(T-Succ)}',
      ...['aligned', 'cases', 'matrix', 'pmatrix', 'bmatrix'].map(
        (env) => `\\begin{${env}} a & b \\\\ c & d \\end{${env}}`,
      ),
      '\\begin{array}{cc} a & b \\end{array}',
    ];
    for (const tex of prescribed) {
      expect(harness.includes(tex.split(/[{_^ ]/)[0]!), tex).toBe(true);
      expect(renders(tex), tex).toBe(true);
    }
  });

  it('gives an annotated example that KaTeX renders', () => {
    const harness = buildHarness({ bookTitle: '', bookAuthor: '', webSearch: false });
    expect(harness).toContain(ANNOTATED_EXAMPLE);
    expect(renders(ANNOTATED_EXAMPLE.replace(/^\$\$|\$\$$/g, ''))).toBe(true);
  });

  it('forbids what KaTeX cannot render', () => {
    const harness = buildHarness({ bookTitle: '', bookAuthor: '', webSearch: false });
    expect(harness).toContain('Jamais \\(…\\) ni \\[…\\]');
    const forbidden: [string, string][] = [
      ['\\infer', '\\infer{a}{b}'],
      ['\\AxiomC', '\\AxiomC{a}'],
      ['\\xymatrix', '\\xymatrix{a}'],
      ['\\label', 'x \\label{eq}'],
      ['\\eqref', '\\eqref{eq}'],
    ];
    for (const [command, tex] of forbidden) {
      expect(harness, command).toContain(command);
      expect(renders(tex), tex).toBe(false);
    }
  });
});
