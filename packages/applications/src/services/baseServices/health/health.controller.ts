import { Controller, Get, Inject } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse } from '@nestjs/swagger';
import { HealthCheckResult } from '@nestjs/terminus';
import { IHealthCheckService } from './';

@ApiTags('health')
@Controller('health')
export class HealthController {
  constructor(
    @Inject(IHealthCheckService) private readonly healthCheckService: IHealthCheckService
  ) {}

  @Get()
  @ApiOperation({ summary: 'Get overall system health' })
  @ApiResponse({ status: 200, description: 'System health information' })
  @ApiResponse({ status: 503, description: 'Service unavailable - health check failed' })
  async check(): Promise<HealthCheckResult> {
    return this.healthCheckService.checkHealth();
  }

  @Get('/liveness')
  @ApiOperation({ summary: 'Check if the service is alive' })
  @ApiResponse({ status: 200, description: 'Service is alive' })
  async liveness(): Promise<{ status: string }> {
    // Simple liveness check - if this endpoint responds, the service is alive
    return { status: 'ok' };
  }

  @Get('/readiness')
  @ApiOperation({ summary: 'Check if the service is ready to accept requests' })
  @ApiResponse({ status: 200, description: 'Service is ready' })
  @ApiResponse({ status: 503, description: 'Service not ready' })
  async readiness(): Promise<HealthCheckResult> {
    // Readiness check - if health check passes, the service is ready
    return this.healthCheckService.checkHealth();
  }
}