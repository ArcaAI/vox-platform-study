import { Controller, Get, Inject, Param, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiParam, ApiResponse, ApiTags } from '@nestjs/swagger';
import { ComposedPromptDetailResponse, ComposedPromptPageResponse, IComposedPromptService, ListComposedPromptsQuery } from '@arcaai/applications';
import { CanRead, ForbidApiKey, RequiredSvcScopes } from '../../decorators';

/**
 * The composed-prompt incident records (OD-9): the exact system + user messages each LLM call
 * was sent, kept encrypted for a governed retention (`composedPrompts.retentionDays`).
 *
 * Every route acts on the caller's CLS tenant (a super admin's working tenant); a record of
 * another tenant is 404, never 403. Both reads are audited — the detail decrypts PHI.
 */
@ApiBearerAuth()
@ApiTags('admin-composed-prompts')
@ForbidApiKey()
@RequiredSvcScopes('svc:admin:consultation-admin:manage')
@Controller('admin/composed-prompts')
@CanRead('Consultation')
export class ComposedPromptAdminController {
  constructor(@Inject(IComposedPromptService) private readonly composedPrompts: IComposedPromptService) {}

  // AUTH-NOTE: the class decorator UNDERSTATES this route's gate — ComposedPromptService.list
  // admits only a SUPER_ADMIN or a TENANT_ADMIN of the working tenant (assertPromptInspectorAccess,
  // 403; a doctor holding read:Consultation is refused). Row-independent, so it runs first.
  @Get()
  @ApiOperation({
    summary: 'List composed-prompt records',
    description:
      'Newest first, optionally for one consultation. METADATA only (phase, provider, locality, agent, digest, time) — ' +
      'the messages themselves are returned only by the single-record read. Audited.',
  })
  @ApiResponse({ status: 200, type: ComposedPromptPageResponse })
  @ApiResponse({ status: 400, description: 'Invalid query.' })
  @ApiResponse({ status: 403, description: 'Not a super administrator or a tenant administrator of this tenant (`PROMPT_INSPECTOR_FORBIDDEN`).' })
  @ApiResponse({ status: 404, description: 'No tenant in context.' })
  async list(@Query() query: ListComposedPromptsQuery): Promise<ComposedPromptPageResponse> {
    return this.composedPrompts.list(query);
  }

  // AUTH-NOTE: the class decorator UNDERSTATES this route's gate — ComposedPromptService.getDecrypted
  // admits only a SUPER_ADMIN or a TENANT_ADMIN of the working tenant (assertPromptInspectorAccess,
  // 403; a doctor holding read:Consultation is refused). Row-independent, so it runs first;
  // another tenant's record is still 404 for an admin.
  @Get(':id')
  @ApiOperation({
    summary: 'Read one composed-prompt record, decrypted',
    description: 'The exact system and user messages the call was sent, decrypted from Vault-Transit ciphertext. Audited.',
  })
  @ApiParam({ name: 'id', description: 'Composed-prompt record id', type: String })
  @ApiResponse({ status: 200, type: ComposedPromptDetailResponse })
  @ApiResponse({ status: 403, description: 'Not a super administrator or a tenant administrator of this tenant (`PROMPT_INSPECTOR_FORBIDDEN`).' })
  @ApiResponse({ status: 404, description: 'No such record in this tenant.' })
  async getById(@Param('id') id: string): Promise<ComposedPromptDetailResponse> {
    return this.composedPrompts.getDecrypted(id);
  }
}
