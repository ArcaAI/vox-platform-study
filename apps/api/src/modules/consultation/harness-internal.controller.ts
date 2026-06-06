import {
  HarnessAssembleRequest,
  HarnessDraftRequest,
  HarnessGateDecisionRequest,
  HarnessInternalService,
  HarnessPersistEntitiesRequest,
} from '@arcaai/applications';
import { Body, Controller, Param, Post, UseGuards } from '@nestjs/common';
import { ApiExcludeController, ApiOperation, ApiParam } from '@nestjs/swagger';
import { Public } from '../../decorators';
import { HarnessServiceTokenGuard } from './harness-service-token.guard';

/**
 * HarnessInternalController (TASK-330 Phase 1 — Lane G).
 *
 * The inbound half of the apps/api <-> apps/harness gate adapter. Service-to-service
 * only (guarded by HarnessServiceTokenGuard / `X-Service-Token`), so it is excluded
 * from public Swagger. With the global `api/v1` prefix the effective paths are
 * `/api/v1/internal/harness/consultations/:id/{entities,assemble,draft,gate-decision}`.
 *
 * The harness calls these out-of-band of the API edge ClsModule middleware, so each
 * request carries `tenantId` in the body and the service re-establishes CLS from it.
 *
 * `@Public()` exempts these routes from the user-JWT/permission auth chain (and the
 * boot-time route-permission audit): they are authenticated service-to-service by the
 * class-level `HarnessServiceTokenGuard`, NOT by an end-user token. `@Public()` only
 * sets the skip-auth label — it does not disable the explicitly-applied token guard.
 */
@ApiExcludeController()
@Public()
@UseGuards(HarnessServiceTokenGuard)
@Controller('internal/harness')
export class HarnessInternalController {
  constructor(private readonly harnessInternalService: HarnessInternalService) {}

  @Post('consultations/:id/entities')
  @ApiOperation({ summary: 'Persist NamedEntity rows extracted by the harness NLP step' })
  @ApiParam({ name: 'id', description: 'Consultation ID' })
  async persistEntities(@Param('id') id: string, @Body() dto: HarnessPersistEntitiesRequest) {
    return this.harnessInternalService.persistEntities(id, dto);
  }

  @Post('consultations/:id/assemble')
  @ApiOperation({ summary: 'Resolve prompt tier + assemble the SMR payload (NER-injected, SOAP responseFormat)' })
  @ApiParam({ name: 'id', description: 'Consultation ID' })
  async assemble(@Param('id') id: string, @Body() dto: HarnessAssembleRequest) {
    return this.harnessInternalService.assemble(id, dto);
  }

  @Post('consultations/:id/draft')
  @ApiOperation({ summary: 'Persist the generated draft (ContextItem + SummaryMeta + PENDING_REVIEW + WORM audit)' })
  @ApiParam({ name: 'id', description: 'Consultation ID' })
  async persistDraft(@Param('id') id: string, @Body() dto: HarnessDraftRequest) {
    return this.harnessInternalService.persistDraft(id, dto);
  }

  @Post('consultations/:id/gate-decision')
  @ApiOperation({ summary: 'Record the clinician GATE_DECISION (append-only WORM audit) after sign-off' })
  @ApiParam({ name: 'id', description: 'Consultation ID' })
  async recordGateDecision(@Param('id') id: string, @Body() dto: HarnessGateDecisionRequest) {
    return this.harnessInternalService.recordGateDecision(id, dto);
  }
}
