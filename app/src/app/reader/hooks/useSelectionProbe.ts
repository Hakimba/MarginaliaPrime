'use client';

import { useEffect, useRef } from 'react';

import { useReaderStore } from '@/store/readerStore';
import { getTextFromRange, normalizeSelectedText } from '@/utils/sel';

/**
 * Scripted mouse selections, for judging selection quality without a hand.
 *
 * With MARGINALIA_SELECT_TEST=<page number> in the environment, the reader goes
 * to that page and replays a set of drags — a word, a word with a shaky hand, a
 * whole line, three lines, a line flanked by a marginal note, the note itself —
 * then prints for each what the geometry says should be selected and what the
 * document actually yields, on lines prefixed with `[sel]`.
 *
 * It exercises the same path as the mouse (caret hit-testing, word snapping,
 * the text of a range), but not the browser's own drag heuristics: the feel of
 * a real drag still has to be judged by hand.
 */

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

interface ProbeLine {
  spans: HTMLElement[];
  zone: string;
  top: number;
  bottom: number;
}

/** Lines of a re-ordered PDF text layer: spans up to the next line break. */
const linesOf = (container: Element): ProbeLine[] => {
  const lines: ProbeLine[] = [];
  let spans: HTMLElement[] = [];
  const flush = () => {
    const filled = spans.filter((span) => (span.textContent ?? '').trim());
    if (filled.length) {
      const rects = filled.map((span) => span.getBoundingClientRect());
      lines.push({
        spans: filled,
        zone: filled[0]!.dataset.zone ?? 'body',
        top: Math.min(...rects.map((r) => r.top)),
        bottom: Math.max(...rects.map((r) => r.bottom)),
      });
    }
    spans = [];
  };
  for (const child of Array.from(container.children)) {
    if (child.tagName === 'BR') flush();
    else if (child.tagName === 'SPAN') spans.push(child as HTMLElement);
  }
  flush();
  return lines;
};

/** Visible text of one line, for picking a line worth testing on. */
const textOfLine = (spans: HTMLElement[]): string =>
  spans
    .map((span) => (span.textContent ?? '').trim())
    .join(' ')
    .trim();

/**
 * What a selection covering exactly these lines reads as: the reference the
 * drag is judged against, built from a range instead of a gesture.
 */
const textOfLines = (doc: Document, lines: ProbeLine[]): string => {
  const first = lines[0]!.spans[0]!.firstChild;
  const lastSpans = lines[lines.length - 1]!.spans;
  const last = lastSpans[lastSpans.length - 1]!.firstChild;
  if (!first || !last) return '';
  const range = doc.createRange();
  range.setStart(first, 0);
  range.setEnd(last, (last.nodeValue ?? '').length);
  return normalizeSelectedText(getTextFromRange(range));
};

let lastDetail = '';
/** Zones the last drag actually touched: the exact test for a spill-over. */
let lastZones = new Set<string>();

const mouseEvent = (type: string, x: number, y: number) =>
  new MouseEvent(type, {
    clientX: x,
    clientY: y,
    button: 0,
    buttons: type === 'mouseup' ? 0 : 1,
    detail: 1,
    bubbles: true,
    cancelable: true,
  });

const pointerEvent = (type: string, x: number, y: number, detail = 1) =>
  new PointerEvent(type, {
    clientX: x,
    clientY: y,
    button: 0,
    buttons: type === 'pointerup' ? 0 : 1,
    pointerId: 1,
    pointerType: 'mouse',
    detail,
    bubbles: true,
    cancelable: true,
  });

/**
 * What a drag from one point to another selects, through the reader's own
 * handlers: the same pointer events a mouse produces, then the same reading of
 * the selection that the chat does.
 */
const dragSelect = (
  doc: Document,
  from: { x: number; y: number },
  to: { x: number; y: number },
): string | null => {
  const container = doc.querySelector('.textLayer');
  if (!container) return null;
  lastDetail = '';
  doc.getSelection()?.removeAllRanges();
  container.dispatchEvent(pointerEvent('pointerdown', from.x, from.y));
  container.dispatchEvent(pointerEvent('pointermove', (from.x + to.x) / 2, (from.y + to.y) / 2));
  container.dispatchEvent(pointerEvent('pointermove', to.x, to.y));
  container.dispatchEvent(pointerEvent('pointerup', to.x, to.y));

  const selection = doc.getSelection();
  if (!selection || !selection.rangeCount) return null;
  const range = selection.getRangeAt(0);
  lastZones = new Set<string>();
  for (const span of Array.from(container.querySelectorAll('span'))) {
    if (span.firstChild && range.intersectsNode(span)) {
      lastZones.add((span as HTMLElement).dataset.zone ?? 'body');
    }
  }
  const describe = (node: Node | null) =>
    node ? JSON.stringify((node.nodeValue ?? node.nodeName).slice(0, 14)) : 'none';
  lastDetail =
    ` zones=${[...lastZones].join('+') || 'none'}` +
    ` from=${describe(range.startContainer)}+${range.startOffset}` +
    ` to=${describe(range.endContainer)}+${range.endOffset}`;
  return normalizeSelectedText(getTextFromRange(range));
};

const report = (name: string, expected: string, got: string | null, detail = '') => {
  const verdict = got === null ? 'no-caret' : got === expected ? 'ok' : 'KO';
  console.info(
    `[sel] case=${name} verdict=${verdict} expected=${JSON.stringify(expected)} got=${JSON.stringify(got)}${detail}`,
  );
};

const runProbe = async (doc: Document, view?: unknown) => {
  const container = doc.querySelector('.textLayer');
  if (!container) {
    console.info('[sel] no text layer on this page');
    return;
  }
  const lines = linesOf(container);
  const body = lines.filter((line) => line.zone === 'body');
  const margins = lines.filter((line) => line.zone === 'margin');
  const figures = lines.filter((line) => line.zone === 'figure');
  console.info(
    `[sel] page has ${lines.length} lines, ${margins.length} marginal, ${figures.length} of a graphic`,
  );

  const middle = (line: ProbeLine) => (line.top + line.bottom) / 2;

  // A word, dragged from one edge of it to the other.
  const wordLine = body.find((line) => line.spans.length >= 4);
  const word = wordLine?.spans
    .filter((span) => (span.textContent ?? '').trim().length >= 4)
    .sort((a, b) => (b.textContent ?? '').length - (a.textContent ?? '').length)[0];
  if (wordLine && word) {
    const rect = word.getBoundingClientRect();
    const y = (rect.top + rect.bottom) / 2;
    report(
      'word',
      (word.textContent ?? '').trim(),
      dragSelect(doc, { x: rect.left - 1, y }, { x: rect.right + 1, y }),
      lastDetail,
    );
    // The same word with a shaky hand: the drag ends a third of a line too
    // high, which is a tremble rather than a move to the line above.
    const tremble = Math.max(2, (rect.bottom - rect.top) / 3);
    const jitter = dragSelect(doc, { x: rect.left - 1, y }, { x: rect.right + 1, y: y - tremble });
    report('word-jitter', (word.textContent ?? '').trim(), jitter, lastDetail);
  }

  // A whole line.
  const line = body[Math.floor(body.length / 2)];
  if (line) {
    const first = line.spans[0]!.getBoundingClientRect();
    const last = line.spans[line.spans.length - 1]!.getBoundingClientRect();
    const y = middle(line);
    // Begun just before the first word and released a little past the last, as
    // a hand does.
    const got = dragSelect(doc, { x: first.left - 2, y }, { x: last.right + 4, y });
    report('line', textOfLines(doc, [line]), got, lastDetail);
  }

  // Three consecutive lines.
  const index = Math.floor(body.length / 2);
  if (body.length > index + 2) {
    const from = body[index]!;
    const to = body[index + 2]!;
    const expected = textOfLines(doc, [from, body[index + 1]!, to]);
    const start = from.spans[0]!.getBoundingClientRect();
    const end = to.spans[to.spans.length - 1]!.getBoundingClientRect();
    const got = dragSelect(doc, { x: start.left - 2, y: middle(from) }, { x: end.right + 4, y: middle(to) });
    report('three-lines', expected, got, lastDetail);
  }

  // A line of the body at the height of a marginal note.
  const note = margins[0];
  // The body line closest to the note, which is the one a drag would spill on.
  const flanked = note
    ? body
        .map((candidate) => ({
          candidate,
          gap: Math.abs((candidate.top + candidate.bottom) / 2 - (note.top + note.bottom) / 2),
        }))
        .sort((a, b) => a.gap - b.gap)[0]?.candidate
    : undefined;
  if (note && flanked) {
    const first = flanked.spans[0]!.getBoundingClientRect();
    const last = flanked.spans[flanked.spans.length - 1]!.getBoundingClientRect();
    const y = middle(flanked);
    const got = dragSelect(doc, { x: first.left - 2, y }, { x: last.right + 4, y });
    report('line-next-to-note', textOfLines(doc, [flanked]), got, lastDetail);

    // Then the same line, but released inside the marginal column: the note
    // must stay out of it.
    const noteRect = note.spans[0]!.getBoundingClientRect();
    const intoMargin = dragSelect(
      doc,
      { x: first.left + 1, y },
      { x: noteRect.left + 2, y: (note.top + note.bottom) / 2 },
    );
    console.info(
      `[sel] case=note-not-swallowed verdict=${intoMargin !== null && !lastZones.has('margin') ? 'ok' : 'KO'}` +
        `${lastDetail} got=${JSON.stringify(intoMargin?.slice(-50))}`,
    );
  }

  // The marginal note itself.
  if (note) {
    const first = note.spans[0]!.getBoundingClientRect();
    const last = note.spans[note.spans.length - 1]!.getBoundingClientRect();
    // Begun inside the note: two pixels to its left is the gutter, which
    // belongs to the body column.
    const y = middle(note);
    const got = dragSelect(doc, { x: first.left + 1, y }, { x: last.right + 4, y });
    report('note', textOfLines(doc, [note]), got, lastDetail);
  }

  // A body line released inside a graphic: its lettering must stay out.
  const figure = figures[0];
  const above = figure
    ? [...body].reverse().find((candidate) => candidate.bottom <= figure.top)
    : undefined;
  if (figure && above) {
    const first = above.spans[0]!.getBoundingClientRect();
    const target = figure.spans[Math.floor(figure.spans.length / 2)]!.getBoundingClientRect();
    const got = dragSelect(
      doc,
      { x: first.left + 1, y: middle(above) },
      { x: target.left + 2, y: (target.top + target.bottom) / 2 },
    );
    console.info(
      `[sel] case=graphic-not-swallowed verdict=${got !== null && !lastZones.has('figure') ? 'ok' : 'KO'}` +
        `${lastDetail} got=${JSON.stringify(got?.slice(-50))}`,
    );
  }

  // The lettering itself, selected on purpose.
  if (figure) {
    const first = figure.spans[0]!.getBoundingClientRect();
    const last = figure.spans[figure.spans.length - 1]!.getBoundingClientRect();
    const y = middle(figure);
    const got = dragSelect(doc, { x: first.left - 2, y }, { x: last.right + 4, y });
    report('graphic', textOfLines(doc, [figure]), got, lastDetail);
  }

  // A drag begun in the middle of a word starts there, not at the beginning of
  // the line: a PDF line carries one whitespace item as wide as itself, and it
  // used to swallow the anchor.
  const prose = [...body].sort(
    (a, b) => textOfLine(b.spans).length - textOfLine(a.spans).length,
  )[0];
  if (prose) {
    const first = prose.spans[0]!.getBoundingClientRect();
    const last = prose.spans[prose.spans.length - 1]!.getBoundingClientRect();
    const y = middle(prose);
    const got = dragSelect(doc, { x: (first.left + first.right) / 2, y }, { x: last.right - 2, y });
    const head = textOfLine(prose.spans).slice(0, 4);
    console.info(
      `[sel] case=partial-drag verdict=${got && head && !got.startsWith(head) ? 'ok' : 'KO'}` +
        ` lineStartsWith=${JSON.stringify(head)} got=${JSON.stringify(got?.slice(0, 40))}`,
    );
  }

  // The annotation toolbar must not jump in front of the text on every drag,
  // and must come up on a click on the passage.
  const toolbar = () => !!document.querySelector('.selection-popup');
  // A line of prose, not a row of matrix delimiters: the toolbar cases need a
  // passage a reader would actually click on.
  const target = [...body].sort(
    (a, b) => textOfLine(b.spans).length - textOfLine(a.spans).length,
  )[0];
  if (target) {
    const first = target.spans[0]!.getBoundingClientRect();
    const last = target.spans[target.spans.length - 1]!.getBoundingClientRect();
    const y = middle(target);
    dragSelect(doc, { x: first.left + 1, y }, { x: last.right + 4, y });
    await delay(400);
    console.info(`[sel] case=toolbar-after-drag verdict=${toolbar() ? 'KO' : 'ok'}`);

    // A press that stays put, on the passage: the whole trio a mouse sends,
    // since the reader leans on the compatibility events too.
    const container = doc.querySelector('.textLayer');
    const onPassage = { x: (first.left + last.right) / 2, y };
    const held = doc.getSelection()?.toString() ?? '';
    container?.dispatchEvent(pointerEvent('pointerdown', onPassage.x, onPassage.y));
    container?.dispatchEvent(mouseEvent('mousedown', onPassage.x, onPassage.y));
    container?.dispatchEvent(pointerEvent('pointerup', onPassage.x, onPassage.y));
    container?.dispatchEvent(mouseEvent('mouseup', onPassage.x, onPassage.y));
    await delay(400);
    console.info(
      `[sel] case=toolbar-on-click verdict=${toolbar() ? 'ok' : 'KO'}` +
        ` heldBefore=${JSON.stringify(held.slice(0, 20))} heldAfter=${JSON.stringify((doc.getSelection()?.toString() ?? '').slice(0, 20))}`,
    );
  }

  // A click on the right of the page turns it: the reader listens to the mouse
  // events, which a prevented pointer event would have suppressed.
  const shownPages = () =>
    (
      (view as { renderer?: { getContents?: () => { index?: number }[] } } | undefined)?.renderer
        ?.getContents?.() ?? []
    )
      .map((content) => content.index)
      .join(',');
  const box = doc.documentElement.getBoundingClientRect();
  const click = async () => {
    // The reader posts its single click from the click event, so the whole
    // compatibility trio has to be replayed.
    for (const type of ['mousedown', 'mouseup', 'click']) {
      doc.documentElement.dispatchEvent(
        new MouseEvent(type, {
          clientX: box.width - 6,
          clientY: box.height / 2,
          button: 0,
          bubbles: true,
          cancelable: true,
        }),
      );
    }
    await delay(500);
  };
  // The first clicks put away what the earlier cases left open: a selection,
  // then the bubble. The reader consumes those, so the page turn may take a
  // couple of clicks before it is the only thing left to do.
  doc.getSelection()?.removeAllRanges();
  const before = shownPages();
  let after = before;
  for (let attempt = 0; attempt < 4 && after === before; attempt += 1) {
    await click();
    after = shownPages();
  }
  console.info(
    `[sel] case=page-turn-click verdict=${before && after !== before ? 'ok' : 'KO'}` +
      ` from=${before} to=${after}`,
  );

  doc.getSelection()?.removeAllRanges();
  console.info('[sel] probe done');
};

export const useSelectionProbe = (bookKey: string) => {
  const { getView } = useReaderStore();
  const fired = useRef(false);

  useEffect(() => {
    if (fired.current) return;
    let cancelled = false;
    void (async () => {
      let spec = '';
      try {
        const { invoke } = await import('@tauri-apps/api/core');
        spec = await invoke<string>('get_environment_variable', { name: 'MARGINALIA_SELECT_TEST' });
      } catch {
        return;
      }
      if (!spec || cancelled || fired.current) return;
      fired.current = true;

      const page = Number.parseInt(spec, 10);
      for (let attempt = 0; attempt < 40 && !cancelled; attempt += 1) {
        const view = getView(bookKey);
        const contents = view?.renderer?.getContents?.() ?? [];
        const entry = contents.find(
          (content: { doc?: Document }) => content.doc?.querySelector('.textLayer span'),
        );
        if (entry?.doc) {
          if (Number.isFinite(page) && page > 0) {
            // A PDF section is a page: the view resolves a plain number as a
            // section index.
            await (view as unknown as { goTo: (t: unknown) => Promise<void> }).goTo(page - 1);
            await delay(1500);
          }
          // Two pages are on screen at once: take the one that was asked for.
          const contentsNow: { doc?: Document; index?: number }[] =
            view?.renderer?.getContents?.() ?? [];
          const withText = contentsNow.filter((content) =>
            content.doc?.querySelector('.textLayer span'),
          );
          const target =
            withText.find((content) => content.index === page - 1) ?? withText[0];
          if (target?.doc) {
            console.info(`[sel] probing section ${target.index}`);
            await runProbe(target.doc, view);
          }
          return;
        }
        await delay(500);
      }
      console.info('[sel] no PDF text layer found');
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bookKey]);
};
