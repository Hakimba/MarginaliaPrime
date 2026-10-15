'use client';

import React, { useMemo } from 'react';
import clsx from 'clsx';
import { FiSearch } from 'react-icons/fi';
import type { ChatMessage } from '@/services/chat/persistence';
import { renderChatMarkdown } from '@/services/chat/markdown';
import { splitTranscriptions } from '@/services/chat/transcriptions';
import { perfRender } from '@/utils/perf';
import { circled } from '../../utils/formulaOverlay';

const ChatMarkdown = React.memo(function ChatMarkdown({
  content,
  pageLinks = false,
}: {
  content: string;
  pageLinks?: boolean;
}) {
  const html = useMemo(() => renderChatMarkdown(content, { pageLinks }), [content, pageLinks]);
  return (
    <div
      className='chat-markdown prose prose-sm max-w-none'
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
});

type SentItem = NonNullable<NonNullable<ChatMessage['selection']>['items']>[number];

export const itemsOf = (message: ChatMessage | undefined): SentItem[] => {
  const selection = message?.role === 'user' ? message.selection : undefined;
  if (!selection) return [];
  if (selection.items) return selection.items;
  if (selection.images?.length) return selection.images.map((image) => ({ text: '', image }));
  return [{ text: selection.text, location: selection.chapter }];
};

const PageImage: React.FC<{
  image: string;
  alt: string;
  className?: string;
}> = ({ image, alt, className }) => (
  <img
    src={`data:image/png;base64,${image}`}
    alt={alt}
    onLoad={(e) => {
      const img = e.currentTarget;
      img.style.width = `${Math.round(img.naturalWidth * 0.45)}px`;
    }}
    className={clsx('max-w-full rounded bg-white p-1', className)}
  />
);

export const Answer: React.FC<{
  content: string;
  items: SentItem[];
  pageLinks?: boolean;
}> = ({ content, items, pageLinks = false }) => {
  if (!items.some((item) => item.image)) {
    return <ChatMarkdown content={content} pageLinks={pageLinks} />;
  }
  return (
    <>
      {splitTranscriptions(content).map((piece, j) => {
        const image = piece.passage !== undefined ? items[piece.passage]?.image : undefined;
        return (
          <div key={j}>
            {image && (
              <PageImage
                image={image}
                alt={`Original ${(piece.passage ?? 0) + 1}`}
                className='border-base-300 mb-1 border'
              />
            )}
            <ChatMarkdown content={piece.content} pageLinks={pageLinks} />
          </div>
        );
      })}
    </>
  );
};

const SentPassages: React.FC<{ items: SentItem[] }> = ({ items }) => {
  if (!items.length) return null;
  return (
    <div className='mb-2 flex flex-col gap-1.5'>
      {items.map((item, k) => (
        <div key={k} className='flex items-start gap-1.5'>
          {items.length > 1 && (
            <span className='text-xs leading-5 opacity-80'>{circled(k + 1)}</span>
          )}
          {item.image ? (
            <PageImage image={item.image} alt={`Passage ${k + 1}`} />
          ) : (
            <div className='line-clamp-3 border-l-2 border-white/40 pl-2 text-xs italic opacity-80'>
              &ldquo;{item.text}&rdquo;
              {item.location && (
                <div className='mt-0.5 text-[10px] not-italic opacity-60'>{item.location}</div>
              )}
            </div>
          )}
        </div>
      ))}
    </div>
  );
};

type ChatHistoryProps = {
  messages: readonly ChatMessage[];
  isStreaming: boolean;
  pageLinks: boolean;
  fixedLayout: boolean;
  onOpenUnread: (page: number) => void;
};

const ChatHistory = React.memo(function ChatHistory({
  messages,
  isStreaming,
  pageLinks,
  fixedLayout,
  onOpenUnread,
}: ChatHistoryProps) {
  perfRender('ChatHistory');
  return (
    <>
      {messages.map((msg, i) => (
        <div key={i} className={clsx('chat', msg.role === 'user' ? 'chat-end' : 'chat-start')}>
          <div
            className={clsx(
              'chat-bubble text-sm',
              msg.role === 'user'
                ? 'chat-bubble-primary'
                : 'chat-bubble bg-base-200 text-base-content',
            )}
          >
            {msg.role === 'user' ? (
              <div>
                <SentPassages items={itemsOf(msg)} />
                <span className='whitespace-pre-wrap'>{msg.content}</span>
              </div>
            ) : (
              <>
                {msg.tools?.length ? (
                  <div className='text-base-content/50 mb-1 flex flex-col text-[11px]'>
                    {msg.tools.map((tool, k) => (
                      <span key={k} className='flex items-center gap-1'>
                        <FiSearch size={10} className='shrink-0' />
                        {tool}
                      </span>
                    ))}
                  </div>
                ) : null}
                <Answer
                  content={msg.content}
                  items={itemsOf(messages[i - 1])}
                  pageLinks={pageLinks}
                />
                {msg.unread?.length && i === messages.length - 1 && !isStreaming ? (
                  <div className='mt-2 flex flex-wrap gap-1'>
                    {msg.unread.map((page) => (
                      <button
                        key={page}
                        className='btn btn-xs btn-outline'
                        onClick={() => onOpenUnread(page)}
                        title={`Laisser Claude lire ${fixedLayout ? 'p.' : 'section'} ${page} et la suivante, pour cette question seulement`}
                      >
                        Regarder {`${fixedLayout ? 'p.' : 'section'} ${page}`}
                      </button>
                    ))}
                  </div>
                ) : null}
              </>
            )}
          </div>
        </div>
      ))}
    </>
  );
});

export default ChatHistory;
