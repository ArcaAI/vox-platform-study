import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

describe('registerCrashHandlers', () => {
  const mockLoggingService = {
    fatal: vi.fn(),
    flush: vi.fn().mockResolvedValue(undefined),
    error: vi.fn(),
    warn: vi.fn(),
    info: vi.fn(),
    debug: vi.fn(),
    verbose: vi.fn(),
    http: vi.fn(),
    logWithLevel: vi.fn(),
    setContext: vi.fn(),
    child: vi.fn(),
    withMeta: vi.fn(),
    getLevel: vi.fn(),
    setLevel: vi.fn(),
  };

  let processOnSpy: ReturnType<typeof vi.spyOn>;
  let processExitSpy: ReturnType<typeof vi.spyOn>;
  const registeredHandlers = new Map<string, (...args: any[]) => any>();

  beforeEach(() => {
    vi.clearAllMocks();

    processOnSpy = vi.spyOn(process, 'on').mockImplementation(((event: string, handler: (...args: any[]) => void) => {
      registeredHandlers.set(event, handler);
      return process;
    }) as any);

    processExitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {}) as any);
  });

  afterEach(() => {
    processOnSpy.mockRestore();
    processExitSpy.mockRestore();
    registeredHandlers.clear();
  });

  it('should register uncaughtException handler', async () => {
    const { registerCrashHandlers } = await import('../crash-handlers');
    registerCrashHandlers(mockLoggingService);

    expect(processOnSpy).toHaveBeenCalledWith('uncaughtException', expect.any(Function));
  });

  it('should register unhandledRejection handler', async () => {
    const { registerCrashHandlers } = await import('../crash-handlers');
    registerCrashHandlers(mockLoggingService);

    expect(processOnSpy).toHaveBeenCalledWith('unhandledRejection', expect.any(Function));
  });

  it('should log fatal error via LoggingService on uncaught exception', async () => {
    const { registerCrashHandlers } = await import('../crash-handlers');
    registerCrashHandlers(mockLoggingService);

    const handler = registeredHandlers.get('uncaughtException');
    expect(handler).toBeDefined();

    const testError = new Error('Boom');
    await handler!(testError);

    expect(mockLoggingService.fatal).toHaveBeenCalledWith(
      expect.stringContaining('Uncaught exception'),
      expect.objectContaining({
        error: testError,
        errorMessage: 'Boom',
      }),
      'CrashHandler',
    );
  });

  it('should log fatal error via LoggingService on unhandled rejection', async () => {
    const { registerCrashHandlers } = await import('../crash-handlers');
    registerCrashHandlers(mockLoggingService);

    const handler = registeredHandlers.get('unhandledRejection');
    expect(handler).toBeDefined();

    const testError = new Error('Promise rejected');
    await handler!(testError);

    expect(mockLoggingService.fatal).toHaveBeenCalledWith(
      expect.stringContaining('Unhandled promise rejection'),
      expect.objectContaining({
        error: testError,
        errorMessage: 'Promise rejected',
      }),
      'CrashHandler',
    );
  });

  it('should call flush after logging fatal error', async () => {
    const { registerCrashHandlers } = await import('../crash-handlers');
    registerCrashHandlers(mockLoggingService);

    const handler = registeredHandlers.get('uncaughtException');
    await handler!(new Error('Test'));

    expect(mockLoggingService.flush).toHaveBeenCalledTimes(1);
  });

  it('should call process.exit(1) after flushing', async () => {
    const { registerCrashHandlers } = await import('../crash-handlers');
    registerCrashHandlers(mockLoggingService);

    const handler = registeredHandlers.get('uncaughtException');
    await handler!(new Error('Test'));

    expect(processExitSpy).toHaveBeenCalledWith(1);
  });

  it('should handle non-Error rejection reasons by wrapping in Error', async () => {
    const { registerCrashHandlers } = await import('../crash-handlers');
    registerCrashHandlers(mockLoggingService);

    const handler = registeredHandlers.get('unhandledRejection');
    await handler!('string rejection reason');

    expect(mockLoggingService.fatal).toHaveBeenCalledWith(
      expect.stringContaining('Unhandled promise rejection'),
      expect.objectContaining({
        errorMessage: 'string rejection reason',
      }),
      'CrashHandler',
    );
  });

  it('should still exit even if logging fails', async () => {
    mockLoggingService.fatal.mockImplementation(() => {
      throw new Error('Logging broken');
    });

    const { registerCrashHandlers } = await import('../crash-handlers');
    registerCrashHandlers(mockLoggingService);

    const handler = registeredHandlers.get('uncaughtException');
    await handler!(new Error('Test'));

    expect(processExitSpy).toHaveBeenCalledWith(1);
  });
});
