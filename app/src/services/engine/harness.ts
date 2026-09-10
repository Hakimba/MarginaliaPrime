/**
 * Builds what the model reads: the stable system prompt (the "harness") and
 * the per-turn user message.
 *
 * Two constraints shape this file.
 *
 * 1. The CLI snapshots the system prompt on the first request of a session and
 *    reuses it verbatim afterwards, so nothing that varies per turn may live
 *    there: reading position, selections and the chapter text all travel in
 *    the user message.
 * 2. A top-level table-of-contents entry can span hundreds of pages, so the
 *    chapter text is sent once per conversation (and again when the chapter
 *    changes) rather than on every turn. The CLI keeps the history, so one copy
 *    stays in the cached prefix.
 */
import type { EngineContext, EngineSelection } from './types';

export interface HarnessOptions {
  bookTitle: string;
  bookAuthor: string;
  webSearch: boolean;
}

export const buildHarness = ({ bookTitle, bookAuthor, webSearch }: HarnessOptions): string => {
  const book = bookTitle
    ? `« ${bookTitle} »${bookAuthor ? ` de ${bookAuthor}` : ''}`
    : 'un livre technique';

  const lines = [
    `Tu accompagnes la lecture de ${book}. Le lecteur t'interroge depuis son lecteur,`,
    'sur un passage qu\'il vient de sélectionner.',
    '',
    'Ce que tu reçois à chaque message :',
    '- <reading-position> : où en est le lecteur.',
    '- <selection> : le ou les passages sélectionnés. Plusieurs sélections peuvent être',
    '  mises en relation par la question.',
    '- <selection-image> : pour un PDF, l\'image de la zone sélectionnée. Elle est la',
    '  source de vérité : le texte extrait d\'un PDF perd les indices, les exposants, la',
    '  structure des matrices et certains symboles (∫ devient souvent « Z », ≠ devient',
    '  « ̸ = »). En cas de désaccord entre le texte et l\'image, crois l\'image.',
    '- <current-chapter> : le texte du chapitre courant, envoyé une seule fois par',
    '  conversation. Il reste valable pour les messages suivants.',
    '',
    'Comment répondre :',
    '- En français, sauf demande contraire. Concis, sans préambule ni conclusion de politesse.',
    '- Quand la sélection contient des mathématiques, commence par une transcription fidèle',
    '  en LaTeX, entre $$ et $$, avant toute explication.',
    '- Écris les formules en LaTeX entre $ et $ dans le texte, entre $$ et $$ à part.',
    '- Pour parler d\'un signe, donne le caractère Unicode exact (« le signe ⊗ ») plutôt',
    '  qu\'une description approximative.',
    '- Respecte les conventions de notation du livre quand tu les connais.',
    '- Ne réponds pas au-delà de ce que la question demande.',
    '- Si le passage est ambigu ou si l\'image est illisible, dis-le au lieu de deviner.',
    '',
    'Tu ne disposes d\'aucun outil : pas de lecture de fichiers, pas de commandes, pas de',
    'mémoire hors de cette conversation. N\'écris jamais de balise d\'appel d\'outil dans ta',
    'réponse. Si une information te manque, dis-le en une phrase.',
  ];

  if (webSearch) {
    lines.push(
      '',
      'Exception : tu disposes de la recherche web. Utilise-la pour un fait extérieur au',
      'livre, pas pour ce que le chapitre fourni permet déjà de répondre.',
    );
  }

  return `${lines.join('\n')}\n`;
};

export interface TurnOptions {
  /** Include the chapter text: first turn, or the chapter changed. */
  includeChapter: boolean;
}

/** A content block of the CLI's user message. */
export type TurnBlock =
  | { type: 'text'; text: string }
  | { type: 'image'; source: { type: 'base64'; media_type: string; data: string } };

/** The JSON object written to the CLI stdin for one turn. */
export interface TurnMessage {
  type: 'user';
  message: { role: 'user'; content: TurnBlock[] };
}

export const buildTurnMessage = (
  question: string,
  context: EngineContext,
  { includeChapter }: TurnOptions,
): TurnMessage => {
  const blocks: TurnBlock[] = [];

  // Images first: the model reads them as the reference for the text below.
  context.selections.forEach((selection, index) => {
    if (!selection.imageBase64) return;
    blocks.push({
      type: 'image',
      source: { type: 'base64', media_type: 'image/png', data: selection.imageBase64 },
    });
    blocks.push({
      type: 'text',
      text: `<selection-image index="${index + 1}" />`,
    });
  });

  blocks.push({ type: 'text', text: buildTurnText(question, context, includeChapter) });
  return { type: 'user', message: { role: 'user', content: blocks } };
};

/** Exposed for the Inspect overlay and for tests. */
export const buildTurnText = (
  question: string,
  context: EngineContext,
  includeChapter: boolean,
): string => {
  const parts: string[] = [];

  if (includeChapter && context.chapterText.trim()) {
    parts.push(
      tag('current-chapter', context.chapterText.trim(), {
        title: context.chapterTitle,
      }),
      '',
    );
  }

  const position = [context.position, context.chapterTitle].filter(Boolean).join(' · ');
  // One line: the reader position is a label, not a document.
  if (position) parts.push(tag('reading-position', oneLine(position)), '');

  context.selections.forEach((selection, index) => {
    parts.push(selectionBlock(selection, index + 1, context.selections.length > 1), '');
  });

  parts.push(tag('question', question.trim() || 'Explique ce passage.'));
  return parts.join('\n');
};

const selectionBlock = (selection: EngineSelection, index: number, numbered: boolean): string => {
  const attrs: Record<string, string> = {};
  if (numbered) attrs['index'] = String(index);
  if (selection.location) attrs['location'] = selection.location;
  if (selection.imageBase64) attrs['image'] = 'above';

  const chunks = [tag('selection', selection.text.trim(), attrs)];
  if (selection.surroundingText?.trim()) {
    chunks.push(
      tag('selection-surroundings', selection.surroundingText.trim(), {
        ...(numbered ? { index: String(index) } : {}),
      }),
    );
  }
  return chunks.join('\n');
};

const tag = (name: string, body: string, attrs: Record<string, string> = {}): string => {
  const rendered = Object.entries(attrs)
    .filter(([, value]) => value)
    .map(([key, value]) => ` ${key}="${escapeAttr(value)}"`)
    .join('');
  return `<${name}${rendered}>\n${body}\n</${name}>`;
};

const oneLine = (value: string): string => value.replace(/\s+/g, ' ').trim();

const escapeAttr = (value: string): string => oneLine(value).replace(/"/g, "'");
