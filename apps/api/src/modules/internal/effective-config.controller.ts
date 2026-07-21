import { EffectiveConfigResponse, IEffectiveConfigService } from '@arcaai/applications';
import { ArgumentInvalidException } from '@arcaai/exceptions';
import { Controller, Get, Inject, Query, UseGuards } from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';
import { Public } from '../../decorators';
import { InternalServiceTokenGuard } from './internal-service-token.guard';

/**
 * EffectiveConfigController.
 *
 * The read side of the config plane: each Python service polls its own subset
 * (retention / concurrency / runtime profiles) instead of taking those values
 * from env. With the global `api/v1` prefix the effective path is
 * `/api/v1/internal/effective-config?service=<name>`.
 *
 * `@Public()` exempts this route from the user-JWT/permission auth chain (and the
 * boot-time route-permission audit): it is authenticated service-to-service by
 * the class-level `InternalServiceTokenGuard`, NOT by an end-user token.
 * `@Public()` only sets the skip-auth label — it does not disable the
 * explicitly-applied token guard. Same posture as `HarnessInternalController`.
 *
 * Service-to-service only, so it is excluded from public Swagger.
 */
@ApiExcludeController()
@Public()
@UseGuards(InternalServiceTokenGuard)
@Controller('internal/effective-config')
export class EffectiveConfigController {
  constructor(@Inject(IEffectiveConfigService) private readonly effectiveConfig: IEffectiveConfigService) {}

  /**
   * Resolve the calling service's config subset. Unknown service → 400 (the read
   * service throws `ArgumentInvalidException`).
   *
   * Values are service-level knobs ONLY — never per-request model selection, so
   * SMR's stateless-gateway contract is untouched.
   */
  @Get()
  async getEffectiveConfig(@Query('service') service: string): Promise<EffectiveConfigResponse> {
    if (!service) {
      throw new ArgumentInvalidException('Query parameter `service` is required.');
    }
    return this.effectiveConfig.resolveForService(service);
  }
}
