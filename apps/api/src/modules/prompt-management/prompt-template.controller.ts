import {
  IPromptManagementService,
  PromptTemplateResponse,
  CreatePromptTemplateRequest,
  UpdatePromptTemplateRequest,
  SetPreferredTemplateRequest,
  PreferredPromptTemplateResponse,
} from '@arcaai/applications';
import { Body, Controller, Delete, Get, Inject, Param, Patch, Post, Put, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiHeader, ApiOperation, ApiParam, ApiQuery, ApiResponse, ApiTags } from '@nestjs/swagger';
import { Authorize, ExpectedVersion, RequiresIfMatch } from '../../decorators';

/**
 * End-user (clinician) prompt-template plane.
 *
 * The doctor-facing counterpart to the admin `PromptManagementController`.
 * Pre-Summary / Summary in the ui-playground need to populate a template
 * selector for a clinician (often under impersonation). Routing that through
 * the admin `/admin/prompt-templates` list required the `manage`-derived
 * `read:PromptTemplate` ability that doctors don't have, so the call 403'd and
 * the global query-cache error handler bounced the whole app to `/403`.
 *
 * This controller lives OFF the `/admin/*` prefix. It requires only
 * `read:PromptTemplate` (the clinician policy). Plane separation is preserved
 * because the admin read surface was bumped to `manage:PromptTemplate`, so
 * this ability grant does NOT open the admin GET routes to clinicians.
 *
 * This plane also extends to doctor self-service: personal prompt create /
 * update / delete (STRICT caller-ownership enforced in the service — a `read`
 * grant only lets the clinician reach the route; it is NOT a mutate grant)
 * plus set-preferred (writes `UserProfile.preferredPromptTemplateId`, which
 * the resolver cascade reads back).
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
    summary: 'List the prompt templates the calling clinician may use',
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

  // ─── Set / clear preferred template ──────────
  // Declared before the `:id` routes for clarity (it's a distinct PUT, so no
  // route collision). The service validates the template is available to the
  // caller before writing; a null `templateId` clears the preference.
  @Put('preferred')
  @Authorize(['read', 'PromptTemplate'])
  @ApiOperation({
    summary: "Set or clear the calling clinician's preferred prompt template",
    description:
      'Writes `UserProfile.preferredPromptTemplateId` for the caller. The id MUST be visible to the caller ' +
      '(own personal prompts + published defaults); `templateId: null` clears the preference (revert to the ' +
      'department/tenant default tier resolved by the Phase-5 cascade).',
  })
  @ApiResponse({ status: 200, description: 'The resulting preferred template id', type: PreferredPromptTemplateResponse })
  @ApiResponse({ status: 403, description: 'Template is not available to the caller' })
  async setPreferred(@Body() dto: SetPreferredTemplateRequest): Promise<PreferredPromptTemplateResponse> {
    return this.promptService.setPreferredPromptTemplate(dto.templateId);
  }

  // ─── Personal CRUD (caller-ownership) ────────────────────────────────
  //
  // AUTH-NOTE: the three routes below are WRITES declared with
  // `@Authorize(['read','PromptTemplate'])`, which looks wrong and is not.
  // These are clinician SELF-SERVICE routes over USER_PERSONAL prompts: `read`
  // is the "may use prompts at all" ability that clinicians hold, and the real
  // gate is OWNERSHIP, enforced imperatively in the service (non-personal or
  // non-owned → 403; cross-tenant id → 404). Promoting these to
  // `create`/`update:PromptTemplate` would lock every clinician out of their own
  // prompts, since that ability is an admin grant. See
  // `.claude/rules/05-nestjs-api.md` §"Imperative privilege checks".
  @Post()
  @Authorize(['read', 'PromptTemplate'])
  @ApiOperation({
    summary: 'Create a personal prompt template owned by the calling clinician',
    description: "Creates a USER_PERSONAL prompt owned by the caller (overlays the tenant/department defaults in the caller's selector).",
  })
  @ApiResponse({ status: 201, description: 'The created personal template', type: PromptTemplateResponse })
  async createPersonal(@Body() dto: CreatePromptTemplateRequest): Promise<PromptTemplateResponse> {
    return this.promptService.createPersonal(dto);
  }

  @Patch(':id')
  @Authorize(['read', 'PromptTemplate'])
  @RequiresIfMatch()
  @ApiOperation({
    summary: 'Update a personal prompt template the caller owns',
    description:
      'Updates one USER_PERSONAL prompt OWNED by the caller. Optimistic concurrency is enforced: the `If-Match` ' +
      "header (RFC 7232) is REQUIRED and the server runs a Compare-And-Set against the row's `_version`. When " +
      'present, the header value overrides the body-field `expectedVersion`. A non-personal or non-owned template ' +
      'is rejected (403); a cross-tenant id is hidden behind 404.',
  })
  @ApiParam({ name: 'id', description: 'Prompt template ID', type: String })
  @ApiHeader({
    name: 'If-Match',
    description: 'RFC 7232 strong validator carrying the row version the client read (e.g. `"1"`).',
    required: true,
    example: '"1"',
  })
  @ApiResponse({ status: 200, description: 'The updated personal template', type: PromptTemplateResponse })
  @ApiResponse({ status: 403, description: 'Caller does not own this personal template' })
  @ApiResponse({ status: 404, description: 'Template not found' })
  @ApiResponse({ status: 412, description: 'Optimistic concurrency conflict — re-fetch and try again with the new version.' })
  @ApiResponse({ status: 428, description: 'If-Match header is required for this operation.' })
  async updatePersonal(
    @Param('id') id: string,
    @Body() dto: UpdatePromptTemplateRequest,
    @ExpectedVersion() expectedFromHeader: number | undefined,
  ): Promise<PromptTemplateResponse> {
    const effective: UpdatePromptTemplateRequest = expectedFromHeader !== undefined ? { ...dto, expectedVersion: expectedFromHeader } : dto;
    return this.promptService.updatePersonal(id, effective);
  }

  @Delete(':id')
  @Authorize(['read', 'PromptTemplate'])
  @ApiOperation({
    summary: 'Soft-delete a personal prompt template the caller owns',
    description: 'Soft-deletes one USER_PERSONAL prompt OWNED by the caller. A non-personal or non-owned template is rejected (403).',
  })
  @ApiParam({ name: 'id', description: 'Prompt template ID', type: String })
  @ApiResponse({ status: 200, description: 'The soft-deleted personal template', type: PromptTemplateResponse })
  @ApiResponse({ status: 403, description: 'Caller does not own this personal template' })
  @ApiResponse({ status: 404, description: 'Template not found' })
  async deletePersonal(@Param('id') id: string): Promise<PromptTemplateResponse> {
    return this.promptService.deletePersonal(id);
  }
}
