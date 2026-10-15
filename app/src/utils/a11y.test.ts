import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createA11yNavigation } from './a11y';

const observers: ControlledObserver[] = [];
class ControlledObserver implements IntersectionObserver {
  readonly root = null;
  readonly rootMargin = '0px';
  readonly scrollMargin = '0px';
  readonly thresholds = [0];
  readonly targets: Element[] = [];
  disconnect = vi.fn();
  unobserve = vi.fn();
  takeRecords = () => [];
  constructor(readonly callback: IntersectionObserverCallback) {
    observers.push(this);
  }
  observe(target: Element) { this.targets.push(target); }
  deliver() {
    this.callback(this.targets.map((target) => ({
      target, isIntersecting: true, intersectionRatio: 1, time: 0,
      boundingClientRect: new DOMRect(), intersectionRect: new DOMRect(), rootBounds: null,
    })), this);
  }
}

const makeView = () => {
  const renderer = Object.assign(new EventTarget(), { goTo: vi.fn() });
  const add = vi.spyOn(renderer, 'addEventListener');
  const remove = vi.spyOn(renderer, 'removeEventListener');
  const getCFI = vi.fn((index: number, range: Range) => `${index}:${range.toString()}`);
  const resolveNavigation = vi.fn((cfi: string | number) => ({ index: Number(String(cfi).split(':')[0]) }));
  const view = { renderer, getCFI, resolveNavigation } satisfies Parameters<typeof createA11yNavigation>[0];
  return { view, renderer, add, remove, getCFI, resolveNavigation };
};
const makeDocument = (text = 'paragraph') => {
  const doc = document.implementation.createHTMLDocument();
  doc.body.innerHTML = `<a href="#">link</a><p>${text}</p>`;
  return doc;
};
beforeEach(() => { vi.useFakeTimers(); observers.length = 0; vi.stubGlobal('IntersectionObserver', ControlledObserver); });
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

it('owns one renderer listener pair across 100 documents and removes it on disposal', () => {
  const { view, add, remove } = makeView();
  const session = createA11yNavigation(view);
  for (let index = 0; index < 100; index++) session.observeDocument(makeDocument(), index);
  expect(add.mock.calls.filter(([event]) => event === 'scroll')).toHaveLength(1);
  expect(add.mock.calls.filter(([event]) => event === 'relocate')).toHaveLength(1);
  session.dispose();
  session.dispose();
  expect(remove).toHaveBeenCalledTimes(2);
  expect(remove).toHaveBeenCalledWith('scroll', add.mock.calls[0]![1]);
  expect(remove).toHaveBeenCalledWith('relocate', add.mock.calls[1]![1]);
});

it('deduplicates document identity while observing replacement documents for the same index', () => {
  const { view } = makeView();
  const session = createA11yNavigation(view);
  const doc = makeDocument();
  session.observeDocument(doc, 4);
  session.observeDocument(doc, 4);
  session.observeDocument(makeDocument(), 4);
  expect(observers).toHaveLength(2);
  expect(doc.querySelectorAll('#marginalia-skip-link')).toHaveLength(1);
  expect(doc.querySelector('a')?.getAttribute('tabindex')).toBe('-1');
});

it('shares relocation suppression with newly loaded documents and navigates the correct document after it expires', () => {
  const { view, renderer, getCFI, resolveNavigation } = makeView();
  const session = createA11yNavigation(view);
  session.observeDocument(makeDocument('first'), 1);
  renderer.dispatchEvent(new Event('relocate'));
  session.observeDocument(makeDocument('second'), 7);
  const observer = observers[1]!;
  observer.deliver();
  observer.deliver();
  vi.advanceTimersByTime(500);
  expect(renderer.goTo).not.toHaveBeenCalled();
  vi.advanceTimersByTime(1500);
  observer.deliver();
  expect(getCFI.mock.calls[0]?.[0]).toBe(7);
  expect(getCFI.mock.calls[0]?.[1].toString()).toBe('second');
  vi.advanceTimersByTime(499);
  expect(renderer.goTo).not.toHaveBeenCalled();
  vi.advanceTimersByTime(1);
  expect(resolveNavigation).toHaveBeenCalledExactlyOnceWith('7:second');
  expect(renderer.goTo).toHaveBeenCalledExactlyOnceWith({ index: 7 });
});

it('refuses navigation, skip links and document installation after disposal', () => {
  const { view, renderer } = makeView();
  const session = createA11yNavigation(view);
  const doc = makeDocument();
  const skip = vi.fn();
  session.observeDocument(doc, 3, { skipToLastPosCallback: skip, skipToLastPosLabel: 'Skip' });
  doc.getElementById('marginalia-skip-link')!.click();
  expect(skip).toHaveBeenCalledTimes(1);
  observers[0]!.deliver();
  observers[0]!.deliver();
  session.dispose();
  vi.advanceTimersByTime(500);
  observers[0]!.deliver();
  doc.getElementById('marginalia-skip-link')!.click();
  session.observeDocument(makeDocument(), 5);
  vi.runAllTimers();
  expect(renderer.goTo).not.toHaveBeenCalled();
  expect(skip).toHaveBeenCalledTimes(1);
  expect(observers).toHaveLength(1);
});

it('cancels relocation debounce and cannot rearm it from trailing throttle work', () => {
  const { view, renderer } = makeView();
  const session = createA11yNavigation(view);
  session.observeDocument(makeDocument(), 0);
  renderer.dispatchEvent(new Event('scroll'));
  vi.advanceTimersByTime(100);
  renderer.dispatchEvent(new Event('relocate'));
  session.dispose();
  vi.advanceTimersByTime(1000);
  expect(vi.getTimerCount()).toBe(0);
});
