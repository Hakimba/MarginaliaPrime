import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';

let handlers: typeof import('./iframeEventHandlers');
let messages: MockInstance<Window['postMessage']>;

const mouse = (type: string) => {
  const event = new MouseEvent(type, { bubbles: true });
  Object.defineProperty(event, 'timeStamp', { value: Date.now() });
  return event;
};

const press = (duration: number) => {
  document.body.dispatchEvent(mouse('mousedown'));
  vi.advanceTimersByTime(duration);
  document.body.dispatchEvent(mouse('mouseup'));
  document.body.dispatchEvent(mouse('click'));
};

const down = (event: MouseEvent) => handlers.handleMousedown('book', event);
const up = (event: MouseEvent) => handlers.handleMouseup('book', event);
const click = (event: MouseEvent) => handlers.handleClick('book', { current: false }, event);

const singleClicks = () => messages.mock.calls
  .map(([message]) => message)
  .filter(message => message.type === 'iframe-single-click');

beforeEach(async () => {
  vi.useFakeTimers();
  vi.setSystemTime(10_000);
  vi.resetModules();
  handlers = await import('./iframeEventHandlers');
  messages = vi.spyOn(window, 'postMessage');
  document.addEventListener('mousedown', down);
  document.addEventListener('mouseup', up);
  document.addEventListener('click', click);
});

afterEach(() => {
  document.removeEventListener('mousedown', down);
  document.removeEventListener('mouseup', up);
  document.removeEventListener('click', click);
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('iframe click gestures', () => {
  it('forwards both short presses when an earlier hold timeout overlaps the second click', () => {
    press(10);
    vi.advanceTimersByTime(350);
    press(10);
    vi.advanceTimersByTime(250);
    expect(singleClicks()).toEqual([
      expect.objectContaining({ type: 'iframe-single-click', bookKey: 'book' }),
      expect.objectContaining({ type: 'iframe-single-click', bookKey: 'book' }),
    ]);
  });

  it('does not turn a page after a long press', () => {
    press(600);
    vi.advanceTimersByTime(250);
    expect(singleClicks()).toEqual([]);
  });

  it('keeps two closely spaced presses as a double click', () => {
    press(10);
    vi.advanceTimersByTime(50);
    press(10);
    vi.advanceTimersByTime(250);
    expect(singleClicks()).toEqual([]);
    expect(messages.mock.calls.map(([message]) => message.type))
      .toContain('iframe-double-click');
  });
});
