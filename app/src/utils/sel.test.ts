import { describe, it, expect } from 'vitest';

import { collectPdfLinesAround, getTextFromRange, normalizeSelectedText } from './sel';

const rangeOver = (html: string): Range => {
  const host = document.createElement('div');
  host.innerHTML = html;
  document.body.append(host);
  const range = document.createRange();
  range.selectNodeContents(host);
  return range;
};

describe('getTextFromRange', () => {
  it('breaks the line between two paragraphs', () => {
    expect(getTextFromRange(rangeOver('<p>fin de phrase.</p><p>17 la suite</p>'))).toBe(
      'fin de phrase.\n17 la suite',
    );
  });

  it('breaks the line on a <br>, as a PDF page does', () => {
    expect(getTextFromRange(rangeOver('<span>dimensions</span><br><span>do not match</span>'))).toBe(
      'dimensions\ndo not match',
    );
  });

  it('restores the space between two words of a PDF page', () => {
    expect(
      getTextFromRange(rangeOver('<span>matrice</span><span data-space="1">A</span>')),
    ).toBe('matrice A');
  });

  it('still drops the tags it is told to reject', () => {
    expect(getTextFromRange(rangeOver('<span>kanji<rt>furigana</rt></span>'), ['rt'])).toBe('kanji');
  });
});

describe('normalizeSelectedText', () => {
  it('rejoins a word cut by a line break', () => {
    expect(normalizeSelectedText('the size was cho-\nsen appropriately')).toBe(
      'the size was chosen appropriately',
    );
  });

  it('turns the line breaks of a passage into spaces', () => {
    expect(normalizeSelectedText('  une ligne\n  et la suite  ')).toBe('une ligne et la suite');
  });
});

describe('collectPdfLinesAround', () => {
  const layer = () => {
    const container = document.createElement('div');
    container.className = 'textLayer';
    container.innerHTML = [
      '<span>ligne1</span><br>',
      '<span>ligne2</span><br>',
      '<span data-anchor>ancre</span><br>',
      '<span>ligne4</span><br>',
      '<span>ligne5</span><br>',
      '<span data-zone="margin">glose</span>',
    ].join('');
    document.body.append(container);
    return container;
  };

  it('takes the lines around the anchor, not the words', () => {
    const container = layer();
    const anchor = container.querySelector('[data-anchor]')!;
    expect(collectPdfLinesAround(anchor, 1)).toBe('ligne2\nancre\nligne4');
  });

  it('leaves the marginal notes out of a body passage', () => {
    const container = layer();
    const anchor = container.querySelector('[data-anchor]')!;
    expect(collectPdfLinesAround(anchor, 3)).not.toContain('glose');
  });
});
