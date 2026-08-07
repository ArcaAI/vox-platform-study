/**
 * @arcaai/vox - Global browser capture tests
 * @vitest-environment jsdom
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { installGlobalCapture, __resetGlobalCaptureForTests } from '../globalCapture';
import type { ISDKLogger } from '../types';

/** Minimal ISDKLogger stub — `child()` returns the same recorder. */
function makeLogger() {
  const calls: Array<{ level: string; message: string; meta?: unknown }> = [];
  const logger = {
    calls,
    fatal: (message: string, meta?: unknown) => calls.push({ level: 'fatal', message, meta }),
    error: (message: string, meta?: unknown) => calls.push({ level: 'error', message, meta }),
    warn: (message: string, meta?: unknown) => calls.push({ level: 'warn', message, meta }),
    info: (message: string, meta?: unknown) => calls.push({ level: 'info', message, meta }),
    debug: (message: string, meta?: unknown) => calls.push({ level: 'debug', message, meta }),
    trace: (message: string, meta?: unknown) => calls.push({ level: 'trace', message, meta }),
    child: () => logger,
  };
  return logger as unknown as ISDKLogger & { calls: typeof calls };
}

describe('installGlobalCapture', () => {
  let uninstall: (() => void) | null = null;
  let originalConsole: Record<string, unknown>;

  beforeEach(() => {
    __resetGlobalCaptureForTests();
    originalConsole = {
      log: console.log,
      info: console.info,
      debug: console.debug,
      warn: console.warn,
      error: console.error,
    };
  });

  afterEach(() => {
    uninstall?.();
    uninstall = null;
    __resetGlobalCaptureForTests();
    Object.assign(console, originalConsole);
  });

  describe('console capture', () => {
    it('is off by default', () => {
      const logger = makeLogger();
      uninstall = installGlobalCapture(logger);
      console.error('boom');
      expect(logger.calls).toHaveLength(0);
    });

    it('captures warn and error when enabled', () => {
      const logger = makeLogger();
      uninstall = installGlobalCapture(logger, { console: true });

      console.warn('careful');
      console.error('broken');

      expect(logger.calls.map((c) => [c.level, c.message])).toEqual([
        ['warn', 'careful'],
        ['error', 'broken'],
      ]);
    });

    it('does not capture log/info/debug unless requested', () => {
      const logger = makeLogger();
      uninstall = installGlobalCapture(logger, { console: true });
      console.log('chatter');
      expect(logger.calls).toHaveLength(0);
    });

    it('captures the full console surface when requested', () => {
      const logger = makeLogger();
      uninstall = installGlobalCapture(logger, {
        console: true,
        consoleMethods: ['log', 'info', 'debug', 'warn', 'error'],
      });

      console.log('a');
      console.info('b');
      console.debug('c');
      console.warn('d');
      console.error('e');

      expect(logger.calls.map((c) => c.level)).toEqual(['info', 'info', 'debug', 'warn', 'error']);
    });

    it('still writes through to the original console', () => {
      const spy = vi.fn();
      console.error = spy;
      const logger = makeLogger();
      uninstall = installGlobalCapture(logger, { console: true });

      console.error('passthrough', 42);

      expect(spy).toHaveBeenCalledWith('passthrough', 42);
    });

    it('carries extra arguments as structured attributes', () => {
      const logger = makeLogger();
      uninstall = installGlobalCapture(logger, { console: true });

      console.error('failed', { code: 'E1' }, 7);

      const meta = logger.calls[0].meta as { attributes: { args: unknown[]; consoleMethod: string } };
      expect(meta.attributes.consoleMethod).toBe('error');
      expect(meta.attributes.args).toEqual(['{"code":"E1"}', '7']);
    });

    it('truncates oversized arguments', () => {
      const logger = makeLogger();
      uninstall = installGlobalCapture(logger, { console: true, maxArgLength: 10 });

      console.error('x'.repeat(50));

      expect(logger.calls[0].message).toMatch(/^x{10}… \[truncated 40 chars\]$/);
    });

    it('survives circular arguments', () => {
      const logger = makeLogger();
      uninstall = installGlobalCapture(logger, { console: true });

      const circular: Record<string, unknown> = { name: 'loop' };
      circular.self = circular;

      expect(() => console.error('circular', circular)).not.toThrow();
      expect(logger.calls).toHaveLength(1);
    });

    it('restores the original console methods on uninstall', () => {
      const logger = makeLogger();
      const before = console.error;
      const stop = installGlobalCapture(logger, { console: true });
      expect(console.error).not.toBe(before);

      stop();
      expect(console.error).toBe(before);

      console.error('after uninstall');
      expect(logger.calls).toHaveLength(0);
    });
  });

  describe('recursion safety', () => {
    it('does not loop when the logger itself writes to console', () => {
      const calls: string[] = [];
      // A logger whose error() writes to console — exactly what ConsoleTransport does.
      const recursive = {
        calls,
        error: (message: string) => {
          calls.push(message);
          console.error('[transport]', message);
        },
        warn: () => {},
        info: () => {},
        debug: () => {},
        trace: () => {},
        fatal: () => {},
        child: () => recursive,
      } as unknown as ISDKLogger & { calls: string[] };

      uninstall = installGlobalCapture(recursive, { console: true });

      expect(() => console.error('origin')).not.toThrow();
      // Exactly one capture: the transport's own console.error is not re-captured.
      expect(calls).toEqual(['origin']);
    });
  });

  describe('global error capture', () => {
    it('captures uncaught errors by default', () => {
      const logger = makeLogger();
      uninstall = installGlobalCapture(logger);

      window.dispatchEvent(
        new ErrorEvent('error', { message: 'kaboom', filename: 'app.js', lineno: 12, colno: 3, error: new Error('kaboom') }),
      );

      expect(logger.calls).toHaveLength(1);
      expect(logger.calls[0].level).toBe('error');
      expect(logger.calls[0].message).toBe('kaboom');
      const meta = logger.calls[0].meta as { attributes: { source: string; lineno: number } };
      expect(meta.attributes.source).toBe('window.onerror');
      expect(meta.attributes.lineno).toBe(12);
    });

    it('captures unhandled promise rejections', () => {
      const logger = makeLogger();
      uninstall = installGlobalCapture(logger);

      const event = new Event('unhandledrejection') as PromiseRejectionEvent;
      Object.defineProperty(event, 'reason', { value: new Error('rejected!') });
      window.dispatchEvent(event);

      expect(logger.calls).toHaveLength(1);
      expect(logger.calls[0].message).toBe('rejected!');
    });

    it('captures non-Error rejection reasons', () => {
      const logger = makeLogger();
      uninstall = installGlobalCapture(logger);

      const event = new Event('unhandledrejection') as PromiseRejectionEvent;
      Object.defineProperty(event, 'reason', { value: { code: 503 } });
      window.dispatchEvent(event);

      const meta = logger.calls[0].meta as { attributes: { reason: string } };
      expect(meta.attributes.reason).toBe('{"code":503}');
    });

    it('can be turned off', () => {
      const logger = makeLogger();
      uninstall = installGlobalCapture(logger, { globalErrors: false });
      window.dispatchEvent(new ErrorEvent('error', { message: 'ignored' }));
      expect(logger.calls).toHaveLength(0);
    });

    it('removes listeners on uninstall', () => {
      const logger = makeLogger();
      const stop = installGlobalCapture(logger);
      stop();
      window.dispatchEvent(new ErrorEvent('error', { message: 'after' }));
      expect(logger.calls).toHaveLength(0);
    });
  });

  describe('rate limiting', () => {
    it('caps captured events per rolling minute', () => {
      const logger = makeLogger();
      uninstall = installGlobalCapture(logger, { console: true, maxEventsPerMinute: 5 });

      for (let i = 0; i < 20; i++) console.error(`spam ${i}`);

      expect(logger.calls).toHaveLength(5);
    });

    it('reports how many events a window suppressed', () => {
      vi.useFakeTimers();
      try {
        const logger = makeLogger();
        uninstall = installGlobalCapture(logger, { console: true, maxEventsPerMinute: 2 });

        for (let i = 0; i < 6; i++) console.error(`spam ${i}`);
        expect(logger.calls).toHaveLength(2);

        vi.advanceTimersByTime(61_000);
        console.error('next window');

        const suppressionNotice = logger.calls.find((c) => c.message.includes('suppressed'));
        expect(suppressionNotice?.message).toContain('suppressed 4 events');
      } finally {
        vi.useRealTimers();
      }
    });
  });

  describe('installation lifecycle', () => {
    it('is idempotent — a second install does not double-patch', () => {
      const logger = makeLogger();
      const stop1 = installGlobalCapture(logger, { console: true });
      const stop2 = installGlobalCapture(logger, { console: true });

      expect(stop2).toBe(stop1);

      console.error('once');
      expect(logger.calls).toHaveLength(1);

      stop1();
    });
  });
});
