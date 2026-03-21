import { HealthCheckResult, HealthIndicatorResult } from '@nestjs/terminus';

/**
 * Interface for health check service that provides system health status
 */
export interface IHealthCheckService {
  /**
   * Get overall system health including all registered health indicators
   * @returns Complete health check result with status of all components
   */
  checkHealth(): Promise<HealthCheckResult>;

  /**
   * Register a custom health check indicator
   * @param name Unique name for the health indicator
   * @param check Function that returns health indicator result
   */
  registerHealthIndicator(
    name: string,
    check: () => Promise<HealthIndicatorResult>
  ): void;

  /**
   * Check health of a specific subsystem
   * @param name Name of the subsystem to check
   * @returns Health status of the specific subsystem
   */
  checkSubsystem(name: string): Promise<HealthIndicatorResult>;
}

export const IHealthCheckService = Symbol('IHealthCheckService');