import { IGuardrailRuleTestService, ScreenGuardrailRulesRequest, ScreenGuardrailRulesResponse } from '@arcaai/applications';
import { Body, Controller, HttpCode, HttpStatus, Inject, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { CanRead, ForbidApiKey, ForbidServiceAccount } from '../../decorators';

/**
 * `POST admin/guardrail/screen` — the console LLM playground's "Test my rules" (TASK-1050): screen text
 * under the WORKING TENANT's effective guardrail rules and see every check's verdict and action.
 *
 * AUTH-NOTE: `read:TenantGuardrailPolicy` (the seeded tenant admin, tenant-pinned; a super admin through
 * `manage:all`) decides who may test — a test READS the rules, it changes nothing. The decorator cannot
 * say WHOSE rules, so `GuardrailRuleTestService` resolves the tenant existence-first before any upstream
 * call: a non-super-admin aiming at another tenant is 404 (404-over-403), no working tenant is 400.
 * Human-only: API keys are refused first, the service-account plane explicitly.
 *
 * It persists nothing on the gateway and echoes no content beyond what the caller sent (guardrail's
 * own evaluation record captures the call as caller `playground`). Each test runs real classifiers and
 * judges, so it rides the `heavy` (AI processing) throttle tier, like the agent test bench.
 */
@ApiBearerAuth()
@ApiTags('admin-guardrail-availability')
@ForbidApiKey()
@ForbidServiceAccount()
@Controller('admin/guardrail')
export class GuardrailRuleTestController {
  constructor(
    @Inject(IGuardrailRuleTestService)
    private readonly ruleTest: IGuardrailRuleTestService,
  ) {}

  @Post('screen')
  @HttpCode(HttpStatus.OK)
  @CanRead('TenantGuardrailPolicy')
  @Throttle({ heavy: { limit: 20, ttl: 60000 } })
  @ApiOperation({
    summary: "Screen text under the working tenant's guardrail rules (Test my rules)",
    description:
      'Runs guardrail`s own inbound or outbound screen for the working tenant, exactly as a generation would be screened, and returns the four-way decision, every check`s verdict / configured action / action taken / score / category, the notices raised, the evaluation id and the policy version. Inbound takes `text` OR `regions` (each with its trust); outbound takes the response as `text` and optional source `regions`. Nothing is stored by the gateway, and no content is returned.',
  })
  @ApiResponse({ status: 200, type: ScreenGuardrailRulesResponse })
  @ApiResponse({
    status: 400,
    description: 'Malformed body, both or neither of `text` / `regions`, no working tenant, or guardrail refused the input shape.',
  })
  @ApiResponse({ status: 403, description: 'The caller holds no `read:TenantGuardrailPolicy`, or is an API key / service account.' })
  @ApiResponse({ status: 404, description: 'The working tenant is not the caller`s own (404-over-403).' })
  @ApiResponse({ status: 429, description: 'Heavy-tier rate limit reached.' })
  @ApiResponse({ status: 503, description: '`GUARDRAIL_UNAVAILABLE` — guardrail could not answer.' })
  async screen(@Body() request: ScreenGuardrailRulesRequest): Promise<ScreenGuardrailRulesResponse> {
    return this.ruleTest.screen(request);
  }
}
