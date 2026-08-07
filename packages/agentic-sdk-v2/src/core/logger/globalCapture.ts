/**
 * @arcaai/vox - Global browser capture
 *
 * Bridges the three telemetry sources that `SDKLogger` cannot see on its own
 * into the normal transport pipeline (console → Clarity/Highlight/Loki/OTel):
 *
 *   1. `console.*` calls made by application code and third-party libraries.
 *   2. Uncaught errors (`window` `'error'` events), including resource errors.
 *   3. Unhandled promise rejections (`'unhandledrejection'`).
 *
 * Without this, only messages that SDK code explicitly routed through
 * `SDKLogger` ever reach a transport — which is why a staging bug report
 * arrives with an empty log trail even though the browser console was full.
 *
 * Everything captured here flows through `SDKLogger.dispatch()`, so
 * `redactPHI()` applies before any transport sees it.
 *
 * ## Recursion
 *
 * `ConsoleTransport` writes with `console.*`, resolved at dispatch time. Naive
 * patching therefore loops forever: patched console → logger → console
 * transport → patched console. Two defences:
 *
 *   - The original console methods are captured at install time and used for
 *     pass-through, so the developer's console output is never altered.
 *   - A re-entrancy flag is held for the duration of the forward, so ANY
 *     console call made while dispatching (by a transport or by the logger
 *     itself) goes straight to the original and is never re-captured.
 *
 * ## PHI
 *
 * Console capture forwards arbitrary application strings. `redactPHI()` scrubs
 * known PHI KEYS and `data:`/`blob:`/`file:` URLs, but it cannot scrub PHI
 * embedded in a free-text string such as
 * `console.log('patient John Doe: ...')`. Console capture is therefore
 * OPT-IN and defaults to off. Enable it only where the data is synthetic —
 * i.e. development and staging, which is also where the fail-closed monitoring
 * transports are permitted to run at all.
 */

import type { ISDKLogger, LogLevel } from './types';

/** Console methods that can be captured, mapped to the level they log at. */
const CONSOLE_METHOD_LEVELS = {
  log: 'info',
  info: 'info',
  debug: 'debug',
  warn: 'warn',
  error: 'error',
} as const satisfies Record<string, LogLevel>;

type CapturedConsoleMethod = keyof typeof CONSOLE_METHOD_LEVELS;

const ALL_CONSOLE_METHODS = Object.keys(CONSOLE_METHOD_LEVELS) as CapturedConsoleMethod[];

/** Default: warnings and errors only — `log`/`debug` are high-volume and low-signal. */
const DEFAULT_CONSOLE_METHODS: CapturedConsoleMethod[] = ['warn', 'error'];

const DEFAULT_MAX_ARG_LENGTH = 2000;
const DEFAULT_MAX_EVENTS_PER_MINUTE = 200;
const RATE_WINDOW_MS = 60_000;

export interface GlobalCaptureOptions {
  /**
   * Capture `console.*` calls. Defaults to false — see the PHI note above.
   */
  console?: boolean;
  /**
   * Which console methods to capture. Defaults to `['warn', 'error']`.
   * Use `['log', 'info', 'debug', 'warn', 'error']` for a full staging trail.
   */
  consoleMethods?: CapturedConsoleMethod[];
  /**
   * Capture uncaught errors and unhandled promise rejections.
   * Defaults to true — these are pure signal and carry no free-text PHI risk
   * beyond what the app already threw.
   */
  globalErrors?: boolean;
  /** Truncate each stringified argument to this length. Defaults to 2000. */
  maxArgLength?: number;
  /**
   * Drop captured events beyond this many per rolling minute, so a render-loop
   * console spam cannot flood the transports (or the Clarity event quota).
   * Defaults to 200.
   */
  maxEventsPerMinute?: number;
}

/** Uninstall handle returned by `installGlobalCapture`. */
export type UninstallGlobalCapture = () => void;

/**
 * Module-level re-entrancy flag. Any console call made while we are forwarding
 * to the logger bypasses capture entirely.
 */
let forwarding = false;

/** Only one capture installation may be active per document. */
let activeUninstall: UninstallGlobalCapture | null = null;

/**
 * Install global capture. Returns an uninstall function that fully restores the
 * original `console` methods and removes the window listeners.
 *
 * Idempotent: a second call while an installation is active is a no-op that
 * returns the existing uninstall handle.
 */
export function installGlobalCapture(logger: ISDKLogger, options: GlobalCaptureOptions = {}): UninstallGlobalCapture {
  if (typeof window === 'undefined') return () => {};
  if (activeUninstall) return activeUninstall;

  const {
    console: captureConsole = false,
    consoleMethods = DEFAULT_CONSOLE_METHODS,
    globalErrors = true,
    maxArgLength = DEFAULT_MAX_ARG_LENGTH,
    maxEventsPerMinute = DEFAULT_MAX_EVENTS_PER_MINUTE,
  } = options;

  const captureLogger = logger.child('browser');
  const teardowns: Array<() => void> = [];

  // ---------------------------------------------------------------------------
  // Rate limiting — a rolling one-minute budget shared by all capture sources.
  // ---------------------------------------------------------------------------
  let windowStart = Date.now();
  let windowCount = 0;
  let suppressed = 0;

  function withinBudget(): boolean {
    const now = Date.now();
    if (now - windowStart >= RATE_WINDOW_MS) {
      // Report what the previous window swallowed so a silent gap is never
      // mistaken for silence.
      if (suppressed > 0) {
        forward(() => captureLogger.warn(`Global capture suppressed ${suppressed} events (rate limit)`, { attributes: { suppressed } }));
        suppressed = 0;
      }
      windowStart = now;
      windowCount = 0;
    }
    if (windowCount >= maxEventsPerMinute) {
      suppressed++;
      return false;
    }
    windowCount++;
    return true;
  }

  /** Run a logger call with the re-entrancy guard held. */
  function forward(fn: () => void): void {
    if (forwarding) return;
    forwarding = true;
    try {
      fn();
    } catch {
      // Capture must never break the host application.
    } finally {
      forwarding = false;
    }
  }

  // ---------------------------------------------------------------------------
  // console.* capture
  // ---------------------------------------------------------------------------
  if (captureConsole) {
    const target = window.console as unknown as Record<string, unknown>;
    const requested = consoleMethods.filter((m) => ALL_CONSOLE_METHODS.includes(m));

    for (const method of requested) {
      const original = target[method];
      if (typeof original !== 'function') continue;

      const originalFn = original as (...args: unknown[]) => void;
      const level = CONSOLE_METHOD_LEVELS[method];

      const patched = (...args: unknown[]): void => {
        // Always preserve the developer's own console output first.
        originalFn.apply(window.console, args);

        if (forwarding) return;
        if (!withinBudget()) return;

        forward(() => {
          const { message, attributes } = describeArgs(args, maxArgLength);
          captureLogger[level](message, {
            operation: 'console',
            attributes: { consoleMethod: method, ...attributes },
          });
        });
      };

      target[method] = patched;
      teardowns.push(() => {
        // Only restore if nothing else patched over us in the meantime.
        if (target[method] === patched) target[method] = originalFn;
      });
    }
  }

  // ---------------------------------------------------------------------------
  // Uncaught errors and unhandled rejections
  // ---------------------------------------------------------------------------
  if (globalErrors) {
    const onError = (event: ErrorEvent): void => {
      if (!withinBudget()) return;
      forward(() => {
        captureLogger.error(event.message || 'Uncaught error', {
          error: event.error instanceof Error ? event.error : { name: 'UncaughtError', stack: undefined },
          attributes: {
            source: 'window.onerror',
            filename: event.filename,
            lineno: event.lineno,
            colno: event.colno,
          },
        });
      });
    };

    const onRejection = (event: PromiseRejectionEvent): void => {
      if (!withinBudget()) return;
      forward(() => {
        const reason = event.reason;
        captureLogger.error(reason instanceof Error ? reason.message : 'Unhandled promise rejection', {
          error: reason instanceof Error ? reason : { name: 'UnhandledRejection', stack: undefined },
          attributes: {
            source: 'unhandledrejection',
            ...(reason instanceof Error ? {} : { reason: truncate(safeString(reason), maxArgLength) }),
          },
        });
      });
    };

    window.addEventListener('error', onError);
    window.addEventListener('unhandledrejection', onRejection);
    teardowns.push(() => {
      window.removeEventListener('error', onError);
      window.removeEventListener('unhandledrejection', onRejection);
    });
  }

  const uninstall: UninstallGlobalCapture = () => {
    for (const teardown of teardowns) {
      try {
        teardown();
      } catch {
        // Best-effort restore.
      }
    }
    teardowns.length = 0;
    if (activeUninstall === uninstall) activeUninstall = null;
  };

  activeUninstall = uninstall;
  return uninstall;
}

/**
 * Test seam: forget any active installation without restoring it. Only for
 * suites that need a clean module state.
 * @internal
 */
export function __resetGlobalCaptureForTests(): void {
  activeUninstall = null;
  forwarding = false;
}

/**
 * Turn console arguments into a message plus structured attributes.
 *
 * The first string argument becomes the message so transports and dashboards
 * group sensibly; remaining arguments ride along as `attributes.args`, where
 * `redactPHI()` walks them like any other structured payload.
 */
function describeArgs(args: unknown[], maxArgLength: number): { message: string; attributes: Record<string, unknown> } {
  if (args.length === 0) return { message: '(empty console call)', attributes: {} };

  const [first, ...rest] = args;
  const message = truncate(typeof first === 'string' ? first : safeString(first), maxArgLength);

  if (rest.length === 0) return { message, attributes: {} };

  return {
    message,
    attributes: {
      args: rest.map((arg) => (arg instanceof Error ? arg : truncate(safeString(arg), maxArgLength))),
    },
  };
}

function safeString(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value instanceof Error) return `${value.name}: ${value.message}`;
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    // Circular or non-serialisable.
    return String(value);
  }
}

function truncate(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max)}… [truncated ${value.length - max} chars]` : value;
}
