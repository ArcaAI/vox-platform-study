import { IActiveUserContext, IModelServingSpecService } from '@arcaai/applications';
import type { ResolvedServingSpec } from '@arcaai/applications';
import { BadRequestException, Controller, Get, Headers, Inject, Param, Query, UseGuards } from '@nestjs/common';
import { ApiExcludeEndpoint, ApiTags } from '@nestjs/swagger';
import { ClsService } from 'nestjs-cls';
import { Public } from '../../decorators';
import { InternalServiceTokenGuard } from './internal-service-token.guard';
import { InternalTenantLockGuard } from '../../guards/internal-tenant-lock.guard';

/**
 * ModelServingInternalController — `GET /internal/models/:slug/serving-spec` (TASK-1021 C-2),
 * `apps/vllm`'s entry into the engine-build contract (`ResolvedServingSpec`) for one model slug.
 *
 * Contract: `?service=vllm` (the guard's secret selector, and required by the handler — 400 for any
 * other name) + `X-Service-Token`, and `X-Tenant-Id`
 * is MANDATORY (owner directive 2026-08-16: every internal call carrying tenant-scoped work names
 * its tenant) — a missing header is 400, never a default tenant. The service reads the tenant's
 * own row first and the SYSTEM row only on absence; 404 `MODEL_NOT_FOUND` / 409
 * `MODEL_NOT_SERVABLE` come from it unchanged.
 *
 * `@Public()` exempts the route from the user-JWT chain (it is authenticated service-to-service by
 * the class-level guard); CLS is re-established pinned to the CALLER'S tenant, as the sibling
 * internal controllers do.
 */
/** The one deployable that reads serving specs (`InternalServiceTokenGuard`'s `?service=` name). */
const SERVING_SPEC_CALLER = 'vllm';

@ApiTags('internal-model-registry')
@Public()
@UseGuards(InternalServiceTokenGuard, InternalTenantLockGuard)
@Controller('internal/models')
export class ModelServingInternalController {
  constructor(
    @Inject(IModelServingSpecService) private readonly servingSpecs: IModelServingSpecService,
    private readonly cls: ClsService<IActiveUserContext>,
  ) {}

  // Internal decode-tier route: reachable only with an internal service token, so it is kept out
  // of the public reference. It is still mounted and still listed in the route manifest.
  @ApiExcludeEndpoint()
  @Get(':slug/serving-spec')
  async servingSpec(
    @Param('slug') slug: string,
    @Query('service') service: string | undefined,
    @Headers('x-tenant-id') tenantIdHeader: string | undefined,
  ): Promise<ResolvedServingSpec> {
    // The guard checks the token against the secret `?service=` names, and admits an UNKNOWN name
    // for any valid peer token. So the name itself is what binds this route to its one caller:
    // another peer (`nlp`, `stt`, …) presenting its own token must not read serving specs.
    if (service !== SERVING_SPEC_CALLER) {
      throw new BadRequestException(`\`?service=${SERVING_SPEC_CALLER}\` is required — serving specs are read by the vLLM inference service only.`);
    }
    const tenantId = tenantIdHeader?.trim();
    if (!tenantId) {
      throw new BadRequestException('`X-Tenant-Id` is required — a serving spec is always resolved for a tenant.');
    }
    return this.cls.run(async () => {
      this.cls.set('tenantId', tenantId);
      return this.servingSpecs.resolve(slug, tenantId);
    });
  }
}
