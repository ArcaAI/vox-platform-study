import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

import { registerCrashHandlers } from '../crash-handlers';

/**
 * Crash handlers are registered BEFORE `NestFactory.create` — a crash during
 * module construction (a secret that fails to warm, a provider that throws) is
 * exactly the crash nobody could see — so they must work with no logging
 * service yet (stderr), pick the service up once it exists, flush the logger
 * AND OpenTelemetry within a bounded time, and always exit.
 */
describe('registerCrashHandlers', () => {
  const makeLoggingService = () => ({
    fatal: vi.fn(),
    flush: vi.fn().mockResolvedValue(undefined),
  });

  let processOnSpy: ReturnType<typeof vi.spyOn>;
  let processExitSpy: ReturnType<typeof vi.spyOn>;
  let stderrSpy: ReturnType<typeof vi.spyOn>;
  const registeredHandlers = new Map<string, (...args: any[]) => any>();

  beforeEach(() => {
    vi.clearAllMocks();
    processOnSpy = vi.spyOn(process, 'on').mockImplementation(((event: string, handler: (...args: any[]) => void) => {
      registeredHandlers.set(event, handler);
      return process;
    }) as any);
    processExitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {}) as any);
    stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation((() => true) as any);
  });

  afterEach(() => {
    processOnSpy.mockRestore();
    processExitSpy.mockRestore();
    stderrSpy.mockRestore();
    registeredHandlers.clear();
  });

  it('registers uncaughtException and unhandledRejection handlers', () => {
    registerCrashHandlers();
    expect(processOnSpy).toHaveBeenCalledWith('uncaughtException', expect.any(Function));
    expect(processOnSpy).toHaveBeenCalledWith('unhandledRejection', expect.any(Function));
  });

  it('before a logging service exists, writes one JSON line to stderr and exits 1', async () => {
    registerCrashHandlers();
    await registeredHandlers.get('uncaughtException')!(new Error('boot boom'));

    expect(stderrSpy).toHaveBeenCalledTimes(1);
    const line = JSON.parse(String(stderrSpy.mock.calls[0][0]));
    expect(line).toMatchObject({ level: 'fatal', message: expect.stringContaining('Uncaught exception') });
    expect(line.error).toMatchObject({ name: 'Error', message: 'boot boom' });
    expect(line.error.stack).toContain('boot boom');
    expect(processExitSpy).toHaveBeenCalledWith(1);
  });

  it('once attached, logs fatal via the logging service with the Error object only (no duplicate message/stack fields)', async () => {
    const loggingService = makeLoggingService();
    const handle = registerCrashHandlers();
    handle.attachLogger(loggingService);

    const testError = new Error('Boom');
    await registeredHandlers.get('uncaughtException')!(testError);

    expect(loggingService.fatal).toHaveBeenCalledWith(expect.stringContaining('Uncaught exception'), { error: testError }, 'CrashHandler');
    expect(stderrSpy).not.toHaveBeenCalled();
  });

  it('wraps a non-Error rejection reason in an Error', async () => {
    const loggingService = makeLoggingService();
    registerCrashHandlers(loggingService);
    await registeredHandlers.get('unhandledRejection')!('string rejection reason');

    const meta = loggingService.fatal.mock.calls[0][1] as { error: Error };
    expect(meta.error).toBeInstanceOf(Error);
    expect(meta.error.message).toBe('string rejection reason');
  });

  it('flushes the logger AND OpenTelemetry, then exits 1', async () => {
    const loggingService = makeLoggingService();
    const flushOtel = vi.fn().mockResolvedValue(undefined);
    registerCrashHandlers(loggingService, { flushOtel });

    await registeredHandlers.get('uncaughtException')!(new Error('Test'));

    expect(loggingService.flush).toHaveBeenCalledTimes(1);
    expect(flushOtel).toHaveBeenCalledTimes(1);
    expect(processExitSpy).toHaveBeenCalledWith(1);
  });

  it('bounds the flush: a hung flush still exits within the timeout', async () => {
    const loggingService = { fatal: vi.fn(), flush: vi.fn(() => new Promise<void>(() => undefined)) };
    registerCrashHandlers(loggingService, { flushTimeoutMs: 20 });

    const started = Date.now();
    await registeredHandlers.get('uncaughtException')!(new Error('Test'));

    expect(Date.now() - started).toBeLessThan(1000);
    expect(processExitSpy).toHaveBeenCalledWith(1);
  });

  it('still exits, via stderr, when the logging service itself throws', async () => {
    const loggingService = makeLoggingService();
    loggingService.fatal.mockImplementation(() => {
      throw new Error('Logging broken');
    });
    registerCrashHandlers(loggingService);

    await registeredHandlers.get('uncaughtException')!(new Error('Test'));

    expect(stderrSpy).toHaveBeenCalled();
    expect(processExitSpy).toHaveBeenCalledWith(1);
  });
});
