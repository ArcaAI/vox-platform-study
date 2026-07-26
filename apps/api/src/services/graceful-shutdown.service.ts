import { TenantSettingsService } from '@arcaai/applications';
import { BeforeApplicationShutdown, Injectable, Logger, OnApplicationShutdown, OnModuleDestroy, OnModuleInit, Optional } from '@nestjs/common';

/**
 * GracefulShutdownService
 *
 * Coordinates graceful shutdown across the application.
 * Implements NestJS lifecycle hooks for proper resource cleanup.
 *
 * Shutdown sequence:
 * 1. SIGTERM/SIGINT received
 * 2. onModuleDestroy() - Mark as shutting down, stop accepting new work
 * 3. beforeApplicationShutdown() - Drain existing connections/requests
 * 4. onApplicationShutdown() - Final cleanup, close all resources
 *
 * Best practices implemented:
 * - Kubernetes-compatible shutdown handling
 * - Configurable shutdown timeout
 * - Health check state for readiness probes
 * - Coordinated service shutdown
 */
@Injectable()
export class GracefulShutdownService implements OnModuleInit, OnModuleDestroy, BeforeApplicationShutdown, OnApplicationShutdown {
  private readonly logger = new Logger(GracefulShutdownService.name);

  /**
   * Indicates whether the application is in the process of shutting down.
   * Use this flag to reject new connections/requests during shutdown.
   */
  private _isShuttingDown = false;

  /**
   * Indicates whether the application is ready to accept traffic.
   * Used by health checks and Kubernetes readiness probes.
   */
  private _isReady = false;

  /**
   * Registered cleanup callbacks to be executed during shutdown.
   */
  private readonly cleanupCallbacks: Map<string, () => Promise<void>> = new Map();

  constructor(
    // TASK-558 lane I — `shutdown.timeoutMs` / `shutdown.drainDelayMs` are
    // `global-kv` platform settings. Optional so a graph without the settings
    // module keeps the env-var behaviour exactly.
    @Optional() private readonly tenantSettings?: TenantSettingsService,
  ) {
    this.logger.log({
      message: 'Service initialized',
      shutdownTimeoutMs: this.shutdownTimeoutMs,
      drainDelayMs: this.drainDelayMs,
    });
  }

  /**
   * Shutdown timeout in milliseconds — resolved AT USE, not at construction.
   *
   * These used to be `process.env` reads captured in the constructor, which
   * made them restart-bound (plan §9.2 L1). Resolving them when a drain
   * actually starts means an operator can widen the window during a bad deploy
   * and the very next pod to terminate honours it. Platform-only:
   * `maxScope: 'system'`, so there is no tenant lane to consult.
   * `SHUTDOWN_TIMEOUT_MS` remains the bootstrap fallback.
   */
  private get shutdownTimeoutMs(): number {
    return this.resolveMs('shutdown.timeoutMs', 'SHUTDOWN_TIMEOUT_MS', 30000);
  }

  /** Load-balancer drain delay in ms — resolved at use; see `shutdownTimeoutMs`. */
  private get drainDelayMs(): number {
    return this.resolveMs('shutdown.drainDelayMs', 'SHUTDOWN_DRAIN_DELAY_MS', 5000);
  }

  private resolveMs(key: string, envVar: string, fallback: number): number {
    if (this.tenantSettings) {
      const resolved = this.tenantSettings.resolvePlatform<number>(key).value;
      if (typeof resolved === 'number' && Number.isFinite(resolved)) return resolved;
    }
    const parsed = parseInt(process.env[envVar] || String(fallback), 10);
    return Number.isFinite(parsed) ? parsed : fallback;
  }

  /**
   * Called when the module is initialized.
   * Mark the application as ready to accept traffic.
   */
  onModuleInit(): void {
    this._isReady = true;
    this.logger.log({
      message: 'Application ready to accept traffic',
      isReady: true,
    });
  }

  /**
   * Called when SIGTERM/SIGINT is received and modules are being destroyed.
   * This is the first phase of shutdown - stop accepting new work.
   */
  async onModuleDestroy(): Promise<void> {
    const drainDelayMs = this.drainDelayMs;

    this.logger.log({
      message: 'Shutdown signal received',
      phase: 'onModuleDestroy',
      action: 'stopping_new_requests',
      drainDelayMs,
    });

    this._isShuttingDown = true;
    this._isReady = false;

    // Give load balancers time to detect the service is unhealthy
    this.logger.log({
      message: 'Waiting for load balancer drain',
      drainDelayMs,
    });
    await this.sleep(drainDelayMs);
  }

  /**
   * Called after onModuleDestroy, before connections are closed.
   * This is the phase to complete ongoing requests and drain connections.
   *
   * @param signal The termination signal (e.g., 'SIGTERM', 'SIGINT')
   */
  async beforeApplicationShutdown(signal?: string): Promise<void> {
    const startTime = Date.now();
    const remainingTimeMs = this.shutdownTimeoutMs - (Date.now() - startTime);

    this.logger.log({
      message: 'Before application shutdown',
      phase: 'beforeApplicationShutdown',
      signal: signal || 'none',
      cleanupCallbackCount: this.cleanupCallbacks.size,
      remainingTimeMs,
    });

    if (this.cleanupCallbacks.size > 0) {
      this.logger.log({
        message: 'Executing cleanup callbacks',
        count: this.cleanupCallbacks.size,
        remainingTimeMs,
      });

      const cleanupPromises: Promise<void>[] = [];

      for (const [name, callback] of this.cleanupCallbacks) {
        cleanupPromises.push(this.executeWithTimeout(callback, name, Math.min(remainingTimeMs, 10000)));
      }

      const results = await Promise.allSettled(cleanupPromises);
      const succeeded = results.filter((r) => r.status === 'fulfilled').length;
      const failed = results.filter((r) => r.status === 'rejected').length;
      const durationMs = Date.now() - startTime;

      this.logger.log({
        message: 'Cleanup callbacks completed',
        succeeded,
        failed,
        durationMs,
      });
    }
  }

  /**
   * Called after all connections are closed.
   * This is the final cleanup phase.
   *
   * @param signal The termination signal (e.g., 'SIGTERM', 'SIGINT')
   */
  async onApplicationShutdown(signal?: string): Promise<void> {
    this.logger.log({
      message: 'Application shutdown complete',
      phase: 'onApplicationShutdown',
      signal: signal || 'none',
    });
  }

  /**
   * Check if the application is currently shutting down.
   * Use this to reject new requests during shutdown.
   */
  get isShuttingDown(): boolean {
    return this._isShuttingDown;
  }

  /**
   * Check if the application is ready to accept traffic.
   * Used by health checks and Kubernetes readiness probes.
   */
  get isReady(): boolean {
    return this._isReady && !this._isShuttingDown;
  }

  /**
   * Register a cleanup callback to be executed during shutdown.
   * Callbacks are executed in parallel with individual timeouts.
   *
   * @param name Unique identifier for the callback (for logging)
   * @param callback Async function to execute during shutdown
   */
  registerCleanupCallback(name: string, callback: () => Promise<void>): void {
    this.cleanupCallbacks.set(name, callback);
    this.logger.debug({
      message: 'Registered cleanup callback',
      callbackName: name,
      totalCallbacks: this.cleanupCallbacks.size,
    });
  }

  /**
   * Unregister a cleanup callback.
   *
   * @param name Unique identifier for the callback
   */
  unregisterCleanupCallback(name: string): void {
    this.cleanupCallbacks.delete(name);
    this.logger.debug({
      message: 'Unregistered cleanup callback',
      callbackName: name,
      remainingCallbacks: this.cleanupCallbacks.size,
    });
  }

  /**
   * Execute a callback with a timeout.
   * If the callback takes longer than the timeout, it will be logged and skipped.
   */
  private async executeWithTimeout(callback: () => Promise<void>, name: string, timeoutMs: number): Promise<void> {
    const startTime = Date.now();

    return new Promise<void>((resolve) => {
      const timeoutId = setTimeout(() => {
        this.logger.warn({
          message: 'Cleanup callback timed out',
          callbackName: name,
          timeoutMs,
        });
        resolve();
      }, timeoutMs);

      callback()
        .then(() => {
          clearTimeout(timeoutId);
          const durationMs = Date.now() - startTime;
          this.logger.debug({
            message: 'Cleanup callback completed',
            callbackName: name,
            durationMs,
          });
          resolve();
        })
        .catch((error) => {
          clearTimeout(timeoutId);
          const durationMs = Date.now() - startTime;
          this.logger.error({
            message: 'Cleanup callback failed',
            callbackName: name,
            durationMs,
            error: error instanceof Error ? error.message : String(error),
          });
          resolve(); // Don't block shutdown on errors
        });
    });
  }

  /**
   * Helper to sleep for a given duration.
   */
  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}

/**
 * Interface for the GracefulShutdownService.
 * Use for dependency injection.
 */
export interface IGracefulShutdownService {
  readonly isShuttingDown: boolean;
  readonly isReady: boolean;
  registerCleanupCallback(name: string, callback: () => Promise<void>): void;
  unregisterCleanupCallback(name: string): void;
}

export const IGracefulShutdownService = Symbol('IGracefulShutdownService');
