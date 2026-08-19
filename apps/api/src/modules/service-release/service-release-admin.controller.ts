import {
  CurrentServiceResponse,
  IServiceReleaseService,
  ListReleasesQuery,
  PaginatedServiceReleaseResponse,
  ServiceReleaseResponse,
} from '@arcaai/applications';
import { Controller, Get, Inject, Param, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiParam, ApiQuery, ApiResponse, ApiTags } from '@nestjs/swagger';
import { CanAny, ForbidApiKey, RequiredSvcScopes } from '../../decorators';

/**
 * ServiceReleaseAdminController.
 *
 * Read side of the Service Version & Release Registry. Same
 * admin posture as the existing `/health/services` route: either a global
 * admin (`manage all`) or a tenant admin holding `read:TenantTelemetry`. A
 * plain doctor holds neither and is rejected. Branch/SHA/CI detail is
 * operator data — never exposed on the `@Public()` `/health` endpoint, only
 * here.
 */
@ApiBearerAuth()
@ApiTags('admin-service-releases')
@ForbidApiKey()
@RequiredSvcScopes('svc:admin:service-release:manage')
@Controller('admin/service-releases')
@CanAny(['manage', 'all'], ['read', 'TenantTelemetry'])
export class ServiceReleaseAdminController {
  constructor(
    @Inject(IServiceReleaseService)
    private readonly serviceReleaseService: IServiceReleaseService,
  ) {}

  @Get()
  @ApiOperation({ summary: 'Release history across all services, newest build first' })
  @ApiQuery({ name: 'serviceName', required: false, type: String })
  @ApiQuery({ name: 'environment', required: false, enum: ['dev', 'staging', 'prod'] })
  @ApiQuery({ name: 'page', required: false, type: Number })
  @ApiQuery({ name: 'limit', required: false, type: Number })
  @ApiResponse({ status: 200, description: 'Paginated releases, newest build first', type: PaginatedServiceReleaseResponse })
  async list(@Query() query: ListReleasesQuery): Promise<PaginatedServiceReleaseResponse> {
    return this.serviceReleaseService.listReleases(query);
  }

  // Registered ahead of `:serviceName/history` — Nest matches static
  // segments (`current`) before dynamic ones declared on the same
  // controller only when the static route is registered first.
  @Get('current')
  @ApiOperation({ summary: 'What is running right now, one row per service' })
  @ApiQuery({ name: 'environment', required: true, enum: ['dev', 'staging', 'prod'] })
  @ApiResponse({ status: 200, description: 'Current release per service', type: [CurrentServiceResponse] })
  async current(@Query('environment') environment: string): Promise<CurrentServiceResponse[]> {
    return this.serviceReleaseService.listCurrent(environment);
  }

  @Get(':serviceName/history')
  @ApiOperation({ summary: 'Release timeline for one service, newest first' })
  @ApiParam({ name: 'serviceName', type: String })
  @ApiResponse({ status: 200, description: 'Release timeline for one service, newest first', type: [ServiceReleaseResponse] })
  @ApiResponse({ status: 404, description: 'Unknown service' })
  async history(@Param('serviceName') serviceName: string): Promise<ServiceReleaseResponse[]> {
    return this.serviceReleaseService.getHistory(serviceName);
  }
}
