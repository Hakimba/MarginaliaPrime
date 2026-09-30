/**
 * Markdown with mathematics, for the chat panel.
 *
 * The model writes LaTeX between `$…$` and `$$…$$`, and often between `\(…\)`
 * and `\[…\]` despite being asked not to. All four are recognised here, by a
 * marked extension rather than a textual pre-pass: marked has already set code
 * spans and code blocks aside by the time an extension sees the text, so a
 * `$` or a `\(` inside code is never touched.
 *
 * Delimiter rules follow Pandoc's, which read French prose correctly where
 * `marked-katex-extension` did not (it wants a space before the opening `$`
 * and one of `?!.,:` or a space after the closing one, so "(où $x$)" or
 * "l'$x$" stayed raw):
 * - an opening `$` is followed by a non-space and not preceded by a digit;
 * - a closing `$` is preceded by a non-space and not followed by a digit.
 * So "5$ et 10$" and "5$/mois et 3$/an" stay text.
 *
 * Display math never contains a blank line (TeX itself forbids a paragraph
 * break in math mode), which keeps a formula still being streamed from
 * swallowing the text that follows it.
 */
import katex from 'katex';
import DOMPurify from 'dompurify';
import { Marked, type TokenizerAndRendererExtension, type Tokens } from 'marked';

interface MathToken extends Tokens.Generic {
  type: 'inlineMath' | 'blockMath';
  raw: string;
  text: string;
  displayMode: boolean;
}

/** `(?:(?!\n[ \t]*\n)[\s\S])` : any character that does not start a blank line. */
const NO_BLANK = String.raw`(?:(?!\n[ \t]*\n)[\s\S])`;

const BLOCK_RULES: RegExp[] = [
  new RegExp(String.raw`^ {0,3}\$\$(${NO_BLANK}+?)\$\$[ \t]*(?:\n+|$)`),
  new RegExp(String.raw`^ {0,3}\\\[(${NO_BLANK}+?)\\\][ \t]*(?:\n+|$)`),
];

const INLINE_DISPLAY_RULES: RegExp[] = [
  new RegExp(String.raw`^\$\$(${NO_BLANK}+?)\$\$`),
  new RegExp(String.raw`^\\\[(${NO_BLANK}+?)\\\]`),
];

const INLINE_PAREN_RULE = new RegExp(String.raw`^\\\((${NO_BLANK}+?)\\\)`);

/**
 * `$…$`: non-space after the opening, non-space before the closing, no digit
 * after it. The last unit may be an escape (`$\{x\}$`), and `\$` never closes.
 */
const INLINE_DOLLAR_RULE = /^\$(?=[^\s$])((?:\\[\s\S]|[^\\$])*?(?:\\\S|[^\s\\$]))\$(?!\d)/;

/**
 * Where an inline formula may start: `$` not preceded by a digit, a backslash
 * or another `$`, `\(`, `\[`. Only a candidate: the tokenizer decides, and
 * marked carries on with plain text when it declines. Trying the match here
 * made every unclosed `\(` rescan the rest of the paragraph (four seconds for
 * two thousand of them, on every streamed chunk).
 */
const inlineStart = (src: string): number | undefined => {
  for (let i = 0; i < src.length; i += 1) {
    const c = src[i];
    if (c === '$') {
      const before = i > 0 ? src[i - 1]! : '';
      if (before === '\\' || before === '$' || /\d/.test(before)) continue;
      return i;
    }
    if (c === '\\') {
      if (src[i + 1] === '(' || src[i + 1] === '[') return i;
      // An escaped character, `\$` included, is never a delimiter.
      i += 1;
    }
  }
  return undefined;
};

const matchInline = (src: string): { raw: string; text: string; displayMode: boolean } | null => {
  for (const rule of INLINE_DISPLAY_RULES) {
    const m = rule.exec(src);
    if (m && m[1]!.trim()) return { raw: m[0], text: m[1]!.trim(), displayMode: true };
  }
  const paren = INLINE_PAREN_RULE.exec(src);
  if (paren && paren[1]!.trim()) return { raw: paren[0], text: paren[1]!.trim(), displayMode: false };
  if (src.startsWith('$$')) return null;
  const dollar = INLINE_DOLLAR_RULE.exec(src);
  if (dollar) return { raw: dollar[0], text: dollar[1]!, displayMode: false };
  return null;
};

const blockMath: TokenizerAndRendererExtension = {
  name: 'blockMath',
  level: 'block',
  tokenizer(src) {
    for (const rule of BLOCK_RULES) {
      const m = rule.exec(src);
      if (m && m[1]!.trim()) {
        return { type: 'blockMath', raw: m[0], text: m[1]!.trim(), displayMode: true } as MathToken;
      }
    }
    return undefined;
  },
  renderer(token) {
    return `${slot((token as MathToken).text, true)}\n`;
  },
};

const inlineMath: TokenizerAndRendererExtension = {
  name: 'inlineMath',
  level: 'inline',
  start: inlineStart,
  tokenizer(src) {
    const m = matchInline(src);
    return m ? ({ type: 'inlineMath', ...m } as MathToken) : undefined;
  },
  renderer(token) {
    const { text, displayMode } = token as MathToken;
    return slot(text, displayMode);
  },
};

/**
 * « p. 208 », « p. 203–205 », « pp. 12-14 »: a page of the book, rendered as a
 * link the chat panel follows. Not after a letter or a digit (« app. 3 »).
 */
const PAGE_REF = /^(pp?\.)[ \u00a0]?(\d{1,4})(?:[ \u00a0]?[–-][ \u00a0]?(\d{1,4}))?(?!\d)/;
const PAGE_REF_START = /(?<![\p{L}\p{N}])pp?\.[ \u00a0]?\d/u;

interface PageRefToken extends Tokens.Generic {
  first: number;
}

/** Page links are rendered for a PDF only: an EPUB has no pages to go to. */
let pageLinks = false;

const pageRef: TokenizerAndRendererExtension = {
  name: 'pageRef',
  level: 'inline',
  start(src) {
    if (!pageLinks) return undefined;
    const m = PAGE_REF_START.exec(src);
    return m ? m.index : undefined;
  },
  tokenizer(src, tokens) {
    if (!pageLinks || this.lexer.state.inLink) return undefined;
    const m = PAGE_REF.exec(src);
    if (!m) return undefined;
    // `start` sees the text from where marked resumes, not what came before:
    // « **Ste**p. 3 » must stay text.
    const before = tokens.at(-1)?.raw.slice(-1) ?? '';
    if (/[\p{L}\p{N}*_]/u.test(before)) return undefined;
    return { type: 'pageRef', raw: m[0], first: Number(m[2]) } as PageRefToken;
  },
  renderer(token) {
    const { raw, first } = token as PageRefToken;
    return `<a class="page-ref" href="#page-${first}" data-page="${first}" title="Aller à la page ${first}">${escapeHtml(raw)}</a>`;
  },
};

/**
 * Formulas of the parse in progress. The renderer leaves a placeholder in the
 * HTML and the formula is put back after sanitising: KaTeX's output is large
 * (about 2 kB a formula) and running DOMPurify over all of it on every
 * streamed chunk cost 95% of the rendering time. Each formula is sanitised on
 * its own, once, when it enters the cache. The placeholder carries a random
 * nonce per parse, so text from the model can never pose as one.
 */
let pending: { nonce: string; html: string[] } | null = null;

const slot = (tex: string, displayMode: boolean): string => {
  const html = renderMath(tex, displayMode);
  if (!pending) return html;
  pending.html.push(html);
  return `<span data-math-slot="${pending.nonce}-${pending.html.length - 1}"></span>`;
};

/**
 * Rendered and sanitised formulas by source. While an answer streams, the
 * whole text is parsed again on every chunk; without this every formula
 * already received would be typeset again each time.
 */
const cache = new Map<string, string>();
const CACHE_LIMIT = 1000;

const renderMath = (tex: string, displayMode: boolean): string => {
  const key = `${displayMode ? 'D' : 'I'}${tex}`;
  const hit = cache.get(key);
  if (hit !== undefined) return hit;

  let html: string;
  try {
    html = katex.renderToString(tex, {
      displayMode,
      // HTML only: the MathML copy is invisible, and it is the one part of
      // KaTeX's output that DOMPurify alters.
      output: 'html',
      // A parse error shows the source in red instead of throwing.
      throwOnError: false,
      // Non-standard input the model uses (Unicode letters in math) is fine.
      strict: 'ignore',
      trust: false,
      maxExpand: 1000,
      maxSize: 50,
    });
  } catch {
    // Errors that are not parse errors (limits exceeded) still throw.
    html = `<code class="math-error">${escapeHtml(tex)}</code>`;
  }

  html = DOMPurify.sanitize(html);
  if (cache.size >= CACHE_LIMIT) cache.delete(cache.keys().next().value!);
  cache.set(key, html);
  return html;
};

const escapeHtml = (value: string): string =>
  value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

// A dedicated instance: notes and the Markdown export use the global `marked`
// and must not start reading dollar signs as mathematics.
const chatMarked = new Marked({ gfm: true, breaks: false });
chatMarked.use({
  extensions: [blockMath, inlineMath, pageRef],
  renderer: {
    // An alt attribute is plain text. Marked renders it from the inline
    // tokens, formulas included, which put a formula's markup inside the
    // attribute; the source text is what belongs there.
    image({ href, title, text }) {
      const titleAttr = title ? ` title="${escapeHtml(title)}"` : '';
      return `<img src="${escapeHtml(href)}" alt="${escapeHtml(text)}"${titleAttr}>`;
    },
  },
});

const newNonce = (): string => {
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
};

/** Markdown and mathematics to sanitised HTML. Parse first, sanitise last. */
export const renderChatMarkdown = (
  content: string,
  options: { pageLinks?: boolean } = {},
): string => {
  const parse = { nonce: newNonce(), html: [] as string[] };
  pending = parse;
  pageLinks = options.pageLinks ?? false;
  let html: string;
  try {
    html = chatMarked.parse(content, { async: false }) as string;
  } finally {
    pending = null;
    pageLinks = false;
  }
  const clean = DOMPurify.sanitize(html);
  if (!parse.html.length) return clean;
  const placeholder = new RegExp(`<span data-math-slot="${parse.nonce}-(\\d+)"></span>`, 'g');
  return clean.replace(placeholder, (_, index: string) => parse.html[Number(index)] ?? '');
};
