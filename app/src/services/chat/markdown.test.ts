import { describe, expect, it } from 'vitest';

import { renderChatMarkdown } from './markdown';

const doc = (markdown: string): HTMLElement => {
  const root = document.createElement('div');
  root.innerHTML = renderChatMarkdown(markdown);
  return root;
};

/** Formulas rendered, inline and display, in document order. */
const formulas = (markdown: string) =>
  [...doc(markdown).querySelectorAll('.katex')].map((el) => ({
    display: !!el.closest('.katex-display'),
    error: !!el.querySelector('.katex-error'),
  }));

describe('renderChatMarkdown: delimiters', () => {
  it('renders $…$ inline and $$…$$ on its own lines as display math', () => {
    expect(formulas('Soit $x^2$ un carré.\n\n$$\n\\int_0^1 f(x)\\,dx\n$$\n')).toEqual([
      { display: false, error: false },
      { display: true, error: false },
    ]);
  });

  it('renders \\(…\\) and \\[…\\], which Claude often writes', () => {
    expect(formulas('On a \\(a+b\\) puis\n\n\\[\\sum_i x_i\\]\n')).toEqual([
      { display: false, error: false },
      { display: true, error: false },
    ]);
  });

  it('reads French punctuation around a formula', () => {
    for (const text of ['(où $x$)', "l'$x$ est", '$a$; b', 'donc $f$, puis', '« $x$ »', '$x$ :']) {
      expect(formulas(text), text).toHaveLength(1);
    }
  });

  it('keeps an escape as the last character of a formula', () => {
    expect(formulas('les accolades $\\{x\\}$ ici')).toHaveLength(1);
  });

  it('renders $$…$$ inside a paragraph as display math', () => {
    expect(formulas('Soit\n$$\nx = 1\n$$\nalors')).toEqual([{ display: true, error: false }]);
    expect(formulas('et $$\\frac{a}{b}$$ seul')).toEqual([{ display: true, error: false }]);
  });

  it('leaves prices alone', () => {
    for (const text of ['ça coûte 5$ et 10$', 'soit 5$/mois et 3$/an', 'entre $5 et $10']) {
      expect(formulas(text), text).toHaveLength(0);
      expect(doc(text).textContent?.trim()).toBe(text);
    }
  });

  it('leaves an escaped dollar as a dollar', () => {
    expect(formulas('un \\$ seul')).toHaveLength(0);
    expect(doc('un \\$ seul').textContent?.trim()).toBe('un $ seul');
  });

  it('never reads math inside code', () => {
    const root = doc('Le code `$x$ et \\(y\\)` reste.\n\n```\n$$z$$\n\\[w\\]\n```\n');
    expect(root.querySelectorAll('.katex')).toHaveLength(0);
    expect(root.querySelector('p code')?.textContent).toBe('$x$ et \\(y\\)');
    expect(root.querySelector('pre code')?.textContent).toBe('$$z$$\n\\[w\\]\n');
  });

  it('does not take an underscore in a formula for emphasis', () => {
    const root = doc('$a_1$ et $b_2$');
    expect(root.querySelectorAll('em')).toHaveLength(0);
    expect(root.querySelectorAll('.katex')).toHaveLength(2);
  });

  it('keeps Markdown working around formulas', () => {
    const root = doc('**Transcription**\n\n$$\nx\n$$\n\n- terme $a$\n- terme $b$\n');
    expect(root.querySelector('strong')?.textContent).toBe('Transcription');
    expect(root.querySelectorAll('li .katex')).toHaveLength(2);
    expect(root.querySelectorAll('.katex-display')).toHaveLength(1);
  });
});

describe('renderChatMarkdown: constructions the harness prescribes', () => {
  it('draws a labelled brace and keeps the colours (T9)', () => {
    const root = doc(
      '$$\n\\underbrace{P(A\\mid B)}_{\\text{a posteriori}} = ' +
        '\\frac{\\textcolor{#1f77d0}{P(B\\mid A)}\\,\\overbrace{P(A)}^{\\text{a priori}}}{\\boxed{P(B)}}\n$$\n',
    );
    expect(root.querySelector('.katex-error')).toBeNull();
    // Stretchy braces are SVG: the sanitiser must keep them.
    expect(root.querySelectorAll('svg').length).toBeGreaterThanOrEqual(2);
    expect(root.textContent?.replace(/\u00a0/g, ' ')).toContain('a posteriori');
    expect(root.innerHTML).toMatch(/color:\s*#1f77d0/);
    expect(root.querySelector('.boxpad, .fbox')).not.toBeNull();
  });

  it('renders numbered markers with \\textcircled', () => {
    const root = doc('$$\n\\overset{\\textcircled{1}}{P(A)}\\;\\overset{\\textcircled{2}}{P(B)}\n$$\n');
    expect(root.querySelector('.katex-error')).toBeNull();
    expect(root.textContent).toContain('1');
  });

  it('renders a derivation tree of nested \\dfrac (T10)', () => {
    const tree =
      '$$\n\\dfrac{\\dfrac{\\dfrac{}{\\vdash \\mathsf{0} : \\mathsf{Nat}}\\;\\textsf{(T-Zero)}}' +
      '{\\vdash \\mathsf{succ}\\ \\mathsf{0} : \\mathsf{Nat}}\\;\\textsf{(T-Succ)}}' +
      '{\\vdash \\mathsf{succ}\\ (\\mathsf{succ}\\ \\mathsf{0}) : \\mathsf{Nat}}\\;\\textsf{(T-Succ)}\n$$\n';
    const root = doc(tree);
    expect(root.querySelector('.katex-error')).toBeNull();
    expect(root.querySelectorAll('.mfrac').length).toBe(3);
    expect(root.textContent).toContain('(T-Succ)');
  });
});

describe('renderChatMarkdown: robustness', () => {
  it('shows a broken formula as an error instead of throwing', () => {
    // A syntax error: the source is shown, marked as an error.
    const broken = doc('avant $\\frac{a$ après');
    expect(broken.querySelector('.katex-error')?.textContent).toBe('\\frac{a');
    expect(broken.textContent).toContain('après');
    // An unknown command: the rest of the formula renders, the command in red.
    const unknown = doc('avant $\\foo{x}$ après');
    expect(unknown.querySelector('.katex [style*="#cc0000"]')?.textContent).toBe('\\foo');
    expect(unknown.textContent).toContain('après');
  });

  it('cannot be fooled by a placeholder written in the answer', () => {
    const root = doc('<span data-math-slot="0000000000000000-0"></span> et $x$');
    expect(root.querySelectorAll('.katex')).toHaveLength(1);
    expect(root.querySelector('[data-math-slot]')).not.toBeNull();
  });

  it('survives every prefix of a streamed answer', () => {
    const answer =
      '**Transcription**\n\n$$\n\\frac{a}{b} = \\sum_{i=1}^n x_i\n$$\n\n' +
      'Ici $a$ est le numérateur, \\(b\\) le dénominateur.\n\n\\[\n\\int_0^1 x\\,dx\n\\]\n\nFin.';
    for (let n = 0; n <= answer.length; n += 1) {
      expect(() => renderChatMarkdown(answer.slice(0, n))).not.toThrow();
    }
    expect(formulas(answer)).toHaveLength(4);
  });

  it('does not let an unclosed display formula swallow the next paragraph', () => {
    const root = doc('$$\n\\frac{a}{b\n\nLa suite du texte.');
    expect(root.querySelectorAll('.katex')).toHaveLength(0);
    expect(root.textContent).toContain('La suite du texte.');
  });

  it('keeps a formula in an image description as text', () => {
    const img = doc('![la loi $x^2$](http://a/b.png)').querySelector('img');
    expect(img?.getAttribute('alt')).toBe('la loi $x^2$');
    expect(img?.getAttribute('src')).toBe('http://a/b.png');
  });

  it('stays fast on many unclosed delimiters', () => {
    for (const bad of ['\\( '.repeat(3000), '\\[ '.repeat(3000), '$ '.repeat(3000), 'a$b '.repeat(3000)]) {
      const start = performance.now();
      renderChatMarkdown(bad);
      expect(performance.now() - start, bad.slice(0, 8)).toBeLessThan(500);
    }
  });

  it('strips scripts from the model output', () => {
    const root = doc('<img src=x onerror="alert(1)"> et $x$');
    expect(root.innerHTML).not.toContain('onerror');
    expect(root.querySelectorAll('.katex')).toHaveLength(1);
  });

  it('renders a long answer quickly once formulas are cached', () => {
    const block = 'Terme $\\alpha_i + \\beta_j$ puis $$\\sum_{k=0}^{n} \\binom{n}{k} x^k$$ fin.\n\n';
    const answer = block.repeat(40);
    renderChatMarkdown(answer);
    const start = performance.now();
    for (let i = 0; i < 20; i += 1) renderChatMarkdown(answer);
    expect((performance.now() - start) / 20).toBeLessThan(50);
  });
});
