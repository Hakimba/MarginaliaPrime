import type { BookDoc, TOCItem } from '@/libs/document';

/**
 * Find the top-level TOC item that contains the given target.
 * If the target is "Section 5.1" nested under "Chapter 5", returns "Chapter 5".
 * If the target is already top-level, returns itself.
 */
export function findTopLevelAncestor(toc: TOCItem[], target: TOCItem): TOCItem | null {
  for (const item of toc) {
    if (item.href === target.href && item.label === target.label) return item;
    if (item.subitems?.length && containsItem(item.subitems, target)) return item;
  }
  return null;
}

function containsItem(items: TOCItem[], target: TOCItem): boolean {
  for (const item of items) {
    if (item.href === target.href && item.label === target.label) return true;
    if (item.subitems?.length && containsItem(item.subitems, target)) return true;
  }
  return false;
}

/**
 * Find the next top-level TOC item after the given one.
 * Used to determine where the current chapter ends.
 */
function findNextTopLevelItem(toc: TOCItem[], current: TOCItem): TOCItem | null {
  const idx = toc.findIndex(
    (item) => item.href === current.href && item.label === current.label,
  );
  if (idx === -1 || idx >= toc.length - 1) return null;
  return toc[idx + 1]!;
}

// Block-level elements that should get their own line breaks
const BLOCK_ELEMENTS = new Set([
  'P', 'DIV', 'SECTION', 'ARTICLE', 'ASIDE', 'MAIN', 'NAV', 'HEADER', 'FOOTER',
  'H1', 'H2', 'H3', 'H4', 'H5', 'H6',
  'BLOCKQUOTE', 'PRE', 'FIGURE', 'FIGCAPTION',
  'UL', 'OL', 'LI', 'DL', 'DT', 'DD',
  'TABLE', 'TR', 'TH', 'TD',
  'HR', 'BR',
]);

/**
 * Math containers produced by the usual LaTeX-to-EPUB toolchains. Their text is
 * wrapped in LaTeX delimiters and padded with spaces: books generated this way
 * often have no whitespace between a formula and the surrounding words, which
 * would otherwise yield "isΩ = ωω" glued to the previous sentence.
 */
const MATH_SELECTOR = 'math, mjx-container, .MathJax, .math, .texhtml, .mathjax';
const DISPLAY_MATH_HINT = /\b(display|equation|eqn|numberedeq)\b/i;

/** A footnote or endnote reference: rendered as [n] instead of glued digits. */
const NOTE_REF_SELECTOR =
  'a[role="doc-noteref"], a.footnote-ref, a.noteref, sup > a[href^="#"], a[epub\\:type="noteref"]';

const HEADING_LEVELS: Record<string, string> = {
  H1: '# ',
  H2: '## ',
  H3: '### ',
  H4: '#### ',
  H5: '##### ',
  H6: '###### ',
};

/** `Element.matches` is missing on some nodes of a detached document. */
function matches(el: Element, selector: string): boolean {
  try {
    return typeof el.matches === 'function' && el.matches(selector);
  } catch {
    return false;
  }
}

/**
 * Convert a DOM subtree to structured plain text suitable for LLM context.
 * Preserves headings, paragraphs, list items and blockquotes as markdown-like
 * formatting, formulas as LaTeX, and footnote references as [n].
 */
export function domToStructuredText(node: Node): string {
  const parts: string[] = [];

  function walk(n: Node) {
    if (n.nodeType === Node.TEXT_NODE) {
      const text = n.nodeValue?.replace(/[\t\n\r]+/g, ' ') ?? '';
      if (text.trim()) {
        parts.push(text);
      }
      return;
    }

    if (n.nodeType !== Node.ELEMENT_NODE) return;

    const el = n as Element;
    const tag = el.tagName;

    // Skip hidden elements, scripts, styles
    if (tag === 'SCRIPT' || tag === 'STYLE' || tag === 'NOSCRIPT') return;

    // Footnote reference: keep it readable and out of the sentence.
    if (matches(el, NOTE_REF_SELECTOR)) {
      const label = el.textContent?.trim();
      parts.push(label ? ` [${label}] ` : ' ');
      return;
    }

    // Math: emit LaTeX delimiters and stop descending.
    if (matches(el, MATH_SELECTOR)) {
      const formula = (el.textContent ?? '').replace(/\s+/g, ' ').trim();
      if (formula) {
        const display =
          el.getAttribute('display') === 'block' || DISPLAY_MATH_HINT.test(el.className || '');
        parts.push(display ? `\n\n$$${formula}$$\n\n` : ` $${formula}$ `);
      }
      return;
    }

    const isBlock = BLOCK_ELEMENTS.has(tag);

    if (tag === 'BR') {
      parts.push('\n');
      return;
    }

    if (tag === 'HR') {
      parts.push('\n\n---\n\n');
      return;
    }

    if (isBlock) {
      parts.push('\n\n');
    }

    // Add markdown-style prefixes
    const headingPrefix = HEADING_LEVELS[tag];
    if (headingPrefix) {
      parts.push(headingPrefix);
    } else if (tag === 'LI') {
      // Determine if ordered or unordered
      const parent = el.parentElement;
      if (parent?.tagName === 'OL') {
        const index = Array.from(parent.children).indexOf(el) + 1;
        parts.push(`${index}. `);
      } else {
        parts.push('- ');
      }
    } else if (tag === 'BLOCKQUOTE') {
      parts.push('> ');
    }

    for (const child of el.childNodes) {
      walk(child);
    }

    if (isBlock) {
      parts.push('\n\n');
    }
  }

  walk(node);

  // Clean up: collapse multiple blank lines, trim
  return parts
    .join('')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n /g, '\n')
    .replace(/ \n/g, '\n')
    .trim();
}

/**
 * Extract the DOM content of a section between two optional anchor IDs.
 * If startId is provided, extraction begins at that element.
 * If endId is provided, extraction stops before that element.
 */
function extractRangeText(doc: Document, startId: string | null, endId: string | null): string {
  const body = doc.body ?? doc.documentElement;
  if (!body) return '';

  // No anchors — use the full body
  if (!startId && !endId) {
    return domToStructuredText(body);
  }

  // Create a range covering the desired portion
  const range = doc.createRange();

  if (startId) {
    const startEl = doc.getElementById(startId);
    if (startEl) {
      range.setStartBefore(startEl);
    } else {
      range.setStartBefore(body.firstChild ?? body);
    }
  } else {
    range.setStartBefore(body.firstChild ?? body);
  }

  if (endId) {
    const endEl = doc.getElementById(endId);
    if (endEl) {
      range.setEndBefore(endEl);
    } else {
      range.setEndAfter(body.lastChild ?? body);
    }
  } else {
    range.setEndAfter(body.lastChild ?? body);
  }

  const fragment = range.cloneContents();
  // Wrap in a temporary element for text extraction
  const wrapper = doc.createElement('div');
  wrapper.appendChild(fragment);

  return domToStructuredText(wrapper);
}

/** Concatenate the structured text of a range of sections, inclusive. */
async function collectSections(bookDoc: BookDoc, first: number, last: number): Promise<string> {
  const parts: string[] = [];
  for (let i = first; i <= last; i += 1) {
    const section = bookDoc.sections[i];
    if (!section?.createDocument) continue;
    try {
      const doc = await section.createDocument();
      if (!doc) continue;
      const text = domToStructuredText(doc.body ?? doc.documentElement);
      if (text) parts.push(text);
    } catch {
      // A page that fails to load is skipped rather than losing the window.
    }
  }
  return parts.join('\n\n');
}

/**
 * Resolve a TOC href into a section index and optional fragment ID.
 * Handles the async case (PDF) transparently.
 */
async function resolveTocHref(
  bookDoc: BookDoc,
  href: string | undefined,
): Promise<{ sectionId: string | number | null; fragment: string | null }> {
  if (!href) return { sectionId: null, fragment: null };

  const result = await Promise.resolve(bookDoc.splitTOCHref(href));
  const sectionId = result[0] ?? null;
  const fragment = result[1] != null ? String(result[1]) : null;

  return { sectionId, fragment };
}

/**
 * Find the index in bookDoc.sections for a given section ID.
 */
function findSectionIndex(bookDoc: BookDoc, sectionId: string | number | null): number {
  if (sectionId == null) return -1;
  return bookDoc.sections.findIndex((s) => s.id === sectionId || s.id === String(sectionId));
}

/**
 * Extract the full text of a chapter, identified by a TOC item, from the book.
 *
 * Uses `createDocument()` to load section DOMs independently of the renderer,
 * resolves chapter boundaries from the TOC, and converts to structured text.
 */
export interface ChapterExtractionOptions {
  /** Index of the section the reader is currently in; used to center the window. */
  currentSectionIdx?: number;
  /**
   * Hard cap on the number of sections extracted. A top-level TOC entry can span
   * hundreds of PDF pages (a "Part"); extracting them all costs seconds on the
   * main thread and floods the model context. Default 40.
   */
  maxSections?: number;
  /**
   * For a fixed-layout book (PDF), one section is one page and the table of
   * contents is unreliable as a boundary: a top-level entry is often a whole
   * "Part". Take this many pages on each side of the reader instead, which is
   * both cheaper and closer to what the question is about.
   */
  pageWindow?: number;
}

export async function extractChapterText(
  bookDoc: BookDoc,
  tocItem: TOCItem | undefined | null,
  toc: TOCItem[] | undefined,
  options: ChapterExtractionOptions = {},
): Promise<string> {
  if (!bookDoc.sections?.length) return '';
  const maxSections = Math.max(1, options.maxSections ?? 40);

  // Fixed layout: a window of pages around the reader, no TOC involved.
  if (options.pageWindow && options.currentSectionIdx != null) {
    const half = Math.max(1, options.pageWindow);
    const cur = options.currentSectionIdx;
    const first = Math.max(0, cur - half);
    const last = Math.min(bookDoc.sections.length - 1, cur + half);
    return collectSections(bookDoc, first, last);
  }

  if (!tocItem?.href || !toc) return '';

  try {
    // Always extract the full top-level chapter, even if we're in a subsection
    const topLevelItem = findTopLevelAncestor(toc, tocItem) ?? tocItem;
    const nextItem = findNextTopLevelItem(toc, topLevelItem);

    // Resolve start boundary
    const start = await resolveTocHref(bookDoc, topLevelItem.href);
    if (start.sectionId == null) return '';

    const startSectionIdx = findSectionIndex(bookDoc, start.sectionId);
    if (startSectionIdx === -1) return '';

    // Resolve end boundary
    const end = nextItem ? await resolveTocHref(bookDoc, nextItem.href) : { sectionId: null, fragment: null };
    const endSectionIdx = end.sectionId != null ? findSectionIndex(bookDoc, end.sectionId) : -1;

    const textParts: string[] = [];

    // Determine how many sections to process.
    // Only include the end section if it has a fragment anchor (chapter boundary is mid-section).
    // Otherwise the end section belongs entirely to the next chapter — stop before it.
    let lastSectionIdx: number;
    if (endSectionIdx === -1) {
      lastSectionIdx = startSectionIdx;
    } else if (end.fragment) {
      lastSectionIdx = endSectionIdx;
    } else {
      lastSectionIdx = endSectionIdx - 1;
    }

    // Cap the span: keep a window of at most `maxSections` sections around the
    // reader's current section (or from the chapter start when unknown).
    let firstIdx = startSectionIdx;
    if (lastSectionIdx - startSectionIdx + 1 > maxSections) {
      const cur = options.currentSectionIdx;
      if (cur != null && cur >= startSectionIdx && cur <= lastSectionIdx) {
        const half = Math.floor(maxSections / 2);
        firstIdx = Math.max(startSectionIdx, Math.min(cur - half, lastSectionIdx - maxSections + 1));
      }
      lastSectionIdx = Math.min(lastSectionIdx, firstIdx + maxSections - 1);
    }

    for (let i = firstIdx; i <= lastSectionIdx; i++) {
      const section = bookDoc.sections[i];
      if (!section?.createDocument) continue;

      const doc = await section.createDocument();
      if (!doc) continue;

      const isFirstSection = i === startSectionIdx;
      const isLastSection = i === lastSectionIdx;

      // Determine start/end anchors for this section
      const sectionStartId = isFirstSection ? (start.fragment ?? null) : null;
      // Only apply end fragment if the end is in this same section
      const sectionEndId = isLastSection && endSectionIdx !== -1 ? (end.fragment ?? null) : null;

      const text = extractRangeText(doc, sectionStartId, sectionEndId);
      if (text) textParts.push(text);
    }

    return textParts.join('\n\n');
  } catch (e) {
    console.warn('Chapter text extraction failed:', e);
    return '';
  }
}
