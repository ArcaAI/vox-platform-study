import { Body, Controller, HttpCode, HttpStatus, Param, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiParam, ApiResponse, ApiTags } from '@nestjs/swagger';
import { PromptPreviewRequest, PromptPreviewResponse, PromptPreviewService } from '@arcaai/applications';
import { CanRead, ForbidApiKey, RequiredSvcScopes } from '../../decorators';

/**
 * The Prompt Inspector — a DRY RUN of the prompt a real consultation would send: the composed
 * messages, what a cloud provider would receive after pseudonymization, the detected identifiers
 * (counts only), the token estimate and the composition. No model is called.
 *
 * A consultation of another tenant is 404, never 403. Audited: the response is the prompt, PHI
 * included.
 */
@ApiBearerAuth()
@ApiTags('admin-consultations')
@ForbidApiKey()
@RequiredSvcScopes('svc:admin:consultation-admin:manage')
@Controller('admin/consultations')
@CanRead('Consultation')
export class PromptPreviewController {
  constructor(private readonly previews: PromptPreviewService) {}

  @Post(':consultationId/prompt-preview')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Preview the prompt a consultation would send',
    description:
      'Composes the prompt for `phase` (`live`, `pre-summary`, `finalize`) from the consultation`s own data — optionally with a ' +
      'named agent`s instruction — and returns the system and user messages, the egress locality of the model that would serve ' +
      'the call, the provider view (identifiers pseudonymized as `[<LABEL>_<n>]`, cloud only), detected identifier counts, a ' +
      'token estimate and the composition (selected fragments and data sections). Nothing is generated. Audited.',
  })
  @ApiParam({ name: 'consultationId', description: 'Consultation id', type: String })
  @ApiResponse({ status: 200, type: PromptPreviewResponse })
  @ApiResponse({ status: 400, description: 'Invalid body, no working tenant, or a prompt variable nothing supplies (`PROMPT_VARIABLE_UNRESOLVED`).' })
  @ApiResponse({ status: 404, description: 'No such consultation in this tenant, or no such published TEXT_GENERATION agent.' })
  @ApiResponse({ status: 503, description: 'PII detection is unavailable (`GUARDRAIL_UNAVAILABLE`).' })
  async preview(@Param('consultationId') consultationId: string, @Body() body: PromptPreviewRequest): Promise<PromptPreviewResponse> {
    return this.previews.preview(consultationId, body);
  }
}
