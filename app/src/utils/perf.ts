type RenderComponent =
  | 'Reader'
  | 'ReaderContent'
  | 'BooksGrid'
  | 'FoliateViewer'
  | 'Annotator'
  | 'HeaderBar'
  | 'FooterBar'
  | 'ChatPanel'
  | 'ChatHistory';

declare global {
  var __MARGINALIA_PERF: boolean | undefined;
  var __MARGINALIA_PERF_OPEN: string | undefined;
  var __perfMark: typeof perfMark | undefined;
}

const enabled = globalThis.__MARGINALIA_PERF === true;
const noop = () => {};
let remaining = 10000;
const renders = new Map<RenderComponent, number>();
let hoverPending = false;
let hoverSamples = 0;

export const perfMark = (name: string, extra?: Record<string, unknown>): void => {
  if (!enabled || remaining === 0) return;
  remaining -= 1;
  const line = `[perf] ${name} ${JSON.stringify({ ...extra, t: Math.round(performance.now()) })}`;
  console.info(line);
  if (remaining === 0) console.info('[perf] perf:trace-limit {}');
};

export const perfSpan = (
  name: string,
  extra?: Record<string, unknown>,
): ((more?: Record<string, unknown>) => void) => {
  if (!enabled || remaining === 0) return noop;
  const start = performance.now();
  return (more) => perfMark(name, { ...extra, ...more, dur: Math.round(performance.now() - start) });
};

export const perfRender = (component: RenderComponent): void => {
  if (enabled && remaining > 0) renders.set(component, (renders.get(component) ?? 0) + 1);
};

export const perfHoverFrame = (bar: 'header' | 'footer'): void => {
  if (!enabled || remaining === 0 || hoverPending || hoverSamples >= 300) return;
  hoverPending = true;
  hoverSamples += 1;
  const end = perfSpan('hover:next-frame-proxy', { bar });
  requestAnimationFrame(() => {
    hoverPending = false;
    end();
  });
};

export const perfAutoOpen = async (open: (hash: string) => void): Promise<void> => {
  const hash = globalThis.__MARGINALIA_PERF_OPEN;
  if (hash) {
    perfMark('perf:auto-open', { hash });
    open(hash);
  }
};

if (enabled) {
  globalThis.__perfMark = perfMark;
  perfMark('perf:enabled', { timeOrigin: performance.timeOrigin, traceLimit: remaining });
  let lastTick = performance.now();
  let lastFlush = lastTick;
  let driftCount = 0;
  let maxDrift = 0;
  const timer = setInterval(() => {
    const now = performance.now();
    const drift = now - lastTick - 100;
    lastTick = now;
    if (document.visibilityState === 'visible' && drift > 50) {
      driftCount += 1;
      maxDrift = Math.max(maxDrift, drift);
    }
    if (now - lastFlush >= 1000) {
      perfMark('react:render-attempts', {
        windowMs: Math.round(now - lastFlush),
        counts: Object.fromEntries(renders),
      });
      if (driftCount) {
        perfMark('main-thread:timer-drift', { count: driftCount, maxMs: Math.round(maxDrift) });
      }
      renders.clear();
      driftCount = 0;
      maxDrift = 0;
      lastFlush = now;
    }
    if (remaining === 0) clearInterval(timer);
  }, 100);
}
