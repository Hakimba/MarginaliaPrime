import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { describe, expect, it, vi } from 'vitest';
import type { ChatMessage } from '@/services/chat/persistence';
import ChatHistory, { Answer, itemsOf } from './ChatHistory';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const counters = vi.hoisted(() => ({ render: vi.fn() }));
vi.mock('@/utils/perf', () => ({ perfRender: counters.render }));

describe('chat history', () => {
  it('retains historical DOM during live updates and refreshes changed messages and actions', async () => {
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    const openUnread = vi.fn();
    const links = vi.fn();
    const user: ChatMessage = {
      role: 'user', content: 'Question exacte', timestamp: 1,
      selection: { text: 'ancien texte', chapter: 'chapitre', images: ['legacy-image'] },
    };
    const assistant: ChatMessage = {
      role: 'assistant', content: 'Réponse exacte. Voir p. 12. $x^2$', timestamp: 2,
      tools: ['Recherche exacte'], unread: [20],
    };
    const messages = [user, assistant];
    const render = async (live: string, history = messages, isStreaming = false, fixedLayout = true, pageLinks = true) => {
      await act(async () => root.render(
        <div onClick={links} role='presentation'>
          <ChatHistory messages={history} isStreaming={isStreaming} pageLinks={pageLinks}
            fixedLayout={fixedLayout} onOpenUnread={openUnread} />
          <Answer content={live} items={itemsOf(history[history.length - 1])} pageLinks={pageLinks} />
        </div>,
      ));
    };
    try {
      await render('Texte actif');
      expect(container.textContent).toContain('Question exacte');
      expect(container.textContent).toContain('Recherche exacte');
      expect(container.querySelector('.katex')).not.toBeNull();
      expect(container.querySelector('img')?.getAttribute('src')).toBe('data:image/png;base64,legacy-image');
      expect(container.querySelector('a.page-ref')?.textContent).toBe('p. 12');
      const firstBubble = container.querySelector('.chat-bubble');
      const firstImage = container.querySelector('img');
      const renders = counters.render.mock.calls.length;
      await render('Texte actif allongé');
      expect(container.textContent).toContain('Texte actif allongé');
      expect(container.querySelector('.chat-bubble')).toBe(firstBubble);
      expect(container.querySelector('img')).toBe(firstImage);
      expect(counters.render.mock.calls.length).toBe(renders);
      await act(async () => container.querySelector('a')?.click());
      expect(links).toHaveBeenCalledOnce();
      const button = container.querySelector('button');
      expect(button?.textContent).toBe('Regarder p. 20');
      await act(async () => button?.click());
      expect(openUnread).toHaveBeenCalledWith(20);
      await render('Flux', messages, true);
      expect(container.querySelector('button')).toBeNull();
      await render('Terminé', messages, false, false, false);
      expect(container.querySelector('button')?.textContent).toBe('Regarder section 20');
      expect(container.querySelector('a.page-ref')).toBeNull();
      const changed: ChatMessage = { ...assistant, content: 'Autre réponse exacte', unread: [25] };
      await render('Terminé', [user, changed]);
      expect(container.textContent).toContain('Autre réponse exacte');
      expect(container.textContent).not.toContain('Réponse exacte');
      expect(container.querySelector('button')?.textContent).toBe('Regarder p. 25');
      await render('Terminé', [...messages, { role: 'user', content: 'Suivante', timestamp: 3 }]);
      expect(container.querySelector('button')).toBeNull();
      expect(messages).toEqual([user, assistant]);
      expect(assistant.content).toBe('Réponse exacte. Voir p. 12. $x^2$');
    } finally {
      await act(async () => root.unmount());
      container.remove();
    }
  });

  it('pairs numbered passage images with their answer transcriptions', async () => {
    const container = document.createElement('div');
    const root = createRoot(container);
    const messages: ChatMessage[] = [
      { role: 'user', content: 'Deux passages', timestamp: 1, selection: {
        text: '', chapter: '', items: [{ text: 'Premier', image: 'first' }, { text: 'Second', image: 'second' }],
      } },
      { role: 'assistant', content: '**Transcription 1**\nPremier transcrit\n\n**Transcription 2**\nSecond transcrit', timestamp: 2 },
    ];
    try {
      await act(async () => root.render(<ChatHistory messages={messages} isStreaming={false}
        pageLinks={true} fixedLayout={true} onOpenUnread={() => {}} />));
      expect(Array.from(container.querySelectorAll('img')).map(img => [img.alt, img.getAttribute('src')])).toEqual([
        ['Passage 1', 'data:image/png;base64,first'], ['Passage 2', 'data:image/png;base64,second'],
        ['Original 1', 'data:image/png;base64,first'], ['Original 2', 'data:image/png;base64,second'],
      ]);
      expect(container.textContent).toContain('Premier transcrit');
      expect(container.textContent).toContain('Second transcrit');
    } finally {
      await act(async () => root.unmount());
    }
  });
});
