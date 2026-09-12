import { AiDeploymentKind } from '@arcaai/domains';
import { HttpService } from '@nestjs/axios';
import { ConfigService } from '@nestjs/config';
import { BadRequestException, ConflictException, Inject, Injectable, Logger, NotFoundException, Optional } from '@nestjs/common';
import { ClsService } from 'nestjs-cls';
import type { Readable } from 'node:stream';
import { TENANTLESS, internalServiceHeaders, resolveInternalAccessToken } from '../../common';
import type { IActiveUserContext } from '../../interfaces';
import { SecretsService } from '../baseServices/_meta/secrets';
import { readGenerationId } from '../text-request/text-stream-open';
import { TextRequestEnrichmentService } from '../text-request/text-request-enrichment.service';
import { ProviderCredentialResolver } from '../ai-provider-connection/provider-credential-resolver';
import { AGENT_CONNECTION_UNAVAILABLE } from './agent-resolver.service';
import { IEntitlementsService } from '../entitlements/IEntitlementsService';
import type { IEntitlementsService as IEntitlementsServicePort } from '../entitlements/IEntitlementsService';
import { IUsageLedgerService } from '../usageLedger/IUsageLedgerService';
import type { IUsageLedgerService as IUsageLedgerServicePort } from '../usageLedger/IUsageLedgerService';
import { IComputeDeviceResolver } from '../usageLedger/compute-device.resolver';
import type { IComputeDeviceResolver as IComputeDeviceResolverPort } from '../usageLedger/compute-device.resolver';
import type { ComputeAugmentedBatch } from '../usageLedger/compute-units';
import type { UsageEventBatchInput } from '../usageLedger/dto';
import { withUsageTrigger } from '../usageLedger/usage-attributes';
import type { ComputeDevice } from '../usageLedger/usage-attributes';
import {
  buildLlmUsageBatches,
  buildLlmUsageBatchesFromTokenCounts,
  parseTextUsageDetail,
  resolveDeployment,
  toLedgerProvider,
  type TextUsageDetail,
} from '../consultation/summary/text-usage';

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
  /**
   * TASK-891 (OD-4) — the draft's own `parameters.generation`, so the bench obeys the reasoning
   * control an author sets on the very screen they set it. Only the REASONING posture is read
   * from it, by `applyTextRuntimeProfile`: `provider`, `model` and the token budget are already
   * resolved by `AgentService` and passed as their own fields. Optional, because a draft that
   * authored no block has nothing to say and must produce the body it produced before.
   */
  generation?: unknown;
  /**
   * TASK-958 F11 — the `AiProviderConnection` the draft's primary model is DECLARED on
   * (`AiModel.sourceConnectionId`), and the provider that connection is filed under.
   *
   * Both absent for a SYSTEM catalogue model, which names no connection: the run then
   * takes the ordinary tenant → SYSTEM fold, exactly as it did before multiplicity.
   * Present, they are authoritative — the bench must spend the account the author bound,
   * or it is benching a different agent than the one they are about to publish.
   */
  connectionId?: string | null;
  connectionProvider?: string | null;
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
 * Funding is DERIVED (`buildLlmUsageBatches` reads `byok` off the usage block); nothing here
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
    // TASK-958 F11 — the by-id credential resolve for a draft bound to a NAMED connection.
    // `@Optional()` and TRAILING: without it a bound draft still refuses to bench on the
    // wrong account (the guard below fires), and an unbound one is untouched.
    @Optional() private readonly credentials?: ProviderCredentialResolver,
    // TASK-959 §3.1 — which device a SELF-HOSTED engine ran on. A bench run on the platform's
    // own LM Studio has a real occupancy reading on its usage block, and without a device the
    // appender records no compute row for it rather than guessing one. Optional + trailing like
    // the ledger above it.
    @Optional() @Inject(IComputeDeviceResolver) private readonly computeDevice?: IComputeDeviceResolverPort,
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
      await this.textRequestEnrichment.applyTextRuntimeProfile(body as { provider?: string; model?: string }, input.generation);
      // TASK-958 F11 — the BOUND account first, exactly as `AgentInvocationService` does.
      // `applyTenantProviderOverrides` folds by PROVIDER NAME, which can only ever answer
      // with the tenant's DEFAULT connection, so a draft declared on the second OpenAI
      // account would otherwise be benched — and metered — on the first one's key. The
      // enrichment returns early when `provider_overrides` is already set, which is
      // exactly the contract it states.
      await this.applyBoundConnection(body, input);
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

    await this.record(tenantId, taskId, data);

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
   * §3.13 — `generate.stream`, `trigger: 'AGENT_TEST'`, from what the task read-back ACTUALLY
   * carries.
   *
   * TEXT's own `usage_detail` block is preferred and is the only source that can supply a real
   * `endpoint_kind`, so it is the only one that produces a fully-dimensioned row. It was ALSO
   * the only source this method read — and `GET /tasks/{id}` did not return it (J3-4). The
   * normalizer correctly refused to invent an endpoint kind, so every bench run recorded
   * nothing, silently, while the console displayed the token total it had just been handed.
   *
   * `apps/text` now persists that block, so the first branch is the live one. The second exists
   * because a gateway can outrun the service it talks to: bare `{prompt_tokens,
   * completion_tokens}` is less than a usage block, but it is not nothing, and dropping real
   * spend to protect a dimension is the wrong trade. It bills through the honest builder, which
   * fabricates no endpoint kind.
   *
   * A decline is LOGGED. The whole gap survived to the release phase because it was silent.
   */
  private async record(
    tenantId: string,
    taskId: string,
    data: { provider?: string; model?: string; usage?: { prompt_tokens?: number; completion_tokens?: number } | null; usage_detail?: unknown },
  ): Promise<void> {
    if (!this.usageLedger) return;

    const detail = parseTextUsageDetail(data.usage_detail);
    // TASK-959 — the `*Batches` siblings, not the single-batch forms: the BUILDER appends the
    // compute and byte rows, and only these hand back the platform CPU leg of a BYOK run.
    let pair = detail
      ? buildLlmUsageBatches({ usage: detail, tenantId, operation: 'generate.stream', device: await this.llmDevice(tenantId, detail) })
      : null;

    if (!pair) {
      const provider = toLedgerProvider(data.provider ?? '');
      pair = buildLlmUsageBatchesFromTokenCounts({
        tenantId,
        operation: 'generate.stream',
        requestId: taskId,
        provider: provider || 'none',
        model: data.model ?? null,
        // Derived from the provider, never stamped: a local `lm-studio` bench run recorded as
        // CLOUD forks the rollup dimension it belongs in.
        deployment: resolveDeployment(provider, false),
        occurredAt: new Date(),
        inputTokens: data.usage?.prompt_tokens ?? 0,
        outputTokens: data.usage?.completion_tokens ?? 0,
        // TASK-959 — deliberately NO `device`: this branch exists for a read-back that carried
        // bare `{prompt_tokens, completion_tokens}` and nothing else, so there is no occupancy
        // reading and therefore no compute row for a device to ride on. Resolving one here
        // would read the cascade to label a row that is never built.
      });
    }

    const inputs = usageBatches(pair);
    if (inputs.length === 0) {
      // Nothing to bill, or nothing billable — say so. A row claiming an unknown amount happened
      // is worse than no row, but an unexplained absence is how this stayed broken.
      this.logger.warn({
        message: 'A draft-agent test run was persisted unmetered: the TEXT task read-back carried no usage the ledger can bill',
        taskId,
        hasUsageDetail: data.usage_detail !== undefined && data.usage_detail !== null,
      });
      return;
    }

    try {
      for (const input of inputs) {
        await this.usageLedger.recordUsage(withUsageTrigger(input, 'AGENT_TEST'));
      }
    } catch (error) {
      this.logger.warn({
        message: 'Usage metering failed for a draft-agent test run; the run is unmetered',
        taskId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * Which device this bench run's seconds were spent on — `null` when this service has no
   * business naming one (TASK-959 §3.1).
   *
   * A CLOUD or BYOK run is not the vendor's hardware: those seconds are the platform's own CPU
   * spent CALLING the vendor, which the appender meters as `cpu` whatever is passed. The
   * provider is read off TEXT's OWN usage block — the engine that actually served the bench.
   *
   * Never raises: an unresolvable device costs a compute row, and the whole point of this
   * method's caller is that a metering problem must never turn a finished test into an error.
   */
  private async llmDevice(tenantId: string, usage: TextUsageDetail): Promise<ComputeDevice | null> {
    const provider = toLedgerProvider(usage.textProvider);
    if (resolveDeployment(provider, usage.byok) !== AiDeploymentKind.SELF_HOSTED) return null;
    try {
      return (await this.computeDevice?.resolve(tenantId, provider)) ?? null;
    } catch (error) {
      this.logger.warn({
        message: 'Compute device unresolved; metering this draft-agent test run without a compute row',
        provider,
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  }

  /**
   * Pre-set `provider_overrides` from the connection the draft's model is declared on.
   *
   * Keyed by the body's OWN provider (the wire id `apps/text` registers), because that is
   * the key both the enrichment and TEXT read it under — the connection plane's own
   * provider id is what the credential is RESOLVED by, not what it is filed under here.
   *
   * A binding that cannot serve REFUSES the run with the same 409 the invocation plane
   * raises. Falling through would bench the draft on the tenant's default account and
   * report a green result for an agent that cannot run.
   *
   * Only a NOT-FOUND is folded into that refusal. A veto (409) and an un-entitled
   * platform default (403) are already attributable answers with their own remedies, and
   * flattening them into one generic code would tell an admin to re-key a connection they
   * deliberately disabled.
   */
  private async applyBoundConnection(body: Record<string, unknown>, input: DraftTestSubmitInput): Promise<void> {
    const { connectionId, connectionProvider } = input;
    if (!connectionId || !connectionProvider) return;
    const binding = this.credentials
      ? await this.credentials.resolve('llm', connectionProvider, input.tenantId, { connectionId }).catch((error: unknown) => {
          if (error instanceof NotFoundException) return null;
          throw error;
        })
      : null;
    if (!binding) {
      throw new ConflictException({
        code: AGENT_CONNECTION_UNAVAILABLE,
        message:
          `This draft's model is declared on a ${connectionProvider} connection that cannot serve ` +
          '(disabled, missing its key, or no longer visible to this tenant). Enable or re-key that connection before testing.',
        modelSlug: input.model,
        connectionId,
      });
    }
    body.provider_overrides = { [input.provider]: binding.override };
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

/**
 * Both halves of an augmented pair (TASK-959 §6.3) — the tokens, and the platform CPU leg a
 * BYOK run splits onto its own `INTERNAL` batch because `costBasis` lives on `common`. A
 * non-BYOK pair flattens to the one batch it always was.
 */
function usageBatches(pair: ComputeAugmentedBatch | null): UsageEventBatchInput[] {
  if (!pair) return [];
  return pair.platformBatch ? [pair.batch, pair.platformBatch] : [pair.batch];
}
