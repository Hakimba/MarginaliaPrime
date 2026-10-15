import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { useMouseEvent } from './useIframeEvents';

const hosts: HTMLDivElement[] = [];
const roots: ReturnType<typeof createRoot>[] = [];

afterEach(async () => {
  for (const root of roots.splice(0)) {
    await act(async () => root.unmount());
  }
  for (const host of hosts.splice(0)) host.remove();
  vi.useRealTimers();
});

it('coalesces wheel input across renders and calls the latest handlers', async () => {
  vi.useFakeTimers();
  const host = document.createElement('div');
  document.body.appendChild(host);
  hosts.push(host);
  const root = createRoot(host);
  roots.push(root);
  const firstFlip = vi.fn();
  const latestFlip = vi.fn();
  const firstScroll = vi.fn();
  const latestScroll = vi.fn();
  const Harness = ({ latest }: { latest: boolean }) => {
    useMouseEvent('book-view', latest ? latestFlip : firstFlip, latest ? latestScroll : firstScroll);
    return null;
  };
  const wheel = () => {
    window.dispatchEvent(
      new MessageEvent('message', {
        data: { type: 'iframe-wheel', bookKey: 'book-view', deltaY: 20, ctrlKey: false },
      }),
    );
  };

  await act(async () => root.render(<Harness latest={false} />));
  wheel();
  await act(async () => root.render(<Harness latest={true} />));
  wheel();
  await act(async () => vi.advanceTimersByTime(500));

  expect(firstFlip).not.toHaveBeenCalled();
  expect(firstScroll).not.toHaveBeenCalled();
  expect(latestFlip).toHaveBeenCalledTimes(1);
  expect(latestScroll).toHaveBeenCalledExactlyOnceWith('mouse', -20, 0);
});

it('cancels pending wheel input when its book listener unmounts', async () => {
  vi.useFakeTimers();
  const host = document.createElement('div');
  document.body.appendChild(host);
  hosts.push(host);
  const root = createRoot(host);
  const flip = vi.fn();
  const scroll = vi.fn();
  const Harness = () => {
    useMouseEvent('book-view', flip, scroll);
    return null;
  };
  await act(async () => root.render(<Harness />));
  window.dispatchEvent(
    new MessageEvent('message', {
      data: { type: 'iframe-wheel', bookKey: 'book-view', deltaY: 20, ctrlKey: false },
    }),
  );
  await act(async () => root.unmount());
  await act(async () => vi.advanceTimersByTime(500));

  expect(flip).not.toHaveBeenCalled();
  expect(scroll).not.toHaveBeenCalled();
});
