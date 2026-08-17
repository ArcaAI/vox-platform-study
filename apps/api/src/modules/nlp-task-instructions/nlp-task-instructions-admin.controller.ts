import {
  IActiveUserContext,
  ITenantNlpTaskInstructionsService,
  TenantNlpTaskInstructionsResponse,
  TENANT_NLP_INSTRUCTION_TASK_KEYS,
  UpsertTenantNlpTaskInstructionsRequest,
} from '@arcaai/applications';
import { BadRequestException, Body, Controller, Get, Inject, Put, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiHeader, ApiOperation, ApiQuery, ApiResponse, ApiTags } from '@nestjs/swagger';
import { ClsService } from 'nestjs-cls';
import { CanManage, CanRead, ExpectedVersion, RequiresIfMatch, RequiredScopes } from '../../decorators';
import { resolveScopedTenantId } from '../../shared/tenant-scope';

/**
 * NlpTaskInstructionsAdminController — the admin surface for per-tenant
 * `nlp.topic` / `nlp.intent` INSTRUCTION content (topic list / intent list),
 * mounted at `/admin/nlp-task-instructions` (global prefix →
 * `/api/v1/admin/nlp-task-instructions`). Mirrors `AiTaskDefaultAdminController`'s
 * row GET/PUT shape, but deliberately WITHOUT its `getEffective`/`getOptions`
 * routes and super-admin-only write lock — this is a plain tenant-writable
 * resource (a SEPARATE subject, `TenantNlpTaskInstructions`, from
 * `AiTaskDefault`; see `01-policy.ts`'s tenant-full-access grant).
 *
 * Model/provider SELECTION for `nlp.topic`/`nlp.intent` is untouched — it
 * still resolves through `/admin/ai-task-defaults` under the existing
 * `nlp.*` super-admin-only lock. This controller carries ONLY instruction
 * content (never a modelSlug).
 *
 *  - `GET 'row'?taskKey=`  → ONE raw, editable row (`version` drives the OCC
 *    token; a `version:0` placeholder when none exists yet).
 *  - `PUT 'row'?taskKey=`  → create (`expectedVersion` 0) or CAS-update under
 *    `If-Match` (drift → 412, missing → 428).
 */
@ApiBearerAuth()
@ApiTags('admin-nlp-task-instructions')
@RequiredScopes('admin:nlp-task-instructions:manage')
@Controller('admin/nlp-task-instructions')
export class NlpTaskInstructionsAdminController {
  constructor(
    @Inject(ITenantNlpTaskInstructionsService) private readonly instructionsService: ITenantNlpTaskInstructionsService,
    private readonly cls: ClsService<IActiveUserContext>,
  ) {}

  @Get('row')
  @CanRead('TenantNlpTaskInstructions')
  @ApiOperation({
    summary: 'Get the raw, editable TenantNlpTaskInstructions row for a (tenant, taskKey)',
    description:
      'Returns the tenant row, or a `version:0` placeholder when none exists yet. The `version` drives the `If-Match` ' +
      'OCC token for the matching `PUT` (create with `expectedVersion: 0`; the global ETagInterceptor stamps `ETag` from it).',
  })
  @ApiQuery({ name: 'taskKey', required: true, enum: [...TENANT_NLP_INSTRUCTION_TASK_KEYS] })
  @ApiQuery({ name: 'tenantId', required: false, description: 'Platform-admin only: target tenant.' })
  @ApiResponse({ status: 200, type: TenantNlpTaskInstructionsResponse })
  @ApiResponse({ status: 400, description: 'Unknown or missing taskKey.' })
  async getRow(@Query('taskKey') taskKey: string, @Query('tenantId') tenantId?: string): Promise<TenantNlpTaskInstructionsResponse> {
    this.assertKnownTaskKey(taskKey);
    return this.instructionsService.getRow(taskKey, this.resolveTenantId(tenantId));
  }

  @Put('row')
  @CanManage('TenantNlpTaskInstructions')
  @RequiresIfMatch()
  @ApiOperation({
    summary: 'Create or update the (tenant, taskKey) instructions row under optimistic concurrency',
    description:
      '`instructionsJson` is the tenant-authored topic list / intent list (string[]) — never a model selection field. ' +
      '`If-Match` (RFC 7232) carries the version read from the prior GET — `"0"` creates the row, an existing version ' +
      'CASes against `_version` (drift → 412, missing → 428).',
  })
  @ApiQuery({ name: 'taskKey', required: true, enum: [...TENANT_NLP_INSTRUCTION_TASK_KEYS] })
  @ApiQuery({ name: 'tenantId', required: false, description: 'Platform-admin only: target tenant.' })
  @ApiHeader({
    name: 'If-Match',
    description: 'RFC 7232 strong validator carrying the version the client read (e.g. `"0"` to create).',
    required: true,
    example: '"0"',
  })
  @ApiResponse({ status: 200, type: TenantNlpTaskInstructionsResponse })
  @ApiResponse({ status: 400, description: 'Unknown task key.' })
  @ApiResponse({ status: 412, description: 'Optimistic concurrency conflict — re-fetch and retry with the new version.' })
  @ApiResponse({ status: 428, description: 'If-Match header is required for this operation.' })
  async upsertRow(
    @Body() request: UpsertTenantNlpTaskInstructionsRequest,
    @ExpectedVersion() expectedFromHeader: number | undefined,
    @Query('taskKey') taskKey: string,
    @Query('tenantId') tenantId?: string,
  ): Promise<TenantNlpTaskInstructionsResponse> {
    this.assertKnownTaskKey(taskKey);
    const dto = { ...request, expectedVersion: expectedFromHeader ?? request.expectedVersion };
    return this.instructionsService.upsertRow(taskKey, dto, this.resolveTenantId(tenantId));
  }

  /** 400 for anything outside the fixed task-key registry (defense before the service re-checks). */
  private assertKnownTaskKey(taskKey: string | undefined): void {
    if (!taskKey || !(TENANT_NLP_INSTRUCTION_TASK_KEYS as readonly string[]).includes(taskKey)) {
      throw new BadRequestException(`Unknown taskKey '${taskKey ?? ''}'. Valid task keys: ${TENANT_NLP_INSTRUCTION_TASK_KEYS.join(', ')}`);
    }
  }

  /** Tenant admins → own tenant; super admins → `?tenantId=` (or CLS working tenant). */
  private resolveTenantId(queryTenantId?: string): string {
    return resolveScopedTenantId(this.cls.get('user'), this.cls.get('tenantId'), queryTenantId);
  }
}
