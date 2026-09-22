interface Frame {
  top: number;
  left: number;
}

export interface Rect {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

export interface Point {
  x: number;
  y: number;
}

export type PositionDir = 'up' | 'down' | 'left' | 'right';

export interface Position {
  point: Point;
  dir?: PositionDir;
}

export interface TextSelection {
  key: string;
  text: string;
  page: number;
  range: Range;
  index: number;
  cfi?: string;
  href?: string;
  annotated?: boolean;
  rect?: Rect;
  /**
   * A selection that was just dragged: recorded, highlighted, but without the
   * annotation toolbar. The toolbar is for a deliberate click on the passage,
   * not for every drag of the mouse.
   */
  quiet?: boolean;
}

const frameRect = (frame: Frame, rect?: Rect, sx = 1, sy = 1) => {
  if (!rect) return { left: 0, right: 0, top: 0, bottom: 0 };
  const left = sx * rect.left + frame.left;
  const right = sx * rect.right + frame.left;
  const top = sy * rect.top + frame.top;
  const bottom = sy * rect.bottom + frame.top;
  return { left, right, top, bottom };
};

const pointIsInView = ({ x, y }: Point) =>
  x > 0 && y > 0 && x < window.innerWidth && y < window.innerHeight;

const getIframeElement = (nodeElement: Range | Element): HTMLIFrameElement | null => {
  let node: Node | null;
  if (nodeElement && typeof nodeElement === 'object' && 'tagName' in nodeElement) {
    node = nodeElement as Element;
  } else if (nodeElement && typeof nodeElement === 'object' && 'collapse' in nodeElement) {
    node = nodeElement.commonAncestorContainer;
  } else {
    node = nodeElement;
  }
  while (node) {
    if (node.nodeType === Node.DOCUMENT_NODE) {
      const doc = node as Document;
      if (doc.defaultView && doc.defaultView.frameElement) {
        return doc.defaultView.frameElement as HTMLIFrameElement;
      }
    }
    node = node.parentNode;
  }

  return null;
};

const constrainPointWithinRect = (point: Point, rect: Rect, padding: number) => {
  return {
    x: Math.max(padding, Math.min(point.x, rect.right - rect.left - padding)),
    y: Math.max(padding, Math.min(point.y, rect.bottom - rect.top - padding)),
  };
};

/**
 * Whether a point lands on a range, to the pixel.
 *
 * `isPointerInsideSelection` below allows fifty pixels around the passage,
 * which is right for telling apart the end of a drag from an unrelated click,
 * but far too loose to decide that the reader clicked *on* a passage.
 */
export const isPointerOnRange = (range: Range, x: number, y: number, padding = 2) => {
  const rects = range.getClientRects();
  for (let i = 0; i < rects.length; i++) {
    const rect = rects[i]!;
    if (
      x >= rect.left - padding &&
      x <= rect.right + padding &&
      y >= rect.top - padding &&
      y <= rect.bottom + padding
    ) {
      return true;
    }
  }
  return false;
};

export const isPointerInsideSelection = (selection: Selection, ev: PointerEvent) => {
  if (selection.rangeCount === 0) return false;
  const range = selection.getRangeAt(0);
  const rects = range.getClientRects();
  const padding = 50;
  for (let i = 0; i < rects.length; i++) {
    const rect = rects[i]!;
    if (
      ev.clientX >= rect.left - padding &&
      ev.clientX <= rect.right + padding &&
      ev.clientY >= rect.top - padding &&
      ev.clientY <= rect.bottom + padding
    ) {
      return true;
    }
  }
  return false;
};

export const getPosition = (
  targetElement: Range | Element | TextSelection,
  rect: Rect,
  paddingPx: number,
  isVertical: boolean = false,
) => {
  const { range: target, rect: targetRect } =
    targetElement && 'range' in targetElement
      ? targetElement
      : { range: targetElement, rect: undefined };
  const frameElement = getIframeElement(target);
  const transform = frameElement ? getComputedStyle(frameElement).transform : '';
  const match = transform.match(/matrix\((.+)\)/);
  const [sx, , , sy] = match?.[1]?.split(/\s*,\s*/)?.map((x) => parseFloat(x)) ?? [];

  const frame = frameElement?.getBoundingClientRect() ?? { top: 0, left: 0 };
  let padding = { top: 0, right: 0, bottom: 0, left: 0 };
  if ('nodeType' in target && target.nodeType === 1) {
    const computedStyle = window.getComputedStyle(target);
    padding = {
      top: parseInt(computedStyle.paddingTop, 10) || 0,
      right: parseInt(computedStyle.paddingRight, 10) || 0,
      bottom: parseInt(computedStyle.paddingBottom, 10) || 0,
      left: parseInt(computedStyle.paddingLeft, 10) || 0,
    };
  }
  const rects = Array.from(target.getClientRects()).map((rect) => {
    return {
      top: rect.top + padding.top,
      right: rect.right - padding.right,
      bottom: rect.bottom - padding.bottom,
      left: rect.left + padding.left,
    };
  });
  const first = targetRect
    ? frameRect(frame, targetRect, sx, sy)
    : frameRect(frame, rects[0], sx, sy);
  const last = targetRect
    ? frameRect(frame, targetRect, sx, sy)
    : frameRect(frame, rects.at(-1), sx, sy);

  if (isVertical) {
    const leftSpace = first.left - rect.left;
    const rightSpace = rect.right - first.right;
    const dir = leftSpace > rightSpace ? 'left' : 'right';
    const position = {
      point: constrainPointWithinRect(
        {
          x: dir === 'left' ? first.left - rect.left - 6 : first.right - rect.left + 6,
          y: (first.top + first.bottom) / 2 - rect.top,
        },
        rect,
        paddingPx,
      ),
      dir,
    } as Position;
    const inView = pointIsInView(position.point);
    return inView ? position : ({ point: { x: 0, y: 0 }, dir } as Position);
  }

  const start = {
    point: constrainPointWithinRect(
      { x: (first.left + first.right) / 2 - rect.left, y: first.top - rect.top - 12 },
      rect,
      paddingPx,
    ),
    dir: 'up',
  } as Position;
  const end = {
    point: constrainPointWithinRect(
      { x: (last.left + last.right) / 2 - rect.left, y: last.bottom - rect.top + 6 },
      rect,
      paddingPx,
    ),
    dir: 'down',
  } as Position;
  const startInView = pointIsInView(start.point);
  const endInView = pointIsInView(end.point);
  if (!startInView && !endInView) return { point: { x: 0, y: 0 } };
  if (!startInView) return end;
  if (!endInView) return start;
  return start.point.y > window.innerHeight - end.point.y ? start : end;
};

// The popup will be positioned based on the triangle position and the direction
// up: above the triangle
// down: below the triangle
// left: to the left of the triangle
// right: to the right of the triangle
export const getPopupPosition = (
  position: Position,
  boundingReact: Rect,
  popupWidthPx: number,
  popupHeightPx: number,
  popupPaddingPx: number,
) => {
  const popupPoint = { x: 0, y: 0 };
  if (position.dir === 'up') {
    popupPoint.x = position.point.x - popupWidthPx / 2;
    popupPoint.y = position.point.y - popupHeightPx;
  } else if (position.dir === 'down') {
    popupPoint.x = position.point.x - popupWidthPx / 2;
    popupPoint.y = position.point.y + 6;
  } else if (position.dir === 'left') {
    popupPoint.x = position.point.x - popupWidthPx;
    popupPoint.y = position.point.y - popupHeightPx / 2;
  } else if (position.dir === 'right') {
    popupPoint.x = position.point.x + 6;
    popupPoint.y = position.point.y - popupHeightPx / 2;
  }

  if (popupPoint.x < popupPaddingPx) {
    popupPoint.x = popupPaddingPx;
  }
  if (popupPoint.y < popupPaddingPx) {
    popupPoint.y = popupPaddingPx;
  }
  if (popupPoint.x + popupWidthPx > boundingReact.right - boundingReact.left - popupPaddingPx) {
    popupPoint.x = boundingReact.right - boundingReact.left - popupPaddingPx - popupWidthPx;
  }
  if (popupPoint.y + popupHeightPx > boundingReact.bottom - boundingReact.top - popupPaddingPx) {
    popupPoint.y = boundingReact.bottom - boundingReact.top - popupPaddingPx - popupHeightPx;
  }

  return { point: popupPoint, dir: position.dir } as Position;
};

export const snapRangeToWords = (range: Range): void => {
  if (typeof Intl === 'undefined' || !Intl.Segmenter) return;

  const isPunctuation = (ch: string) => /^\p{P}|\p{S}$/u.test(ch);

  const snapStartToWordBoundary = () => {
    const node = range.startContainer;
    if (node.nodeType !== Node.TEXT_NODE) return;
    const text = node.textContent ?? '';
    const offset = range.startOffset;
    if (offset === 0 || offset >= text.length) return;

    const charAtOffset = text[offset] ?? '';
    if (isPunctuation(charAtOffset)) return;

    const segmenter = new Intl.Segmenter(undefined, { granularity: 'word' });
    for (const seg of segmenter.segment(text)) {
      if (seg.isWordLike && seg.index < offset && seg.index + seg.segment.length > offset) {
        range.setStart(node, seg.index);
        break;
      }
    }
  };

  const snapEndToWordBoundary = () => {
    const node = range.endContainer;
    if (node.nodeType !== Node.TEXT_NODE) return;
    const text = node.textContent ?? '';
    const offset = range.endOffset;
    if (offset === 0 || offset >= text.length) return;

    const charBeforeOffset = text[offset - 1] ?? '';
    if (isPunctuation(charBeforeOffset)) return;

    const segmenter = new Intl.Segmenter(undefined, { granularity: 'word' });
    for (const seg of segmenter.segment(text)) {
      if (seg.isWordLike && seg.index < offset && seg.index + seg.segment.length > offset) {
        range.setEnd(node, seg.index + seg.segment.length);
        break;
      }
    }
  };

  snapStartToWordBoundary();
  snapEndToWordBoundary();
};

/** Elements whose boundary is a line break in the text a range yields. */
const TEXT_BLOCK_TAGS = new Set([
  'P', 'DIV', 'SECTION', 'ARTICLE', 'ASIDE', 'BLOCKQUOTE', 'PRE', 'FIGURE', 'FIGCAPTION',
  'H1', 'H2', 'H3', 'H4', 'H5', 'H6',
  'UL', 'OL', 'LI', 'DL', 'DT', 'DD', 'TABLE', 'TR', 'TH', 'TD', 'HR',
]);

/**
 * Text of a range, with the line breaks its markup implies.
 *
 * Walking text nodes alone glues the last word of a line to the first of the
 * next one — "dimensionsdo not match" on a PDF page, "done.17The" across two
 * paragraphs of an EPUB.
 */
export const getTextFromRange = (range: Range, rejectTags: string[] = []): string => {
  const clonedRange = range.cloneRange();
  const fragment = clonedRange.cloneContents();
  const walker = document.createTreeWalker(
    fragment,
    NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT,
    {
      acceptNode: (node) => {
        const tag =
          node.nodeType === Node.ELEMENT_NODE
            ? (node as Element).tagName.toLowerCase()
            : node.parentElement?.tagName.toLowerCase();
        if (tag && rejectTags.includes(tag)) return NodeFilter.FILTER_REJECT;
        return NodeFilter.FILTER_ACCEPT;
      },
    },
  );

  let text = '';
  let node: Node | null;

  while ((node = walker.nextNode())) {
    if (node.nodeType === Node.ELEMENT_NODE) {
      const el = node as Element;
      if ((el.tagName === 'BR' || TEXT_BLOCK_TAGS.has(el.tagName)) && text && !text.endsWith('\n')) {
        text += '\n';
      } else if (
        // A word of a PDF page whose space lives in the geometry, not in the
        // markup: the reading-order pass recorded it here.
        el.getAttribute('data-space') === '1' &&
        text &&
        !/\s$/.test(text)
      ) {
        text += ' ';
      }
      continue;
    }
    text += node.nodeValue ?? '';
  }

  return text;
};

/**
 * A selected passage as the model should read it: no hyphen left over from a
 * line break, no line break in the middle of a sentence.
 */
export const normalizeSelectedText = (text: string): string =>
  text
    .replace(/\u00ad/g, '')
    .replace(/(\p{L})-\n\s*(\p{L})/gu, '$1$2')
    .replace(/\s*\n\s*/g, ' ')
    .replace(/[ \t]{2,}/g, ' ')
    .trim();

/**
 * The lines around a span of a PDF text layer.
 *
 * A page has no paragraphs: every word is a span, and a line ends at a `<br>`
 * placed by the reading-order pass. Marginal notes are skipped unless the
 * anchor itself is one, so the context of a passage stays the body text.
 */
export const collectPdfLinesAround = (el: Element, lineCount: number): string => {
  const zoneOf = (node: Element | null) =>
    node?.getAttribute?.('data-zone') === 'margin' ? 'margin' : 'body';
  const zone = zoneOf(el);
  const gather = (direction: 'previous' | 'next') => {
    const parts: string[] = [];
    let breaks = 0;
    let node = direction === 'previous' ? el.previousElementSibling : el.nextElementSibling;
    while (node) {
      if (node.tagName === 'BR') {
        breaks += 1;
        // The break that closes the last wanted line ends the walk.
        if (breaks > lineCount) break;
        parts.push('\n');
      } else if (zoneOf(node) === zone) {
        parts.push(node.textContent ?? '');
      }
      node = direction === 'previous' ? node.previousElementSibling : node.nextElementSibling;
    }
    return direction === 'previous' ? parts.reverse().join('') : parts.join('');
  };
  return `${gather('previous')}${el.textContent ?? ''}${gather('next')}`;
};
