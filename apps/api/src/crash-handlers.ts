/** The slice of `ILoggingService` a crash needs. */
export interface CrashLogger {
  fatal(message: string, meta: Record<string, unknown>, context?: string): void;
  flush(): Promise<void>;
}

export interface CrashHandlerOptions {
  /** Flushes buffered OpenTelemetry spans (`instrumentation.ts#flushOtel`). */
  flushOtel?: () => Promise<void>;
  /** Upper bound on the whole flush before the process exits anyway. */
  flushTimeoutMs?: number;
}

export interface CrashHandlerHandle {
  /** Route crash lines through the logging service once it exists. */
  attachLogger(logger: CrashLogger): void;
}

const DEFAULT_FLUSH_TIMEOUT_MS = 2_000;

/**
 * Register the process-level crash handlers.
 *
 * Called at the very top of `main.ts`, BEFORE `NestFactory.create`: a crash
 * during module construction (a secret that fails to warm, a provider that
 * throws) used to happen before any handler existed, so it died without a
 * line. Until a logging service is attached the crash goes to stderr as one
 * JSON line; afterwards it goes through the logging service. Either way the
 * logger and OpenTelemetry are flushed — bounded, so a hung transport cannot
 * keep a dying process alive — and the process exits 1.
 */
export function registerCrashHandlers(logger?: CrashLogger, options: CrashHandlerOptions = {}): CrashHandlerHandle {
  let current = logger;
  const flushTimeoutMs = options.flushTimeoutMs ?? DEFAULT_FLUSH_TIMEOUT_MS;

  const crash = async (message: string, error: Error): Promise<void> => {
    const target = current;
    let logged = false;
    if (target) {
      try {
        target.fatal(message, { error }, 'CrashHandler');
        logged = true;
      } catch {
        // Fall through to stderr.
      }
    }
    if (!logged) writeCrashLine(message, error);

    await boundedFlush([target?.flush(), options.flushOtel?.()], flushTimeoutMs);
    process.exit(1);
  };

  process.on('uncaughtException', (error: Error) => crash('Uncaught exception — process will exit', error));
  process.on('unhandledRejection', (reason: unknown) =>
    crash('Unhandled promise rejection — process will exit', reason instanceof Error ? reason : new Error(String(reason))),
  );

  return {
    attachLogger(next: CrashLogger): void {
      current = next;
    },
  };
}

async function boundedFlush(flushes: Array<Promise<void> | undefined>, timeoutMs: number): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, timeoutMs);
    timer.unref?.();
  });
  const settled = Promise.allSettled(flushes.map((flush) => Promise.resolve(flush)));
  await Promise.race([settled, timeout]);
  if (timer) clearTimeout(timer);
}

/** Last-resort output: one JSON line on stderr, the same shape the logger writes. */
function writeCrashLine(message: string, error: Error): void {
  try {
    process.stderr.write(
      `${JSON.stringify({
        timestamp: new Date().toISOString(),
        level: 'fatal',
        service: 'api',
        message,
        error: { name: error.name, message: error.message, stack: error.stack },
      })}\n`,
    );
  } catch {
    // Nothing left to report through.
  }
}
