/**
 * A passage of the book, attached to the chat: its text, a few lines around
 * it, where it is, and on a PDF page an image of it. Shared by the annotator
 * (Ask AI, Ctrl+Shift+C, Ctrl+E) and the scripted scenarios, so that both go
 * through the same path.
 */
import type { FoliateView } from '@/types/view';
import { useChatStore } from '@/store/chatStore';
import { collectPdfLinesAround, normalizeSelectedText } from '@/utils/sel';
import { perfSpan } from '@/utils/perf';
import { CROP_MARGIN, rangeRegion, withTimeout, type PointRect } from './pdfCrop';

type RenderRegion = (
  index: number,
  rect: PointRect,
  scale?: number,
  options?: { fitLines?: boolean; fitSide?: number },
) => Promise<string>;

export interface PassageToAttach {
  text: string;
  range?: Range;
  /** Section index: on a PDF, the page index of the iframe the range is in. */
  index: number;
}

/** The text on either side of the passage: lines on a PDF, paragraphs elsewhere. */
const surroundingsOf = (range: Range): { text: string; isPdfPage: boolean } => {
  const container = range.commonAncestorContainer;
  const parentEl =
    container.nodeType === Node.TEXT_NODE ? container.parentElement : (container as Element);
  const isPdfPage = !!parentEl?.closest?.('.textLayer');
  if (!parentEl) return { text: '', isPdfPage };
  if (isPdfPage) {
    // A PDF page has no paragraphs: spans are siblings, one line ending at
    // every <br>. Take three lines on each side rather than three words, which
    // is all the sibling walk below would have found.
    return { text: collectPdfLinesAround(parentEl, 3), isPdfPage };
  }
  // A few sibling paragraphs on each side.
  const siblings: string[] = [];
  let el: Element | null = parentEl;
  for (let i = 0; i < 3 && el?.previousElementSibling; i++) {
    el = el.previousElementSibling;
    siblings.unshift(el.textContent?.trim() || '');
  }
  siblings.push(parentEl.textContent?.trim() || '');
  el = parentEl;
  for (let i = 0; i < 3 && el?.nextElementSibling; i++) {
    el = el.nextElementSibling;
    siblings.push(el.textContent?.trim() || '');
  }
  return { text: siblings.filter(Boolean).join('\n\n'), isPdfPage };
};

/**
 * Attach the passage to the chat and open it. On a PDF page the image is
 * rendered before the passage is added, so that a question asked right after
 * (Ctrl+E) never leaves without it; a render that fails or hangs leaves the
 * text alone. Resolves to false when there was nothing to attach.
 */
export const attachPassage = async (
  view: FoliateView | null | undefined,
  passage: PassageToAttach,
  section: string,
): Promise<boolean> => {
  if (!passage.text.trim()) return false;

  let surroundingText = '';
  let isPdfPage = false;
  try {
    if (passage.range) ({ text: surroundingText, isPdfPage } = surroundingsOf(passage.range));
  } catch {
    // Surrounding text extraction is best-effort
  }

  // One section is one page, and the passage's section is the page it was
  // made on, left or right.
  let imageBase64: string | undefined;
  const page = isPdfPage ? passage.index + 1 : undefined;
  if (isPdfPage && passage.range) {
    const renderRegion = (view?.book as { renderRegion?: RenderRegion } | undefined)?.renderRegion;
    const region = rangeRegion(passage.range);
    if (renderRegion && region) {
      const endCrop = perfSpan('chat:crop', { page, w: Math.round(region.w), h: Math.round(region.h) });
      try {
        imageBase64 = await withTimeout(
          renderRegion(passage.index, region, 3, { fitLines: true, fitSide: CROP_MARGIN }),
          3000,
        );
      } catch (e) {
        console.error('chat: selection image failed', e);
      }
      endCrop({ ok: !!imageBase64, kb: imageBase64 ? Math.round((imageBase64.length * 3) / 4 / 1024) : 0 });
    }
  }

  // The chapter text and the book metadata live in the store already; a
  // passage only carries what is specific to it.
  const chat = useChatStore.getState();
  chat.addSelection({
    text: normalizeSelectedText(passage.text),
    surroundingText: normalizeSelectedText(surroundingText),
    section,
    ...(page ? { page } : {}),
    ...(imageBase64 ? { imageBase64 } : {}),
  });
  chat.setOpen(true);
  return true;
};
