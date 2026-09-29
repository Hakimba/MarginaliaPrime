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
import type { ContextPage, ContextPlan, EngineContext, EngineSelection } from './types';

export interface HarnessOptions {
  bookTitle: string;
  bookAuthor: string;
  webSearch: boolean;
}

/**
 * The model follows an example far better than a description: told to colour
 * and label terms, it wrote a plain list. Deliberately not a formula the
 * acceptance tests ask about.
 */
export const ANNOTATED_EXAMPLE = String.raw`$$\underbrace{\textcolor{#e4572e}{\mathbb{E}[X]}}_{\text{espérance}} = \sum_x \underbrace{\textcolor{#1f8dd6}{x}}_{\text{valeur}}\,\underbrace{\textcolor{#2a9d4f}{p(x)}}_{\text{probabilité}}$$`;

export const buildHarness = ({ bookTitle, bookAuthor, webSearch }: HarnessOptions): string => {
  const book = bookTitle
    ? `« ${bookTitle} »${bookAuthor ? ` de ${bookAuthor}` : ''}`
    : 'un livre technique';

  const lines = [
    `Tu accompagnes la lecture de ${book}. Le lecteur t'interroge depuis son lecteur,`,
    'sur un passage qu\'il vient de sélectionner (<selection>) ou par une question libre.',
    'Tu réponds à toute question, y compris hors du livre, comme à une autre.',
    '',
    'Ce que tu reçois à chaque message :',
    '- <reading-position> : où en est le lecteur.',
    '- <selection> : le ou les passages sélectionnés, avec leur page pour un PDF. Plusieurs',
    '  sélections sont numérotées (index) ; le lecteur les désigne par ①, ② ou 1, 2 et peut',
    '  les mettre en relation dans sa question.',
    '- <selection-image> : pour un PDF, l\'image de la zone sélectionnée. Elle est la',
    '  source de vérité : le texte extrait d\'un PDF perd les indices, les exposants, la',
    '  structure des matrices et certains symboles (∫ devient souvent « Z », ≠ devient',
    '  « ̸ = »). En cas de désaccord entre le texte et l\'image, crois l\'image.',
    '- <current-chapter> : le texte du chapitre courant, envoyé une seule fois par',
    '  conversation. Il reste valable pour les messages suivants.',
    '- <book-pages> : pour un PDF, le texte des pages autour du lecteur, chaque page',
    '  précédée de son repère [p. N]. Une page n\'est envoyée qu\'une fois par conversation :',
    '  celles reçues plus tôt restent valables. Ce texte extrait a les mêmes défauts que',
    '  celui d\'une sélection.',
    '',
    'Comment répondre :',
    '- En français, sauf demande contraire. Concis. Commence par la réponse elle-même : ni',
    '  préambule, ni remarque sur le lien entre la question et le chapitre en cours, ni',
    '  conclusion de politesse.',
    '- Quand une <selection> contient des mathématiques, commence par une ligne',
    '  « **Transcription** » suivie de la formule transcrite fidèlement, seule entre $$ et $$,',
    '  sans rien corriger ni simplifier, avant toute explication. Avec plusieurs sélections,',
    '  une ligne « **Transcription 1** », « **Transcription 2** »… par sélection qui en',
    '  contient, avec son numéro.',
    '- Pour parler d\'un signe, donne le caractère Unicode exact (« le signe ⊗ ») plutôt',
    '  qu\'une description approximative.',
    '- Respecte les conventions de notation du livre quand tu les connais.',
    '- Ne réponds pas au-delà de ce que la question demande.',
    '- Si le passage est ambigu ou si l\'image est illisible, dis-le au lieu de deviner.',
    '',
    'Écrire les mathématiques (ta réponse est rendue par KaTeX) :',
    '- Formules entre $…$ dans le texte, entre $$…$$ à part sur leurs propres lignes.',
    '  Jamais \\(…\\) ni \\[…\\]. Pas de ligne vide à l\'intérieur d\'un $$…$$.',
    '- Pour expliquer les termes d\'une formule, réponds par la formule annotée, sur ce',
    '  modèle :',
    `  ${ANNOTATED_EXAMPLE}`,
    '  Une couleur par terme avec \\textcolor, chaque terme légendé par \\underbrace{…}_{\\text{…}}',
    '  ou \\overbrace{…}^{\\text{…}}. Si la formule est trop dense pour des accolades, pose',
    '  plutôt des marqueurs \\overset{\\textcircled{1}}{…} sur les termes colorés. Termine par',
    '  une légende courte, un terme par ligne, dans sa couleur. \\boxed{…} met une partie en',
    '  évidence.',
    '- Couleurs lisibles sur fond clair comme sur fond sombre, uniquement parmi : #e4572e,',
    '  #1f8dd6, #2a9d4f, #b565d8, #d49a00.',
    '- Marqueurs numérotés : \\textcircled{1}, \\textcircled{2}… ; dans la légende, en',
    '  $\\textcircled{1}$. Jamais les caractères ① ② ③, mal rendus.',
    '- Règles d\'inférence et arbres de dérivation : \\dfrac{prémisses}{conclusion} imbriqués,',
    '  prémisses séparées par \\quad, mots-clés en \\mathsf{…}, nom de la règle à droite de',
    '  la barre en \\;\\textsf{(T-Succ)}.',
    '- Environnements permis : aligned, cases, matrix, pmatrix, bmatrix, array.',
    '- Interdits, KaTeX ne les rend pas : bussproofs (\\infer, \\AxiomC), tikz, \\xymatrix,',
    '  \\begin{align} (utilise aligned dans un $$…$$), \\label, \\ref, \\eqref.',
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
  /** Pages to send with this turn: those of the window not sent yet. */
  pages?: ContextPage[];
}

/** What the engine has already given the model in this conversation. */
export interface SentContext {
  chapterKey: string;
  pages: Set<number>;
}

export const chapterKeyOf = (context: EngineContext): string =>
  `${context.chapterTitle}::${context.chapterText.length}`;

/**
 * What the next turn adds to the conversation: the chapter when it changed,
 * and the pages of the window the model has not seen yet.
 */
export const planContext = (context: EngineContext, sent: SentContext): ContextPlan => ({
  includeChapter:
    context.chapterText.trim().length > 0 && chapterKeyOf(context) !== sent.chapterKey,
  pages: (context.pages ?? []).filter((p) => p.text.trim() && !sent.pages.has(p.page)),
});

/** "197–207", or "30, 197–199" for a window with gaps. */
export const pageRanges = (pages: number[]): string => {
  const sorted = [...new Set(pages)].sort((a, b) => a - b);
  const ranges: string[] = [];
  let start = sorted[0];
  let prev = sorted[0];
  for (const n of [...sorted.slice(1), Infinity]) {
    if (start === undefined || prev === undefined) break;
    if (n === prev + 1) {
      prev = n;
      continue;
    }
    ranges.push(start === prev ? `${start}` : `${start}–${prev}`);
    start = n;
    prev = n;
  }
  return ranges.join(', ');
};

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
  options: TurnOptions,
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

  blocks.push({ type: 'text', text: buildTurnText(question, context, options) });
  return { type: 'user', message: { role: 'user', content: blocks } };
};

/** Exposed for the Inspect overlay and for tests. */
export const buildTurnText = (
  question: string,
  context: EngineContext,
  { includeChapter, pages = [] }: TurnOptions,
): string => {
  const parts: string[] = [];

  if (pages.length) {
    const body = [...pages]
      .sort((a, b) => a.page - b.page)
      .map((p) => `[p. ${p.page}]\n${p.text.trim()}`)
      .join('\n\n');
    parts.push(tag('book-pages', body, { pages: pageRanges(pages.map((p) => p.page)) }), '');
  }

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
  if (selection.page) attrs['page'] = String(selection.page);
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
