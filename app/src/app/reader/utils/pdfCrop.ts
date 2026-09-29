/**
 * The region of a PDF page covered by a text selection, in PDF points: what
 * `book.renderRegion` draws for the model. The image is the source of truth
 * for the mathematics, the extracted text only backs it up.
 *
 * A page's iframe lays the text layer out at `--total-scale-factor` CSS pixels
 * per point and scales its whole document by 1 / devicePixelRatio, so a
 * client rectangle measured inside the iframe is in points once divided by the
 * layer's on-screen pixels per point and taken from the layer's corner. The
 * scale of the moment does not matter: the same passage gives the same region
 * at any zoom.
 */

/** A rectangle in PDF points, top-left origin. */
export interface PointRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

interface Box {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

/**
 * Margin around the selected glyphs, in points, on the sides: a formula's
 * delimiters and number may lie just outside the selected spans. None above
 * and below: the boxes of a text layer miss the glyphs there, and the image
 * is fitted to the ink of the lines instead (`renderRegion`, `fitLines`).
 */
export const CROP_MARGIN = 8;
export const CROP_MARGIN_Y = 0;

/**
 * The union of the selection's boxes, converted to points and widened by the
 * margin, clamped to the page. Null when nothing measurable is selected.
 */
export const selectionRegion = (
  boxes: Box[],
  origin: { left: number; top: number },
  pxPerPoint: number,
  page: { w: number; h: number },
  margin = CROP_MARGIN,
  marginY = CROP_MARGIN_Y,
): PointRect | null => {
  if (!(pxPerPoint > 0)) return null;
  const valid = boxes.filter((b) => b.right - b.left > 0.5 && b.bottom - b.top > 0.5);
  if (!valid.length) return null;
  const pt = (px: number, from: number) => (px - from) / pxPerPoint;
  const x0 = Math.max(0, Math.min(...valid.map((b) => pt(b.left, origin.left))) - margin);
  const y0 = Math.max(0, Math.min(...valid.map((b) => pt(b.top, origin.top))) - marginY);
  const x1 = Math.min(page.w, Math.max(...valid.map((b) => pt(b.right, origin.left))) + margin);
  const y1 = Math.min(page.h, Math.max(...valid.map((b) => pt(b.bottom, origin.top))) + marginY);
  if (x1 - x0 < 1 || y1 - y0 < 1) return null;
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
};

/** The region a range covers on its PDF page, or null outside a PDF page. */
export const rangeRegion = (range: Range): PointRect | null => {
  const doc = range.startContainer.ownerDocument;
  const layer = doc?.querySelector<HTMLElement>('.textLayer');
  if (!doc || !layer) return null;
  const scale = parseFloat(
    doc.documentElement.style.getPropertyValue('--total-scale-factor') || '0',
  );
  // The layer's own width is `scale` CSS pixels per point; its box on screen
  // is what the transforms left of it. Measured, not taken from the device
  // pixel ratio, which may have changed since the page was drawn.
  const layoutWidth = parseFloat(doc.defaultView?.getComputedStyle(layer).width || '0');
  const origin = layer.getBoundingClientRect();
  const pxPerPoint = scale > 0 && layoutWidth > 0 ? origin.width / (layoutWidth / scale) : 0;
  if (!(pxPerPoint > 0)) return null;
  return selectionRegion(Array.from(range.getClientRects()), origin, pxPerPoint, {
    w: origin.width / pxPerPoint,
    h: origin.height / pxPerPoint,
  });
};

/** Resolves to undefined rather than waiting forever on a stuck render. */
export const withTimeout = <T>(promise: Promise<T>, ms: number): Promise<T | undefined> =>
  Promise.race([
    promise,
    new Promise<undefined>((resolve) => setTimeout(() => resolve(undefined), ms)),
  ]);
