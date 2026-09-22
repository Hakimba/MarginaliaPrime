import { describe, it, expect } from 'vitest';

import { buildModel, positionAt } from '../../../packages/foliate-js/pdf-selection.js';

/**
 * A page as the reader sees it: a running head far above, then lines of text.
 * The geometry is the one measured on the book at hand, at the zoom the reader
 * uses: lines 8 pixels tall, 12 apart.
 */
const layer = () => {
  const container = document.createElement('div');
  container.className = 'textLayer';
  const put = (text: string, x: number, y: number, w: number) => {
    const span = document.createElement('span');
    span.textContent = text;
    span.getBoundingClientRect = () =>
      ({ left: x, right: x + w, top: y, bottom: y + 8, width: w, height: 8 }) as DOMRect;
    container.append(span);
    return span;
  };
  put('2.2 Matrices', 20, 40, 60);
  put('23', 260, 40, 12);
  container.append(document.createElement('br'));
  for (let line = 0; line < 4; line++) {
    const y = 110 + line * 12;
    // A PDF line starts with one whitespace item as wide as the whole line:
    // exactly what used to swallow every anchor.
    put(' ', 20, y, 280);
    let x = 20;
    for (const word of ['This', 'means', 'we', 'multiply', 'the', 'elements']) {
      put(word, x, y, word.length * 6);
      x += word.length * 6 + 4;
    }
    container.append(document.createElement('br'));
  }
  container.getBoundingClientRect = () =>
    ({ left: 0, top: 0, width: 320, height: 500 }) as DOMRect;
  document.body.append(container);
  return container;
};

// jsdom has no layout, so a range cannot measure itself; the character offset
// inside a word is not what these tests are about.
Range.prototype.getBoundingClientRect = () =>
  ({ left: 0, right: 0, top: 0, bottom: 0, width: 0, height: 0 }) as DOMRect;

describe('positionAt', () => {
  const lines = () => buildModel(layer());

  it('stays on the line a drag started on when the hand strays a little', () => {
    const model = lines();
    const anchorLine = model[2];
    const height = anchorLine.bottom - anchorLine.top;
    for (const dy of [-height * 0.4, -1, 1, height * 0.4]) {
      const at = positionAt(document, model, 120, anchorLine.top + dy, 'body', anchorLine);
      expect(at.line.index).toBe(anchorLine.index);
    }
  });

  it('never answers with a line at the other end of the page', () => {
    const model = lines();
    const anchorLine = model[3];
    for (const dy of [-10, -6, -2, 2, 6, 10]) {
      const at = positionAt(document, model, 120, (anchorLine.top + anchorLine.bottom) / 2 + dy, 'body', anchorLine);
      expect(Math.abs(at.line.index - anchorLine.index)).toBeLessThanOrEqual(1);
    }
  });

  it('anchors in the word under the point, not in the line-wide space', () => {
    const model = lines();
    const line = model[1];
    const word = line.spans.find((span: { node: HTMLElement }) => span.node.textContent === 'multiply');
    const at = positionAt(document, model, (word.left + word.right) / 2, (line.top + line.bottom) / 2, 'body', null);
    expect(at.node.nodeValue).toBe('multiply');
  });

  it('takes the nearest line when there is no anchor yet', () => {
    const model = lines();
    const at = positionAt(document, model, 120, 116, 'body', null);
    expect(at.line.index).toBe(1);
  });
});
