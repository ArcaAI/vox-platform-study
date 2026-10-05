import { BadRequestException, Controller, Get, Inject, Param, ParseIntPipe, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiParam, ApiResponse, ApiTags } from '@nestjs/swagger';
import {
  ConsultationActivityPageResponse,
  ConsultationActivityQuery,
  EncounterRecapResponse,
  IConsultationHistoryServiceToken,
  type IConsultationHistoryService,
} from '@arcaai/applications';
import { Authorize, RequiredScopes, RequiredSvcScopes } from '../../decorators';
import { ConsultationAccessHelper } from '../consultation/consultation-access.helper';

const BUSINESS = { admin: false } as const;

/**
 * The business read plane over a consultation's history: the oldest-first activity feed without
 * runs or aggregates, and the live recap of one encounter (display-only).
 *
 * Access is the shared consultation read check (`ConsultationAccessHelper.assertRead`), exactly as
 * broad as `GET consultations/:id`: a consultation outside the caller's tenant is 404; inside it a
 * service account, the owning doctor, a caller whose CASL ability grants `read:Consultation`, or a
 * doctor sharing a patient while tenant sharing is on passes, anyone else is 403.
 */
@ApiBearerAuth()
@ApiTags('consultations')
@Authorize()
@Controller('consultations')
export class ConsultationHistoryController {
  constructor(
    @Inject(IConsultationHistoryServiceToken) private readonly history: IConsultationHistoryService,
    private readonly access: ConsultationAccessHelper,
  ) {}

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
    await this.access.assertRead(id);
    return (await this.history.getActivity(id, query, BUSINESS)) as ConsultationActivityPageResponse;
  }

  @Get(':id/encounters/:seq/recap')
  @RequiredScopes('consultation:session:read')
  @RequiredSvcScopes('svc:consultation:session:read')
  @ApiOperation({
    summary: 'Read the live recap of one encounter',
    description: 'Display-only: the recap the note composer was handed for that encounter. Audited.',
  })
  @ApiParam({ name: 'id', description: 'Consultation ID' })
  @ApiParam({ name: 'seq', description: 'Encounter sequence', type: Number })
  @ApiResponse({ status: 200, type: EncounterRecapResponse })
  @ApiResponse({ status: 400, description: 'Invalid encounter sequence.' })
  @ApiResponse({ status: 403, description: 'The caller may not read this consultation.' })
  @ApiResponse({ status: 404, description: 'Unknown or cross-tenant consultation, or no recap for that encounter.' })
  async getRecap(@Param('id') id: string, @Param('seq', ParseIntPipe) seq: number): Promise<EncounterRecapResponse> {
    if (!Number.isInteger(seq) || seq < 1) throw new BadRequestException('seq must be a positive integer');
    await this.access.assertRead(id);
    return (await this.history.getRecap(id, seq, BUSINESS)) as EncounterRecapResponse;
  }
}
