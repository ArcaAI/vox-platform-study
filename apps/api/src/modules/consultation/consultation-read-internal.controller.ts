import { IConsultationReadService } from '@arcaai/applications';
import type { ConsultationReadResult, IActiveUserContext } from '@arcaai/applications';
import { BadRequestException, Body, Controller, Headers, HttpCode, Inject, Param, Post, UseGuards } from '@nestjs/common';
import { ApiExcludeController, ApiOperation, ApiProperty, ApiResponse } from '@nestjs/swagger';
import { ArrayMaxSize, ArrayNotEmpty, IsArray, IsNotEmpty, IsString } from 'class-validator';
import { ClsService } from 'nestjs-cls';
import { Public } from '../../decorators';
import { HarnessServiceTokenGuard } from './harness-service-token.guard';

/** Body of `POST internal/consultations/:consultationId/read`. */
export class ConsultationReadRequestDto {
  @ApiProperty({ description: 'The workflow run reading (its workflow version declares the paths).' })
  @IsString()
  @IsNotEmpty()
  runId: string;

  @ApiProperty({ description: 'The node of that run whose declared reads these are.' })
  @IsString()
  @IsNotEmpty()
  nodeId: string;

  @ApiProperty({ type: [String], description: '`consultation.*` paths of the read schema, each declared by the node.' })
  @IsArray()
  @ArrayNotEmpty()
  @ArrayMaxSize(64)
  @IsString({ each: true })
  paths: string[];
}

/**
 * TASK-1036 §9.3 / TASK-1038 — the gateway half of the harness's `consultation.read` activity.
 *
 * Service-to-service only, like every `internal/harness/*` route: `@Public()` exempts it from the
 * user-JWT chain and the class-level `HarnessServiceTokenGuard` authenticates `X-Service-Token`.
 * `X-Tenant-Id` is MANDATORY (owner directive 2026-08-16) and the request runs in a CLS context
 * bound to it, so the tenant-scope extension and the audit row both see the tenant.
 *
 * Deliberately NOT behind `InternalTenantLockGuard`: it is a READ (POST only because the path list
 * is a body), and a node of a running workflow must not fail because a lock blocks writes.
 *
 * Excluded from public Swagger (internal plane). Effective path:
 * `/api/v1/internal/consultations/:consultationId/read`.
 */
@ApiExcludeController()
@Public()
@UseGuards(HarnessServiceTokenGuard)
@Controller('internal/consultations')
export class ConsultationReadInternalController {
  constructor(
    @Inject(IConsultationReadService) private readonly consultationReadService: IConsultationReadService,
    private readonly cls: ClsService<IActiveUserContext>,
  ) {}

  @Post(':consultationId/read')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Read the declared `consultation.*` paths of one run node',
    description:
      'Returns exactly the requested paths, each of which must exist in the consultation read schema (400 ' +
      '`CONSULTATION_READ_UNKNOWN_PATH`) and be declared by that node of the run`s workflow version (400 ' +
      '`CONSULTATION_READ_UNDECLARED`). An unknown or foreign run or consultation, or a run that is not this ' +
      'consultation`s, is 404. Every read is audited with its paths, never its values.',
  })
  @ApiResponse({ status: 200, description: '`{ values, readAt, schemaVersion }`' })
  @ApiResponse({ status: 400, description: 'Missing X-Tenant-Id, or an unknown / undeclared path.' })
  @ApiResponse({ status: 401, description: 'Missing or wrong X-Service-Token.' })
  @ApiResponse({ status: 404, description: 'Unknown or foreign run / consultation.' })
  async read(
    @Param('consultationId') consultationId: string,
    @Body() body: ConsultationReadRequestDto,
    @Headers('x-tenant-id') tenantIdHeader: string | undefined,
  ): Promise<ConsultationReadResult> {
    const tenantId = tenantIdHeader?.trim();
    if (!tenantId) throw new BadRequestException('`X-Tenant-Id` is required on an internal consultation read.');
    return this.cls.run(async () => {
      this.cls.set('tenantId', tenantId);
      return this.consultationReadService.read({ tenantId, consultationId, runId: body.runId, nodeId: body.nodeId, paths: body.paths });
    });
  }
}
