import { Controller, ForbiddenException, Get, Inject, NotFoundException, Param, ParseIntPipe, BadRequestException, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiParam, ApiResponse, ApiTags } from '@nestjs/swagger';
import { ClsService } from 'nestjs-cls';
import {
  ConsultationActivityPageResponse,
  ConsultationActivityQuery,
  EncounterRecapResponse,
  IConsultationHistoryServiceToken,
  IConsultationService,
  PolicyEngine,
  type AppAbility,
  type IConsultationHistoryService,
} from '@arcaai/applications';
import { Authorize, RequiredScopes, RequiredSvcScopes } from '../../decorators';

const BUSINESS = { admin: false } as const;

/**
 * The business read plane over a consultation's history: the oldest-first activity feed without
 * runs or aggregates, and the live recap of one encounter (display-only).
 *
 * Access follows the consultation read posture: a consultation outside the caller's tenant is 404;
 * inside it the owning doctor, a service account, or a caller whose CASL ability grants
 * `read:Consultation` on the consultation passes, anyone else is 403.
 */
@ApiBearerAuth()
@ApiTags('consultations')
@Authorize()
@Controller('consultations')
export class ConsultationHistoryController {
  constructor(
    @Inject(IConsultationHistoryServiceToken) private readonly history: IConsultationHistoryService,
    @Inject(IConsultationService) private readonly consultations: IConsultationService,
    private readonly cls: ClsService,
    private readonly policyEngine: PolicyEngine,
  ) {}

  private async verifyAccess(consultationId: string): Promise<void> {
    const consultation = await this.consultations.getById(consultationId);
    if (!consultation) throw new NotFoundException(`Consultation ${consultationId} not found`);

    const principal = this.cls.get('serviceAccount') as { id?: string } | undefined;
    if (typeof principal?.id === 'string') return;

    const user = this.cls.get('user') as { id?: string } | undefined;
    if (user?.id && consultation.doctorId === user.id) return;

    const ability = this.cls.get('userAbility') as AppAbility | undefined;
    if (ability && this.policyEngine.can(ability, 'read', 'Consultation', { tenantId: this.cls.get('tenantId'), doctorId: consultation.doctorId } as Record<string, unknown>)) {
      return;
    }
    throw new ForbiddenException('You do not have access to this consultation');
  }

  @Get(':id/history')
  @RequiredScopes('consultation:session:read')
  @RequiredSvcScopes('svc:consultation:session:read')
  @ApiOperation({
    summary: 'Read a consultation`s history',
    description:
      'The consultation`s items, feedback and lifecycle moments as one oldest-first, keyset-paged series — the activity feed without runs or aggregates. Audited.',
  })
  @ApiParam({ name: 'id', description: 'Consultation ID' })
  @ApiResponse({ status: 200, type: ConsultationActivityPageResponse })
  @ApiResponse({ status: 400, description: 'Invalid query or cursor.' })
  @ApiResponse({ status: 403, description: 'The caller may not read this consultation.' })
  @ApiResponse({ status: 404, description: 'Unknown or cross-tenant consultation id.' })
  async getHistory(@Param('id') id: string, @Query() query: ConsultationActivityQuery): Promise<ConsultationActivityPageResponse> {
    await this.verifyAccess(id);
    return (await this.history.getActivity(id, query, BUSINESS)) as ConsultationActivityPageResponse;
  }

  @Get(':id/encounters/:seq/recap')
  @RequiredScopes('consultation:session:read')
  @RequiredSvcScopes('svc:consultation:session:read')
  @ApiOperation({ summary: 'Read the live recap of one encounter', description: 'Display-only: the recap the note composer was handed for that encounter. Audited.' })
  @ApiParam({ name: 'id', description: 'Consultation ID' })
  @ApiParam({ name: 'seq', description: 'Encounter sequence', type: Number })
  @ApiResponse({ status: 200, type: EncounterRecapResponse })
  @ApiResponse({ status: 400, description: 'Invalid encounter sequence.' })
  @ApiResponse({ status: 403, description: 'The caller may not read this consultation.' })
  @ApiResponse({ status: 404, description: 'Unknown or cross-tenant consultation, or no recap for that encounter.' })
  async getRecap(@Param('id') id: string, @Param('seq', ParseIntPipe) seq: number): Promise<EncounterRecapResponse> {
    if (!Number.isInteger(seq) || seq < 1) throw new BadRequestException('seq must be a positive integer');
    await this.verifyAccess(id);
    return (await this.history.getRecap(id, seq, BUSINESS)) as EncounterRecapResponse;
  }
}
