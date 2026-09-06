import { HttpService } from '@nestjs/axios';
import { ConfigService } from '@nestjs/config';
import { BadRequestException, Inject, Injectable, Logger, NotFoundException, Optional } from '@nestjs/common';
import { ClsService } from 'nestjs-cls';
import type { Readable } from 'node:stream';
import { TENANTLESS, internalServiceHeaders, resolveInternalAccessToken } from '../../common';
import type { IActiveUserContext } from '../../interfaces';
import { SecretsService } from '../baseServices/_meta/secrets';
import { readGenerationId } from '../text-request/text-stream-open';
import { TextRequestEnrichmentService } from '../text-request/text-request-enrichment.service';
import { IEntitlementsService } from '../entitlements/IEntitlementsService';
import type { IEntitlementsService as IEntitlementsServicePort } from '../entitlements/IEntitlementsService';
import { IUsageLedgerService } from '../usageLedger/IUsageLedgerService';
import type { IUsageLedgerService as IUsageLedgerServicePort } from '../usageLedger/IUsageLedgerService';
import { withUsageTrigger } from '../usageLedger/usage-attributes';
import { buildLlmUsageInput, parseTextUsageDetail } from '../consultation/summary/text-usage';

/** TEXT's terminal task state — the only one whose `content` is the whole generation. */
const TEXT_TASK_COMPLETED = 'completed';

/** What a submitted draft-test run needs to be resumed and finalised. */
export interface DraftTestSubmission {
  taskId: string;
  /** Gateway-relative SSE path — the browser talks to the gateway, never to TEXT. */
  streamUrl: string;
}

export interface DraftTestOutcome {
  output: string;
  provider: string;
  model: string;
  usage: { promptTokens: number; completionTokens: number; totalTokens: number } | null;
}

export interface DraftTestSubmitInput {
  tenantId: string;
  /** The rendered user prompt — already assembled by `AgentService`, never a template. */
  prompt: string;
  /** The rendered system prompt, when the agent has one. */
  systemPrompt: string | null;
  provider: string;
  model: string;
  /** §3.14 — the agent's own guardrail decision, carried on the wire like every other TEXT post. */
  guardrailEnabled: boolean;
}

/**
 * TASK-890 §3.8 / §3.13 — the TRANSPORT half of the draft-agent test bench.
 *
 * ## Why this is its own provider and not four more constructor arguments
 *
 * `AgentService` decides WHAT to run: it compiles the draft in memory, renders the prompt and
 * resolves the target. Running it needs an entirely different set of collaborators — an HTTP
 * client, the internal service token, the tenant-credential enrichment, the entitlements meter
 * and the usage ledger — none of which any other `AgentService` method touches. Folding them in
 * would add five optional positional dependencies to a constructor that already carries twelve,
 * for one route.
 *
 * ## The two-call shape, and why it is not one call
 *
 * The bench mirrors the prompt-template bench exactly (`PromptManagementService`
 * `startPromptTemplateTest` / `finalizePromptTemplateTest`), because the browser is the real
 * consumer of the stream: the gateway opens the generation, learns its id from the first frame
 * and DROPS its own subscription (dropping a subscription is not a cancel — the producer is
 * TEXT's, and every delta lands in the replay buffer), then the browser subscribes through the
 * gateway's own SSE relay with a single-use ticket. `finalize` reads the finished text back
 * SERVER-SIDE by task id: the browser saw the same tokens, but trusting it to hand them back
 * would let any caller forge what gets recorded.
 *
 * ## Metering (OD-E — the test COUNTS)
 *
 * The precheck is `assertMeterQuota(tenantId, 'monthlyLlmTokens')` in its no-increment shape,
 * placed BEFORE the upstream call because a draft test spends real tokens on the tenant's own
 * plan. The record is `generate.stream` with `trigger: 'AGENT_TEST'`, built from TEXT's OWN usage
 * block on finalize. It shares `UsageIdempotencyKey.llmRequest(taskId)` with the gateway's SSE
 * relay, so a stream that both paths observe converges on ONE billed event rather than two.
 * Funding is DERIVED (`buildLlmUsageInput` reads `byok` off the usage block); nothing here
 * stamps a funding tier, and there is no `funding: 'test'`.
 */
@Injectable()
export class AgentDraftTestService {
  private readonly logger = new Logger(AgentDraftTestService.name);
  private readonly textServiceUrl: string;

  constructor(
    private readonly clsService: ClsService<IActiveUserContext>,
    @Optional() private readonly httpService?: HttpService,
    @Optional() private readonly configService?: ConfigService,
    @Optional() @Inject(SecretsService) private readonly secretsService?: SecretsService,
    @Optional() @Inject(TextRequestEnrichmentService) private readonly textRequestEnrichment?: TextRequestEnrichmentService,
    @Optional() @Inject(IEntitlementsService) private readonly entitlements?: IEntitlementsServicePort,
    @Optional() @Inject(IUsageLedgerService) private readonly usageLedger?: IUsageLedgerServicePort,
  ) {
    // Env tier, bootstrap TRANSPORT address (rule 00 §Configuration Tiers) — the same resolution
    // `PromptManagementService` and `SummaryService` make.
    this.textServiceUrl = this.configService?.get<string>('TEXT_URL') ?? 'http://localhost:8862';
  }

  /**
   * Quota-check, then open the generation. Returns the id the browser resumes on.
   *
   * The precheck runs FIRST and unconditionally: a run refused for quota must not have reached
   * TEXT at all, or the tenant pays for tokens the gateway then declines to deliver.
   */
  async submit(input: DraftTestSubmitInput): Promise<DraftTestSubmission> {
    if (!this.httpService) {
      throw new BadRequestException('A non-dry agent test cannot run: the TEXT client is not configured for this service instance.');
    }
    await this.entitlements?.assertMeterQuota(input.tenantId, 'monthlyLlmTokens');

    const body: Record<string, unknown> = {
      prompt: input.prompt,
      stream: true,
      provider: input.provider,
      model: input.model,
      // §3.14 — every TEXT post carries the resolved decision. `true` is not "force on": a
      // platform kill switch stays the floor on TEXT's side.
      guardrail_policy: { enabled: input.guardrailEnabled },
    };
    if (input.systemPrompt) body.system_prompt = input.systemPrompt;

    if (this.textRequestEnrichment) {
      await this.textRequestEnrichment.applyTextRuntimeProfile(body as { provider?: string; model?: string });
      await this.textRequestEnrichment.applyTenantProviderOverrides(body as { provider?: string });
    }

    let taskId: string;
    try {
      const response = await this.httpService.axiosRef.post(`${this.textServiceUrl}/api/v1/generate`, body, {
        headers: { ...(await this.textHeaders()), Accept: 'text/event-stream' },
        responseType: 'stream',
      });
      taskId = await readGenerationId(response.data as Readable);
    } catch (error) {
      // Rethrow the CAUSE: the gateway boundary (`downstream-error.ts` via
      // `ExceptionInterceptor`) owns the status and the client-facing message. Composing a 400
      // here is what turned an ECONNREFUSED into "bad request" on the prompt bench.
      this.logger.error({
        message: 'TEXT generation-job submission failed for a draft-agent test; rethrowing the cause',
        causeMessage: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }

    return { taskId, streamUrl: `text/tasks/${taskId}/stream` };
  }

  /**
   * Read the FINISHED generation back from TEXT and record what it consumed.
   *
   * Metering degrades to "not metered", never to a failed finalize: the generation already
   * happened and the author already has their text, so a ledger outage must not turn a finished
   * test into an error.
   */
  async finalize(tenantId: string, taskId: string): Promise<DraftTestOutcome> {
    if (!this.httpService) {
      throw new BadRequestException('An agent test cannot be finalised: the TEXT client is not configured for this service instance.');
    }

    let data: {
      status?: string;
      content?: string | null;
      provider?: string;
      model?: string;
      usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number } | null;
      usage_detail?: unknown;
    };
    try {
      const response = await this.httpService.axiosRef.get(`${this.textServiceUrl}/api/v1/tasks/${taskId}`, { headers: await this.textHeaders() });
      data = response.data ?? {};
    } catch (error) {
      const status = (error as { response?: { status?: number } })?.response?.status;
      if (status === 404) throw new NotFoundException(`Generation task ${taskId} not found`);
      this.logger.error({
        message: 'TEXT task-output read failed for a draft-agent test; rethrowing the cause',
        causeMessage: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }

    const state = data.status ?? 'unknown';
    if (state !== TEXT_TASK_COMPLETED) {
      throw new BadRequestException(`Generation task ${taskId} is not complete (state: ${state}). Wait for the stream to finish before finalizing.`);
    }

    await this.record(tenantId, data.usage_detail);

    return {
      output: data.content ?? '',
      provider: data.provider ?? '',
      model: data.model ?? '',
      usage: data.usage
        ? {
            promptTokens: data.usage.prompt_tokens ?? 0,
            completionTokens: data.usage.completion_tokens ?? 0,
            totalTokens: data.usage.total_tokens ?? 0,
          }
        : null,
    };
  }

  /**
   * §3.13 — `generate.stream`, `trigger: 'AGENT_TEST'`, from TEXT's OWN usage block.
   *
   * A block TEXT did not send, or one the normalizer refuses to guess at, records NOTHING: a row
   * saying "an unknown amount happened" is worse than no row. The trigger is what makes the
   * spend attributable to the bench rather than to a consultation.
   */
  private async record(tenantId: string, usageDetail: unknown): Promise<void> {
    if (!this.usageLedger) return;
    const usage = parseTextUsageDetail(usageDetail);
    if (!usage) return;
    const batch = buildLlmUsageInput({ usage, tenantId, operation: 'generate.stream' });
    if (!batch) return;
    try {
      await this.usageLedger.recordUsage(withUsageTrigger(batch, 'AGENT_TEST'));
    } catch (error) {
      this.logger.warn({
        message: 'Usage metering failed for a draft-agent test run',
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /** The ONE shared `INTERNAL_ACCESS_TOKEN`; `X-Tenant-Id` is never conditional (TASK-888). */
  private async textHeaders(): Promise<Record<string, string>> {
    const serviceToken = await resolveInternalAccessToken(this.secretsService, 'INTERNAL_ACCESS_TOKEN');
    return internalServiceHeaders({
      serviceToken,
      tenantId: this.clsService.get('tenantId'),
      tenantlessReason: TENANTLESS.PLATFORM_OPERATOR,
    });
  }
}
