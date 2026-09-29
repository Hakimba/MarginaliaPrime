import { describe, expect, it } from 'vitest';

import { splitTranscriptions } from './transcriptions';

describe('splitTranscriptions', () => {
  it('leaves an answer without transcription whole', () => {
    expect(splitTranscriptions('Une réponse.')).toEqual([{ content: 'Une réponse.' }]);
  });

  it('puts the first passage above a single transcription', () => {
    const pieces = splitTranscriptions('**Transcription**\n$$x$$\n\nExplication.');
    expect(pieces).toEqual([{ content: '**Transcription**\n$$x$$\n\nExplication.', passage: 0 }]);
  });

  it('follows the numbers the model gives', () => {
    const answer = 'Intro.\n\n**Transcription 2**\n$$b$$\n\n**Transcription 1**\n$$a$$';
    const pieces = splitTranscriptions(answer);
    expect(pieces.map((p) => p.passage)).toEqual([undefined, 1, 0]);
    expect(pieces[0]!.content).toBe('Intro.\n\n');
    expect(pieces[1]!.content).toContain('$$b$$');
    expect(pieces[2]!.content).toContain('$$a$$');
  });

  it('numbers unnumbered transcriptions in order', () => {
    const pieces = splitTranscriptions('**Transcription**\n$$a$$\n**Transcription** :\n$$b$$');
    expect(pieces.map((p) => p.passage)).toEqual([0, 1]);
  });

  it('takes only the number right after the word', () => {
    expect(splitTranscriptions('**Transcription** (éq. 6.82)\n$$x$$')[0]!.passage).toBe(0);
    expect(splitTranscriptions('**Transcription** — p. 202\n$$x$$')[0]!.passage).toBe(0);
    expect(splitTranscriptions('**Transcription 2** (p. 30)\n$$x$$')[0]!.passage).toBe(1);
    expect(splitTranscriptions('**Transcription (2)**\n$$x$$')[0]!.passage).toBe(1);
  });

  it('never cuts inside a code block or an indented block', () => {
    const fenced = 'Voici :\n```\n**Transcription**\n```\nFin.';
    expect(splitTranscriptions(fenced)).toEqual([{ content: fenced }]);
    const indented = '- point\n\n    **Transcription**\n';
    expect(splitTranscriptions(indented)).toEqual([{ content: indented }]);
  });

  it('ignores the word in the middle of a sentence', () => {
    expect(splitTranscriptions('La **Transcription** ci-dessus est exacte.')).toHaveLength(1);
  });
});
