/**
 * Where the image of each passage goes back in an answer: above the
 * "**Transcription**" line the harness asks for, so the reader checks the
 * transcription against the page. With several passages the model numbers
 * them ("**Transcription 2**"); an unnumbered one follows the order.
 */

/**
 * "**Transcription**" or "**Transcription 2**" at the start of a line, the
 * number right after the word: "**Transcription** (éq. 6.82)" is passage 1,
 * not passage 6. Four spaces would make the rest of the piece a code block.
 */
const TRANSCRIPTION = /^ {0,3}\*\*Transcription(?:\s*\(?(\d+)\)?)?\b[^\n]*$/gm;

/** Offsets where a ``` fence opens or closes. */
const fences = (content: string): number[] =>
  [...content.matchAll(/^ {0,3}(```|~~~)/gm)].map((m) => m.index);

export interface AnswerPiece {
  /** Markdown of this piece. */
  content: string;
  /** Index of the passage whose image goes above it, if any. */
  passage?: number;
}

/** The answer cut before each transcription; one piece when there is none. */
export const splitTranscriptions = (content: string): AnswerPiece[] => {
  // A mark inside a fenced block is code, not a heading of the answer.
  const fenceAt = fences(content);
  const marks = [...content.matchAll(TRANSCRIPTION)].filter(
    (m) => fenceAt.filter((f) => f < m.index).length % 2 === 0,
  );
  if (!marks.length) return [{ content }];
  const pieces: AnswerPiece[] = [];
  const head = content.slice(0, marks[0]!.index);
  if (head.trim()) pieces.push({ content: head });
  marks.forEach((mark, j) => {
    const end = marks[j + 1]?.index ?? content.length;
    pieces.push({
      content: content.slice(mark.index, end),
      passage: (mark[1] ? Number(mark[1]) : j + 1) - 1,
    });
  });
  return pieces;
};
