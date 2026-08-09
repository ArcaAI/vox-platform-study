import { AttachDigestRequest, IServiceReleaseService, RegisterInstanceRequest, ServiceReleaseResponse } from '@arcaai/applications';
import { Body, Controller, Inject, Post, UseGuards } from '@nestjs/common';
import { ApiExcludeController, ApiSecurity } from '@nestjs/swagger';
import { Public } from '../../decorators';
import { ServiceReleaseTokenGuard } from './service-release-token.guard';

/**
 * ServiceReleaseInternalController.
 *
 * Service-to-service self-registration + heartbeat (TASK-648 W8, U8 → U6).
 * `@Public()` only exempts these routes from the user-JWT/permission chain
 * (and the boot-time deny-by-default route-permission audit); they are
 * authenticated by the class-level `ServiceReleaseTokenGuard` instead. Never
 * reachable from a browser — excluded from public Swagger.
 */
@ApiExcludeController()
@Public()
@UseGuards(ServiceReleaseTokenGuard)
@ApiSecurity('serviceToken')
@Controller('internal/service-releases')
export class ServiceReleaseInternalController {
  constructor(
    @Inject(IServiceReleaseService)
    private readonly serviceReleaseService: IServiceReleaseService,
  ) {}

  @Post()
  async register(@Body() dto: RegisterInstanceRequest): Promise<ServiceReleaseResponse> {
    return this.serviceReleaseService.registerInstance(dto);
  }

  @Post('digest')
  async attachDigest(@Body() dto: AttachDigestRequest): Promise<ServiceReleaseResponse> {
    return this.serviceReleaseService.attachDigest(dto);
  }
}
