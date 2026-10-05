import { Body, Controller, Headers, HttpCode, HttpStatus, Inject, Post, UseGuards } from '@nestjs/common';
import { ApiExcludeController, ApiTags } from '@nestjs/swagger';
import { IComposedPromptService, RecordComposedPromptAcceptedResponse, RecordComposedPromptRequest, TENANTLESS_PREFIX } from '@arcaai/applications';
import { ArgumentInvalidException } from '@arcaai/exceptions';
import { Public } from '../../decorators';
import { InternalServiceTokenGuard } from './internal-service-token.guard';

/**
 * `POST /internal/composed-prompts?service=harness` — the harness records the composed messages
 * of a text call it made (OD-9). Service-to-service only: `X-Service-Token` (the guard's
 * `?service=` selector picks the secret) and the MANDATORY `X-Tenant-Id`, which names the record's
 * tenant — a body never does.
 *
 * Answers 202 at once; the encrypted write happens in the background and can never fail or slow
 * the caller's generation step.
 *
 * Excluded from the published API document because it is an internal service contract, not a
 * client surface — it is still mounted and still guarded.
 */
@ApiExcludeController()
@ApiTags('internal-composed-prompts')
@Public()
@UseGuards(InternalServiceTokenGuard)
@Controller('internal/composed-prompts')
export class ComposedPromptInternalController {
  constructor(@Inject(IComposedPromptService) private readonly composedPrompts: IComposedPromptService) {}

  @Post()
  @HttpCode(HttpStatus.ACCEPTED)
  record(
    @Body() body: RecordComposedPromptRequest,
    @Headers('x-tenant-id') tenantIdHeader: string | undefined,
  ): RecordComposedPromptAcceptedResponse {
    const tenantId = tenantIdHeader?.trim();
    if (!tenantId || tenantId.startsWith(TENANTLESS_PREFIX)) {
      throw new ArgumentInvalidException('A tenant `X-Tenant-Id` is required — a composed-prompt record always belongs to a tenant.');
    }
    this.composedPrompts.acceptInternal(body, tenantId);
    return { accepted: true };
  }
}
