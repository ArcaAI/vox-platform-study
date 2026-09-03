import { IActiveUserContext, IProviderConnectionService } from '@arcaai/applications';
import type { ResolvedProviderCredential } from '@arcaai/applications';
import { Controller, Get, Inject, Optional, Query, UseGuards } from '@nestjs/common';
import { ApiExcludeController, ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';
import { ClsService } from 'nestjs-cls';
import { Public } from '../../decorators';
import { InternalServiceTokenGuard } from './internal-service-token.guard';
import { resolveModelRegistryCredential } from './model-registry-credential.util';

/**
 * ModelRegistryInternalController — lane L3 follow-on.
 *
 * The GENERIC route every backend service resolves an `AiProviderConnection`
 * `service='model-registry'` credential through (the HuggingFace token / S3
 * key pair a `s3://`-sourced `AiModel` download needs). `apps/stt` already
 * had a private route to this exact resolution
 * (`SttInternalController.getModelRegistryCredential`,
 * `/internal/stt/model-registry-credential`) — this is that same
 * resolution, exposed generically for `apps/nlp`, `apps/tts`, and (latently)
 * `apps/harness`, none of which had any route to it at all.
 *
 * GUARD CHOICE — deliberately NOT the STT route's mechanism, even though it
 * looks like the obvious thing to mirror:
 *
 * `SttInternalController` sits on the API-key auth surface via a reserved
 * `@RequiredScopes('internal:stt:worker')` scope — a narrow, POLICED
 * exemption from the platform's "`/internal/*` is guard-only, never API-key"
 * rule (`apps/api/src/bootstrap/api-key-scope-audit.ts`,
 * `auditInternalRoutesOffApiKeySurface`), justified ONLY by BUG-013 (the STT
 * worker historically presents an API key, not a service token).
 * `RESERVED_INTERNAL_SCOPE_CONTROLLERS` is explicitly "FROZEN AT ONE MEMBER"
 * by owner decision ( gate G2, D-3) and pinned by
 * `api-key-scope-audit.test.ts` — adding a second controller to it is a
 * deliberate, reviewed change, not something a new route should trigger as a
 * side effect.
 *
 * It is also unnecessary here: `apps/nlp`, `apps/tts` and `apps/harness`
 * don't hold an API key at all today — they already reach `/internal/*` with
 * `X-Service-Token`, validated by `InternalServiceTokenGuard`
 * (`NLP_SERVICE_TOKEN` / `TTS_SERVICE_TOKEN` / `HARNESS_SERVICE_TOKEN`, all
 * already registered in its `SERVICE_SECRETS` map — the exact mechanism
 * `EffectiveConfigController` already uses for this same family of routes).
 * `stt` is in that map too (`API_GATEWAY_KEY`, accepting the worker's
 * existing `X-Internal-Service-Key` header), so this route needs no new
 * credential type for anyone, including STT.
 *
 * Consequence worth stating explicitly: this route's `route-manifest.json`
 * entry reads `isPublic: true` (it carries `@Public()`), NOT `isPublic: false`
 * like the STT route. That is the `@Public()` + dedicated-guard pattern
 * `auditInternalRoutesOffApiKeySurface`'s own doc comment describes as
 * equally secure — `isPublic` in this manifest means "off the standard
 * user-auth path", not "unauthenticated". See the ticket report for the full
 * reasoning; flagging here so nobody "fixes" this into a false match against
 * the STT route later.
 */
@ApiTags('internal-model-registry')
@ApiExcludeController()
@Public()
@UseGuards(InternalServiceTokenGuard)
@Controller('internal')
export class ModelRegistryInternalController {
  constructor(
    @Optional() @Inject(IProviderConnectionService) private readonly providerConnections?: IProviderConnectionService,
    @Optional() private readonly cls?: ClsService<IActiveUserContext>,
  ) {}

  /**
   * `?service=` is consumed by `InternalServiceTokenGuard` itself (it reads
   * the raw query off the request), not by this handler — every other
   * `InternalServiceTokenGuard`-gated route in this module follows the same
   * split (see `EffectiveConfigController`).
   */
  @Get('model-registry-credential')
  @ApiOperation({ summary: "Resolve one model-registry credential (tenant → SYSTEM) for any backend service's s3:// weight fetcher" })
  @ApiQuery({ name: 'service', required: true, description: 'Caller identity for InternalServiceTokenGuard (nlp | tts | harness | stt | ...).' })
  @ApiQuery({ name: 'provider', required: true, description: "The AiProviderConnection provider id, e.g. 's3'." })
  @ApiQuery({ name: 'tenantId', required: true, description: "The owning AiModel row's tenantId — SYSTEM for a platform model." })
  async getModelRegistryCredential(@Query('provider') provider?: string, @Query('tenantId') tenantId?: string): Promise<ResolvedProviderCredential> {
    return resolveModelRegistryCredential(this.providerConnections, this.cls, provider, tenantId);
  }
}
