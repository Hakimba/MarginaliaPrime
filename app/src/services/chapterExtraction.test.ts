import { describe, expect, it } from 'vitest';

import { domToStructuredText } from './chapterExtraction';

const parse = (html: string): Element => {
  const doc = new DOMParser().parseFromString(`<body>${html}</body>`, 'text/html');
  return doc.body;
};

const text = (html: string): string => domToStructuredText(parse(html));

describe('domToStructuredText', () => {
  it('separates blocks with a blank line', () => {
    expect(text('<p>Premier.</p><p>Second.</p>')).toBe('Premier.\n\nSecond.');
  });

  it('marks headings and list items', () => {
    expect(text('<h2>Titre</h2><ul><li>a</li><li>b</li></ul>')).toContain('## Titre');
    expect(text('<ul><li>a</li></ul>')).toContain('- a');
    expect(text('<ol><li>x</li><li>y</li></ol>')).toContain('2. y');
  });

  it('wraps inline math in LaTeX delimiters and keeps it apart from words', () => {
    // A LaTeX-to-EPUB export often has no space around a formula span,
    // which used to produce "isΩ = ωω" glued to the previous word.
    const out = text('<p>The divergent omega combinator is<span class="math">Ω = ωω</span>.</p>');
    expect(out).toContain('is $Ω = ωω$');
    expect(out).not.toContain('isΩ');
  });

  it('puts display math on its own lines', () => {
    const out = text('<p>Avant</p><div class="math display">E = mc^2</div><p>Après</p>');
    expect(out).toContain('$$E = mc^2$$');
    expect(out.split('$$E = mc^2$$')[0]?.endsWith('\n\n')).toBe(true);
  });

  it('reads MathML and marks block math as display', () => {
    const out = text('<math display="block"><mi>x</mi><mo>+</mo><mn>1</mn></math>');
    expect(out).toBe('$$x+1$$');
  });

  it('renders a footnote reference as a bracketed label', () => {
    // "Nothing we have done.17" was the observed flattening.
    const out = text('<p>Nothing we have done.<sup><a href="#fn17">17</a></sup></p>');
    expect(out).toContain('done. [17]');
    expect(out).not.toContain('done.17');
  });

  it('leaves ordinary links alone', () => {
    expect(text('<p>voir <a href="https://x.test">le site</a> pour la suite</p>')).toBe(
      'voir le site pour la suite',
    );
  });

  it('drops scripts and styles', () => {
    expect(text('<p>garde</p><script>alert(1)</script><style>p{}</style>')).toBe('garde');
  });

  it('collapses runs of blank lines and whitespace', () => {
    expect(text('<div><div><p>  a   b  </p></div></div>')).toBe('a b');
  });
});
