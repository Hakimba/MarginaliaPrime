import clsx from 'clsx';
import React from 'react';

import { Position } from '@/utils/sel';

/**
 * The one thing to do with a selected passage: ask about it.
 *
 * What sat here before was the reader's inherited toolbar — highlight,
 * underline, annotate, copy, search, chat — which appeared on its own at the
 * end of every drag and covered the text being read. Those actions are still
 * on their keyboard shortcuts; the mouse now has a single, deliberate button.
 */
const AskAiBubble: React.FC<{
  position: Position;
  onAsk: () => void;
}> = ({ position, onAsk }) => (
  <div
    className={clsx(
      'selection-popup absolute z-50 flex items-center rounded-lg bg-gray-700 text-white',
      'shadow-lg select-none',
    )}
    style={{ left: `${position.point.x}px`, top: `${position.point.y}px` }}
  >
    <button
      className='flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium'
      onPointerDown={(event) => event.stopPropagation()}
      onClick={onAsk}
    >
      Ask AI
    </button>
  </div>
);

export default AskAiBubble;
