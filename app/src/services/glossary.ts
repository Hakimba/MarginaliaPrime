import { invoke } from '@tauri-apps/api/core';
import type { EngineEvent } from '@/services/engine/types';

export interface GlossaryEntry {
  term: string;
  latex: string;
  explanation: string;
  /** PDF page or EPUB section, 1-based. */
  page: number;
  /** Last saved time, in Unix milliseconds. */
  date: number;
}

export type GlossaryInput = Omit<GlossaryEntry, 'date'>;

export const loadGlossary = (hash: string): Promise<GlossaryEntry[]> =>
  invoke('book_glossary_load', { hash });

export const addToGlossary = (hash: string, entry: GlossaryInput): Promise<GlossaryEntry[]> =>
  invoke('book_glossary_add', { hash, entry });

/** Each engine keeps its own tool ids and its original book. */
export const observeGlossaryTools = (saved: () => void): ((event: EngineEvent) => void) => {
  const pending = new Set<string>();
  return (event) => {
    if (event.kind === 'tool_use' && event.name === 'mcp__reader__add_to_glossary' && event.id) {
      pending.add(event.id);
    } else if (event.kind === 'tool_result' && event.id && pending.delete(event.id)) {
      if (!event.isError) saved();
    } else if (event.kind === 'done' || event.kind === 'error' || event.kind === 'exit') {
      pending.clear();
    }
  };
};

/**
 * `encodeURIComponent` leaves parentheses alone, and Markdown ends a link at
 * the first unmatched `)`: « [a, b) » would lose its last character.
 */
export const glossaryHref = (term: string): string =>
  `#glossary-${encodeURIComponent(term).replace(/\(/g, '%28').replace(/\)/g, '%29')}`;

/**
 * The formula of an entry, ready to be put between `$$`: without the
 * delimiters a reader or the model may have typed (`$\top$`, `\[…\]`), and
 * without blank lines, which end a display formula in Markdown.
 */
export const displayLatex = (latex: string): string => {
  let body = latex.trim();
  for (const [open, close] of [['$$', '$$'], ['\\[', '\\]'], ['\\(', '\\)'], ['$', '$']]) {
    if (body.length > open!.length + close!.length && body.startsWith(open!) && body.endsWith(close!)) {
      body = body.slice(open!.length, body.length - close!.length).trim();
      break;
    }
  }
  return body.replace(/\n\s*\n/g, '\n');
};

export const glossaryTermFromHref = (href: string): string | null => {
  if (!href.startsWith('#glossary-')) return null;
  try {
    return decodeURIComponent(href.slice('#glossary-'.length)) || null;
  } catch {
    return null;
  }
};
