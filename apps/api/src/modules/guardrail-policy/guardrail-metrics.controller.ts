import {
  GuardrailActivityResponse,
  GuardrailMetricsEvaluationListQuery,
  GuardrailEvaluationListResponse,
  GuardrailHealthResponse,
  GuardrailMetricsWindowQuery,
  GuardrailPerformanceResponse,
  IGuardrailMonitoringService,
} from '@arcaai/applications';
import { Controller, Get, Inject, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { CanManage, CanRead, ForbidApiKey, RequiredSvcScopes } from '../../decorators';

const SCOPE = 'svc:admin:guardrail:manage';
const FORBIDDEN = 'Not a platform administrator, or a customer working tenant is selected (guardrail monitoring is platform-wide and tenant-less).';

/**
 * TASK-1050 W2h (README §11.3 E) — platform guardrail monitoring: activity from `GuardrailEvaluation`, performance
 * from fixed PromQL, health from residency and freshness, and a content-free drill-down. Cross-tenant by design.
 *
 * AUTH-NOTE: the class-level `@CanManage('AiModel')` UNDERSTATES the real gate. Every route is SUPER_ADMIN in a
 * tenant-less (or SYSTEM) context, enforced imperatively in `assertGuardrailPlatformAdmin`
 * (`GuardrailMonitoringService`) — tenant monitoring is out of scope (OD-36: tenants see consultation details
 * only). Row-INDEPENDENT, so it runs FIRST: every non-platform-admin gets the same 403, and there is no id space
 * to leak. `?tenantId=` narrows a platform admin's view; it never widens anyone else's.
 */
@ApiBearerAuth()
@ApiTags('admin-guardrail-availability')
@ForbidApiKey()
@Controller('admin/guardrail/metrics')
@CanManage('AiModel')
export class GuardrailMetricsController {
  constructor(@Inject(IGuardrailMonitoringService) private readonly service: IGuardrailMonitoringService) {}

  // AUTH-NOTE: platform-admin only, imperatively, row-independent — see the class note.
  @Get('activity')
  @CanRead('AiModel')
  @RequiredSvcScopes(SCOPE)
  @ApiOperation({
    summary: 'Guardrail activity across tenants',
    description:
      'From `GuardrailEvaluation` (one row per generation request × direction): decisions per bucket × direction, totals (warn / block / ' +
      'unverified / override counts and the flag rate), per-check verdict × action counts, top flagged categories, per-tenant and per-model ' +
      'breakdowns. Default window: the last 24 h in 1 h buckets; at most 31 days and 2,000 buckets. No content is read.',
  })
  @ApiResponse({ status: 200, type: GuardrailActivityResponse })
  @ApiResponse({ status: 400, description: '`GUARDRAIL_METRICS_WINDOW_INVALID` or `GUARDRAIL_METRICS_TOO_MANY_BUCKETS`.' })
  @ApiResponse({ status: 403, description: FORBIDDEN })
  async activity(@Query() query: GuardrailMetricsWindowQuery): Promise<GuardrailActivityResponse> {
    return this.service.activity(query);
  }

  // AUTH-NOTE: platform-admin only, imperatively — see the class note.
  @Get('performance')
  @CanRead('AiModel')
  @RequiredSvcScopes(SCOPE)
  @ApiOperation({
    summary: 'Guardrail performance (fixed PromQL)',
    description:
      'Screen-window and model latency p50/p95, judge and peer call rates, queue depth, admission rejections, circuit-breaker state, peer ' +
      'failures, window-cache hit ratio, `guardrail_evaluation_missing_total` and the evaluation outbox series. `available: false` when ' +
      'Prometheus answers nothing — never a 5xx.',
  })
  @ApiResponse({ status: 200, type: GuardrailPerformanceResponse })
  @ApiResponse({ status: 403, description: FORBIDDEN })
  async performance(): Promise<GuardrailPerformanceResponse> {
    return this.service.performance();
  }

  // AUTH-NOTE: platform-admin only, imperatively — see the class note.
  @Get('health')
  @CanRead('AiModel')
  @RequiredSvcScopes(SCOPE)
  @ApiOperation({
    summary: 'Guardrail health',
    description: 'Residency of the model each guardrail task key elects (read-only), the undetermined rate over the last hour, and the time since the last evaluation.',
  })
  @ApiResponse({ status: 200, type: GuardrailHealthResponse })
  @ApiResponse({ status: 403, description: FORBIDDEN })
  async health(): Promise<GuardrailHealthResponse> {
    return this.service.health();
  }

  // AUTH-NOTE: platform-admin only, imperatively — see the class note.
  @Get('evaluations')
  @CanRead('AiModel')
  @RequiredSvcScopes(SCOPE)
  @ApiOperation({
    summary: 'Guardrail evaluations (drill-down)',
    description:
      'Keyset-paged, newest first, filterable by tenant, decision, direction, check and consultation. Per-check results only — never the ' +
      'judged text; an outbound block reports `hasWithheldContent` and its output stays behind the admin review route.',
  })
  @ApiResponse({ status: 200, type: GuardrailEvaluationListResponse })
  @ApiResponse({ status: 400, description: '`GUARDRAIL_METRICS_WINDOW_INVALID`, `GUARDRAIL_METRICS_CURSOR_INVALID`, or an invalid filter.' })
  @ApiResponse({ status: 403, description: FORBIDDEN })
  async evaluations(@Query() query: GuardrailMetricsEvaluationListQuery): Promise<GuardrailEvaluationListResponse> {
    return this.service.evaluations(query);
  }
}
