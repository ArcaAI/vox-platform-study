import type { ILoggingService } from '@arcaai/applications';

export function registerCrashHandlers(loggingService: ILoggingService): void {
  process.on('uncaughtException', async (error: Error) => {
    try {
      loggingService.fatal(
        'Uncaught exception — process will exit',
        {
          error,
          errorMessage: error.message,
          errorStack: error.stack,
        },
        'CrashHandler',
      );
      await loggingService.flush();
    } catch {
      console.error('[CrashHandler] Failed to log uncaught exception:', error);
    }
    process.exit(1);
  });

  process.on('unhandledRejection', async (reason: unknown) => {
    const error = reason instanceof Error ? reason : new Error(String(reason));
    try {
      loggingService.fatal(
        'Unhandled promise rejection — process will exit',
        {
          error,
          errorMessage: error.message,
          errorStack: error.stack,
        },
        'CrashHandler',
      );
      await loggingService.flush();
    } catch {
      console.error('[CrashHandler] Failed to log unhandled rejection:', error);
    }
    process.exit(1);
  });
}
