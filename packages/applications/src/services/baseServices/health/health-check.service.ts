import { Injectable, Logger, OnModuleInit, Inject } from '@nestjs/common';
import {
    HealthCheckService as TerminusHealthCheckService,
    HealthIndicatorResult,
    HealthCheckResult,
    HealthCheck,
    HttpHealthIndicator,
    DiskHealthIndicator,
    MemoryHealthIndicator,
} from '@nestjs/terminus';
import { IAppSettingsService } from '../_meta/appSettings';
import { IHealthCheckService } from './IHealthCheckService';

@Injectable()
export class HealthCheckService implements IHealthCheckService, OnModuleInit {
    private readonly logger = new Logger(HealthCheckService.name);
    private customHealthIndicators: Map<string, () => Promise<HealthIndicatorResult>> = new Map();

    constructor(
        private readonly terminusHealthService: TerminusHealthCheckService,
        private readonly httpHealthIndicator: HttpHealthIndicator,
        private readonly diskHealthIndicator: DiskHealthIndicator,
        private readonly memoryHealthIndicator: MemoryHealthIndicator,
        @Inject(IAppSettingsService) private readonly appSettingsService: IAppSettingsService,
    ) {
        this.logger.log({
            message: 'Service created',
            service: HealthCheckService.name,
        });
    }

    async onModuleInit() {
        // Register default health indicators if available in app settings
        const healthCheckEndpoints = this.appSettingsService.getValueWithDefault('healthCheck.endpoints', {});

        // Register configured API endpoints for health checks
        Object.entries(healthCheckEndpoints).forEach(([name, url]) => {
            this.registerHealthIndicator(name, async () => {
                return this.httpHealthIndicator.pingCheck(name, url as string);
            });
        });

        this.logger.log({
            message: 'Service initialized',
            service: HealthCheckService.name,
            endpointCount: Object.keys(healthCheckEndpoints).length,
        });
    }

    @HealthCheck()
    async checkHealth(): Promise<HealthCheckResult> {
        try {
            // Create an array of indicator functions
            const indicators: (() => Promise<HealthIndicatorResult>)[] = [];

            // Get thresholds from app settings
            // Disk threshold is stored as percentage (e.g., 80 for 80%) but needs to be converted to decimal (0.8)
            // This can be configured via app settings with key 'healthCheck.diskThreshold' (default: 100%)
            const diskThresholdPercent = this.appSettingsService.getValueWithDefault('healthCheck.diskThreshold', 100);
            const diskThreshold = diskThresholdPercent / 100; // Convert percentage to decimal (100 -> 1)
            // Memory threshold is in bytes (default: 512MB = 512 * 1024 * 1024 bytes)
            // This can be configured via app settings with key 'healthCheck.memoryThreshold'
            const memoryThreshold = this.appSettingsService.getValueWithDefault('healthCheck.memoryThreshold', 512 * 1024 * 1024); // 512MB in bytes

            this.logger.debug({
                message: 'Health check thresholds',
                diskThresholdPercent,
                diskThreshold,
                memoryThresholdMB: Math.round(memoryThreshold / 1024 / 1024),
            });

            // Add disk health check
            indicators.push(() =>
                this.diskHealthIndicator.checkStorage('storage', {
                    path: '/',
                    thresholdPercent: diskThreshold,
                }),
            );

            // Add memory health check
            indicators.push(() =>
                this.memoryHealthIndicator.checkHeap('memory_heap', memoryThreshold),
            );

            // Add RSS memory check
            indicators.push(() =>
                this.memoryHealthIndicator.checkRSS('memory_rss', memoryThreshold),
            );

            // Add all custom health indicators
            Array.from(this.customHealthIndicators.entries()).forEach(([name, check]) => {
                indicators.push(check);
            });

            this.logger.debug({
                message: 'Executing health indicators',
                indicatorCount: indicators.length,
            });

            // Execute all health checks
            return this.terminusHealthService.check(indicators);
        } catch (error) {
            this.logger.error({
                message: 'Failed to perform health check',
                error: error instanceof Error ? error.message : String(error),
            });
            throw error;
        }
    }

    registerHealthIndicator(name: string, check: () => Promise<HealthIndicatorResult>): void {
        try {
            this.customHealthIndicators.set(name, check);
            this.logger.log({
                message: 'Registered health indicator',
                indicatorName: name,
            });
        } catch (error) {
            this.logger.error({
                message: 'Failed to register health indicator',
                indicatorName: name,
                error: error instanceof Error ? error.message : String(error),
            });
            throw error;
        }
    }

    async checkSubsystem(name: string): Promise<HealthIndicatorResult> {
        try {
            const check = this.customHealthIndicators.get(name);
            if (!check) {
                throw new Error(`Health indicator not found: ${name}`);
            }
            return check();
        } catch (error) {
            this.logger.error({
                message: 'Failed to check subsystem',
                subsystemName: name,
                error: error instanceof Error ? error.message : String(error),
            });
            throw error;
        }
    }
}
