/**
 * Lightweight performance marks for the T0.5 audit.
 *
 * Each mark is written to the console and, when running inside Tauri, to the
 * application log file via tauri-plugin-log so that timings can be read back
 * without a debugger. `t` is milliseconds since the webview navigation start;
 * the first mark also records `performance.timeOrigin` (epoch ms) so log lines
 * can be aligned with the Rust side and the process start time.
 */
let logInfo: ((msg: string) => Promise<void>) | null = null;
let logInit = false;

const ensureLogger = async () => {
  if (logInit) return;
  logInit = true;
  try {
    const mod = await import('@tauri-apps/plugin-log');
    logInfo = mod.info;
  } catch {
    logInfo = null;
  }
};

export const perfMark = (name: string, extra?: Record<string, unknown>) => {
  const t = Math.round(performance.now());
  const payload = { t, ...(extra ?? {}) };
  const line = `[perf] ${name} ${JSON.stringify(payload)}`;
  console.info(line);
  void ensureLogger().then(() => logInfo?.(line).catch(() => {}));
};

/** Returns a function that ends the span and records its duration. */
export const perfSpan = (name: string, extra?: Record<string, unknown>) => {
  const start = performance.now();
  return (more?: Record<string, unknown>) =>
    perfMark(name, { ...(extra ?? {}), ...(more ?? {}), dur: Math.round(performance.now() - start) });
};

/**
 * Measurement helper: when the app is launched with MARGINALIA_PERF_OPEN=<book hash>
 * in its environment, the library opens that book as soon as it is ready. This
 * reproduces the "click on a book" path end to end for timing purposes.
 */
export const perfAutoOpen = async (open: (hash: string) => void) => {
  try {
    const { invoke } = await import('@tauri-apps/api/core');
    const hash = await invoke<string>('get_environment_variable', { name: 'MARGINALIA_PERF_OPEN' });
    if (hash) {
      perfMark('perf:auto-open', { hash });
      open(hash);
    }
  } catch {
    // not running inside Tauri
  }
};

declare global {
  var __perfMark: typeof perfMark | undefined;
}

if (typeof globalThis !== 'undefined') {
  globalThis.__perfMark = perfMark;
}
