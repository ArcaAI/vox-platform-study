import { IWorkflowExposureService, Public, WorkflowInvokeResponse } from '@arcaai/applications';
import { BadRequestException, Controller, Headers, HttpCode, HttpStatus, Inject, Param, Post, Req } from '@nestjs/common';
import { ApiHeader, ApiOperation, ApiParam, ApiResponse, ApiTags } from '@nestjs/swagger';
import type { RawBodyRequest } from '@nestjs/common';
import type { Request } from 'express';

/**
 * `WorkflowHooksController` — TASK-864 §3.4, the INBOUND webhook trigger:
 * `POST /api/v1/hooks/workflows/{hookId}`.
 *
 * `@Public()` on purpose: the caller is an external system with no HOPE credential. What
 * authenticates it is possession of the definition's per-lineage secret, proven by
 * `X-Hope-Signature: sha256=<HMAC-SHA256 over "<X-Hope-Timestamp>.<raw body>">`. The route
 * reads `req.rawBody` (`rawBody: true` in `main.ts`) — the EXACT bytes that were signed, never a
 * re-serialised object — and hands them to the service, which verifies, bounds replay and starts
 * the run under the secret's own tenant. Every refusal is one 404; the hook id is the only public
 * handle and a distinguishable failure would be an oracle over it.
 *
 * `hookId` rather than `{slug}`: a slug is unique per TENANT, and an unauthenticated route has no
 * tenant context to disambiguate it — the secret row's id names both. The URL is minted by
 * `POST /admin/workflow-definitions/{slug}/webhook-secret` alongside the secret.
 */
@ApiTags('workflows')
@Controller('hooks/workflows')
export class WorkflowHooksController {
  constructor(@Inject(IWorkflowExposureService) private readonly workflowExposureService: IWorkflowExposureService) {}

  @Post(':hookId')
  @Public()
  @HttpCode(HttpStatus.ACCEPTED)
  @ApiOperation({
    summary: 'Start a run from an external system (inbound webhook trigger). Body = the trigger payload; authenticated by HMAC over the raw body.',
    description:
      'Sign `"<X-Hope-Timestamp>.<raw body>"` with the secret issued by `POST /admin/workflow-definitions/{slug}/webhook-secret` (HMAC-SHA256, hex, prefixed `sha256=`). ' +
      'The timestamp is unix seconds and must be within ±300s. Always `mode=async`: the response is the run handle; observe it through the status or stream routes with a tenant credential. ' +
      'Send `Idempotency-Key` to make a retried delivery JOIN the run it already started.',
  })
  @ApiParam({ name: 'hookId', description: 'The hook id minted with the secret.' })
  @ApiHeader({ name: 'X-Hope-Signature', required: true, description: '`sha256=<hex>`' })
  @ApiHeader({ name: 'X-Hope-Timestamp', required: true, description: 'Unix seconds, folded into the signed string.' })
  @ApiHeader({ name: 'Idempotency-Key', required: false })
  @ApiResponse({ status: 202, type: WorkflowInvokeResponse })
  @ApiResponse({ status: 400, description: 'The body is not a JSON object, or carries a reserved run-identity field.' })
  @ApiResponse({ status: 404, description: 'Unknown hook, bad or stale signature, or a Trigger that does not accept the webhook kind — one answer for all.' })
  async trigger(
    @Param('hookId') hookId: string,
    @Req() req: RawBodyRequest<Request>,
    @Headers('X-Hope-Signature') signature?: string,
    @Headers('X-Hope-Timestamp') timestamp?: string,
    @Headers('Idempotency-Key') idempotencyKey?: string,
  ): Promise<WorkflowInvokeResponse> {
    const rawBody = req.rawBody?.toString('utf8');
    if (rawBody === undefined) throw new BadRequestException('A request body is required.');
    return this.workflowExposureService.triggerByWebhook(hookId, { tenantId: '', rawBody, signature, timestamp, idempotencyKey });
  }
}
