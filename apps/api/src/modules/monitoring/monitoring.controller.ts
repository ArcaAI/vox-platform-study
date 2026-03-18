import { Controller, Get, Inject, Logger, NotFoundException, Param } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiParam, ApiResponse, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { Authorize } from '../../decorators';
import { IServiceHealthMonitoringService } from '@arcaai/applications';
import { HeartbeatRecord, ServiceUptime, SessionsResponse, UptimeResponse } from './dto';

@ApiTags('monitoring')
@ApiBearerAuth()
@Authorize()
@Throttle({ default: { limit: 300, ttl: 60000 } })
@Controller('monitoring')
export class MonitoringController {
    private readonly logger = new Logger(MonitoringController.name);

    constructor(
        @Inject(IServiceHealthMonitoringService)
        private readonly monitoringService: IServiceHealthMonitoringService,
    ) {}

    @Get('uptime')
    @ApiOperation({ summary: 'Get uptime data for all services' })
    @ApiResponse({ status: 200, description: 'Uptime data for all services', type: UptimeResponse })
    async getUptime(): Promise<UptimeResponse> {
        this.logger.debug({
            message: 'Request received',
            endpoint: 'uptime',
        });
        return this.monitoringService.getUptime();
    }

    @Get('uptime/:service')
    @ApiOperation({ summary: 'Get uptime data for a specific service' })
    @ApiParam({ name: 'service', enum: ['stt', 'tts', 'smr', 'text'], description: 'Service name' })
    @ApiResponse({ status: 200, description: 'Uptime data for the service', type: ServiceUptime })
    @ApiResponse({ status: 404, description: 'Service not found' })
    async getServiceUptime(@Param('service') service: string): Promise<ServiceUptime> {
        this.logger.debug({
            message: 'Request received',
            endpoint: 'uptime',
            service,
        });
        const result = await this.monitoringService.getServiceUptime(service);

        if (!result) {
            throw new NotFoundException(`Service '${service}' not found`);
        }

        return result;
    }

    @Get('heartbeats/:service')
    @ApiOperation({ summary: 'Get heartbeat history for a service' })
    @ApiParam({ name: 'service', enum: ['stt', 'tts', 'smr', 'text'], description: 'Service name' })
    @ApiResponse({ status: 200, description: 'Heartbeat history', type: [HeartbeatRecord] })
    async getHeartbeats(@Param('service') service: string): Promise<HeartbeatRecord[]> {
        this.logger.debug({
            message: 'Request received',
            endpoint: 'heartbeats',
            service,
        });
        return this.monitoringService.getHeartbeatHistory(service);
    }

    @Get('sessions')
    @ApiOperation({ summary: 'Get active session counts per service' })
    @ApiResponse({ status: 200, description: 'Session counts per service', type: SessionsResponse })
    async getSessions(): Promise<SessionsResponse> {
        this.logger.debug({
            message: 'Request received',
            endpoint: 'sessions',
        });
        return this.monitoringService.getSessionCounts();
    }
}
