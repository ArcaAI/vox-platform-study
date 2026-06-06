import { IPromptManagementService, PromptTemplateResponse } from '@arcaai/applications';
import { Controller, Get, Inject, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiQuery, ApiResponse, ApiTags } from '@nestjs/swagger';
import { Authorize } from '../../decorators';

/**
 * TASK-331 doc-09 — end-user (clinician) prompt-template plane.
 *
 * The doctor-facing counterpart to the admin `PromptManagementController`.
 * Pre-Summary / Summary in the ui-playground need to populate a template
 * selector for a clinician (often under impersonation). Routing that through
 * the admin `/admin/prompt-templates` list required the `manage`-derived
 * `read:PromptTemplate` ability that doctors don't have, so the call 403'd and
 * the global query-cache error handler bounced the whole app to `/403`.
 *
 * This controller lives OFF the `/admin/*` prefix and exposes a single,
 * read-only, caller-scoped route. It requires only `read:PromptTemplate` (the
 * new clinician policy). Plane separation is preserved because the admin read
 * surface was bumped to `manage:PromptTemplate` (doc-09 D1), so this ability
 * grant does NOT open the admin GET routes to clinicians.
 */
@ApiBearerAuth()
@ApiTags('prompt-templates')
@Controller('prompt-templates')
export class PromptTemplateController {
  constructor(
    @Inject(IPromptManagementService)
    private readonly promptService: IPromptManagementService,
  ) {}

  @Get('available')
  @Authorize(['read', 'PromptTemplate'])
  @ApiOperation({
    summary: 'List the prompt templates the calling clinician may use (TASK-331 doc-09)',
    description:
      'Returns only templates the caller can consume for generation: the ' +
      "tenant's defaults, department defaults, and the caller's OWN personal " +
      "overlays. Other users' personal templates, drafts on the admin plane, " +
      'and usage analytics are never exposed here. Tenant-scoped to the caller.',
  })
  @ApiQuery({ name: 'category', required: false, type: String, description: 'Narrow to a single category (e.g. SUMMARY).' })
  @ApiResponse({ status: 200, description: 'Templates available to the caller', type: PromptTemplateResponse, isArray: true })
  async available(@Query() queryParams: { category?: string }): Promise<PromptTemplateResponse[]> {
    return this.promptService.listAvailableForCaller({ category: queryParams.category });
  }
}
