import {
  ConflictException,
  HttpException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  Optional,
  ServiceUnavailableException,
} from '@nestjs/common';
import { AgentTask } from '@arcaai/domains';
import { ArgumentInvalidException, QuotaExceededException } from '@arcaai/exceptions';
import type { AsrSessionWarning, ResolvedAgent, ResolvedAgentModel, ResolvedAsrSpec } from '@arcaai/types';
import { STT_DIARIZATION_DEFAULT_EMBEDDING_MODEL_SETTING_KEY } from '@arcaai/types';
import { AgentResolverService, ConnectionIdentityLookup, failedBindingKey, providerOverrideKey } from '../../agent/agent-resolver.service';
import { EffectiveSettingsService } from '../../settings-registry/effective-settings.service';
import { ProviderCredentialResolver } from '../../ai-provider-connection/provider-credential-resolver';
import {
  CLOUD_BYO_PROVIDERS,
  PLATFORM_SELF_HOST_PROVIDERS,
  isCloudByoProvider,
  isPlatformSelfHostProvider,
} from '../../ai-provider-connection/constants';
import { ProviderVetoedException } from '../../ai-provider-connection/provider-vetoed.exception';
import { IProviderConnectionService } from '../../ai-provider-connection/IProviderConnectionService';
import type {
  IProviderConnectionService as IProviderConnectionServicePort,
  ProviderFunding,
} from '../../ai-provider-connection/IProviderConnectionService';
import type { SttProviderOverrides } from '../stt-provider-overrides';
import {
  AsrSpecBuildError,
  asrChainModels,
  asrDegradation,
  buildResolvedAsrSpec,
  needsPlatformEmbeddingDefault,
  type AsrConnectionBinding,
} from './build-resolved-asr-spec';
import {
  GoverningWorkflowAsrReader,
  workflowAsrAgentUnavailable,
  type ConsultationAsrContext,
  type GoverningWorkflowAsrAgent,
} from './governing-workflow-asr';

export interface ResolveAsrSpecInput {
  tenantId: string;
  /** Explicit agent (lineage slug). Absent ⇒ the `AgentAssignment` cascade for `SPEECH_TO_TEXT`. */
  agentSlug?: string | null;
  departmentId?: string | null;
  /**
   * TASK-1002 — the consultation this session transcribes. When given (and no `agentSlug` is),
   * the consultation's GOVERNING WORKFLOW is consulted before the assignment cascade, and the
   * cascade runs under the consultation's own `departmentId` (which then wins over the input's).
   * An unknown or foreign id is a 404. Absent ⇒ resolution is exactly what it was before.
   */
  consultationId?: string | null;
  /**
   * TASK-1004 — the caller declared no spoken-language mode, so it will inherit the
   * consultation's. With an explicit `agentSlug` the consultation is otherwise never read; this
   * asks for that ONE read (same tenant-scoped 404) so {@link ResolvedAsrSession.consultationLanguageMode}
   * is populated. Without an `agentSlug` the consultation is read anyway and the flag is moot.
   * It never influences which agent resolves.
   */
  inheritConsultationLanguage?: boolean;
  /**
   * TASK-1042 (C1) — the STANDALONE workflow run this session will feed (mutually exclusive with
   * `consultationId`, enforced by the route). When given (and no `agentSlug` is), the agent comes
   * from that slug's ACTIVE published version — its single SPEECH_TO_TEXT `core.agent` node —
   * exactly as tier 2 reads a consultation's governing workflow; an unknown slug is a 404.
   */
  workflowSlug?: string | null;
}

/** What one STT session / batch job needs from the gateway: the spec, plus the credentials that ride beside it. */
export interface ResolvedAsrSession {
  spec: ResolvedAsrSpec;
  /** Decrypted BYO/platform cloud credentials keyed by provider — in-memory only, never persisted with the job. */
  providerOverrides?: SttProviderOverrides;
  /**
   * Which tier supplied the PRIMARY engine's credential (`undefined` when the
   * primary is self-hosted or has no credential at either tier).
   *
   * TASK-874 — this is the PRIMARY's alone and must never be stamped on a ledger
   * row for the whole session: a session can fail over to the platform fallback
   * mid-flight, and the engine that SERVED each span decides its funding. The
   * per-engine truth is `providerOverrides[provider].funding`, which `apps/stt`
   * reads under the key the loader actually used to bill engine-time.
   */
  fundingTier?: ProviderFunding;
  /**
   * TASK-951 R2 (D-8) — the context schema the resolved agent BINDS, exactly as frozen into
   * `compiledConfig.contextSchema` at publish time, or `undefined` when it binds none.
   *
   * Surfaced here because the agent row is resolved inside this service and nowhere else on the
   * STT entry path: without it the gateway would have to resolve the same agent a SECOND time
   * just to learn what `context` it may accept. Frozen, never re-read — a tenant that edits its
   * schema after publishing does not silently change what a live agent accepts (the same
   * invariant `AgentInvocationService.contextProblems` relies on).
   *
   * It is deliberately NOT part of `ResolvedAsrSpec`: the spec is the cross-language contract
   * `apps/stt` consumes (pydantic mirror + parity fixture), and the echo never reaches `apps/stt`.
   */
  contextSchema?: NonNullable<ResolvedAgent['compiledConfig']['contextSchema']>;
  /**
   * TASK-1002 — the workflow whose `SPEECH_TO_TEXT` node chose the agent. Present only when
   * tier 2 won (`spec.agent.source === 'workflow'`); the gateway logs it beside the source so a
   * tester can see WHICH workflow drove the engine.
   */
  workflowDefinitionSlug?: string | null;
  /**
   * TASK-1004 — the consultation's declared spoken-language mode, present (possibly `null` =
   * undeclared) whenever this resolution READ the consultation: always when `consultationId` was
   * given without an `agentSlug`, and with one only when `inheritConsultationLanguage` asked.
   * Absent = the consultation was not read. A decoding input for the caller's precedence
   * (request > consultation > agent > auto); resolution itself never looked at it.
   */
  consultationLanguageMode?: string | null;
  /**
   * TASK-1048 (OD-1) — the OPTIONAL stages this resolution switched off (or the fallback it
   * skipped) instead of refusing the session. OMITTED when there are none. Never part of
   * `spec`: the spec is the parity-pinned `apps/stt` wire contract; warnings are for the CALLER
   * (the session/job creation response), and each one is also logged here at WARN.
   */
  warnings?: AsrSessionWarning[];
}

const rec = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};

/**
 * TASK-861 §3.1 — the ONE resolution path from "start transcribing" to a
 * runnable `ResolvedAsrSpec`:
 *
 *  1. explicit `agentSlug` → a PUBLISHED, ACTIVE `SPEECH_TO_TEXT` agent visible to
 *     the tenant, else the `AgentAssignment` cascade `department → tenant → SYSTEM`
 *     — both through TASK-863's `AgentResolverService`, which also owns the
 *     404-over-403 posture (a foreign/unknown/unpublished slug is one 404);
 *  2. the agent's `parameters.fallback.agentSlug` is resolved the same way and
 *     embedded (kind `agent`); absent, the agent's own `AgentModelFallback` chain
 *     serves (kind `model`); a fallback that will not resolve DEGRADES to the next
 *     option — resilience configuration never blocks the primary session;
 *  3. `buildResolvedAsrSpec` folds it into the §3.2 blocks. An agent that cannot
 *     become a runnable spec (no primary model) FAILS CLOSED with a 409;
 *  4. every cloud engine in the chain gets its credential from TASK-862's
 *     `ProviderCredentialResolver` (`stt`, provider, tenant) as `provider_overrides`
 *     — the wire entry `apps/stt` already consumes — with each engine's funding
 *     tier derived from the row that served IT (TASK-874: the fallback's funding
 *     is its own, and is what bills the fallback's engine-time). A veto / entitlement refusal propagates (fail
 *     closed); "no credential anywhere" simply yields no entry (the runtime then
 *     proceeds on platform env creds, exactly as the retired
 *     `TenantSttConfig.resolveProviderOverrides` path did).
 *
 * Replaces: `PipelineService.getById/getAll` + `TenantSttConfigService.getEffective`
 * + `resolveProviderOverrides` on the session/batch/compat entry points.
 */
@Injectable()
export class AsrAgentResolverService {
  private readonly logger = new Logger(AsrAgentResolverService.name);

  constructor(
    private readonly agents: AgentResolverService,
    // Optional so positional test construction and a stack without TASK-862's
    // resolver still work: the agent resolver's own `providerOverride` then serves.
    @Optional() private readonly credentials?: ProviderCredentialResolver,
    // TASK-958 — the MASKED connection rows (`id`, `slug`, `isDefault`), which is what the
    // wire key is derived from and what the batch pull enumerates. `@Optional()` and
    // TRAILING so every positional fixture keeps its arity; without it the key falls back
    // to the naming convention and the batch pull carries default rows only — i.e. exactly
    // the pre-958 behaviour, never a wrong credential.
    @Optional() @Inject(IProviderConnectionService) private readonly connections?: IProviderConnectionServicePort,
    // TASK-1002 — tier 2 (the consultation's governing workflow). Optional and TRAILING for the
    // same arity reason as the two above; a `consultationId` without it fails CLOSED (503) rather
    // than silently skipping the workflow the consultation is governed by.
    @Optional() private readonly governingWorkflows?: GoverningWorkflowAsrReader,
    // TASK-1048 (OD-2) — reads `stt.diarization.defaultEmbeddingModelSlug` (tenant → SYSTEM).
    // Optional and TRAILING for the same arity reason; unwired, an agent that needs the platform
    // default simply degrades (`DIARIZATION_MODEL_MISSING`) — never a substituted literal.
    @Optional() private readonly effectiveSettings?: EffectiveSettingsService,
  ) {}

  /**
   * TASK-1002 — first hit wins:
   *
   *  1. an explicit `agentSlug`                                         → `explicit`
   *  2. `consultationId` → its governing workflow's (PINNED version) ONE
   *     `SPEECH_TO_TEXT` `core.agent` node                               → `workflow`
   *     (two such nodes, or a named agent that will not resolve → 409
   *     `WORKFLOW_ASR_AGENT_UNAVAILABLE`; no ASR node → tier 3)
   *  3. the assignment cascade under the consultation's department
   *     (else the input's), with NO selector tags (OD-3 = 3a)            → `department` | `tenant`
   *  4. nothing                                                         → `AGENT_NOT_ASSIGNED`
   */
  async resolve(input: ResolveAsrSpecInput): Promise<ResolvedAsrSession> {
    const { tenantId } = input;
    const { agent, workflowDefinitionSlug, consultation } = await this.resolvePrimary(input);

    // TASK-1048 (OD-1) — every optional stage switched off / fallback skipped while resolving.
    const warnings: AsrSessionWarning[] = [];
    const fallbackAgent = await this.resolveFallbackAgent(agent, tenantId, warnings);
    // TASK-1048 (OD-2) — read only when some chain will actually use it.
    const defaultEmbeddingModel = await this.resolveDefaultEmbeddingModel(tenantId, [agent, fallbackAgent]);

    // TASK-958 — credentials are resolved BEFORE the spec is built, because the spec
    // now CARRIES the identity of the connection each chain authenticates as. The two
    // chains' ASR rows come from `asrChainModels`, the same selection `fallbackOf`
    // applies, so the credential and the core it lands on can never disagree.
    const { providerOverrides, fundingTier, connections } = await this.resolveCredentials(agent, fallbackAgent, tenantId);

    let spec: ResolvedAsrSpec;
    try {
      spec = buildResolvedAsrSpec({
        agent,
        fallbackAgent,
        connections,
        defaultEmbeddingModel,
        onWarning: (warning) => warnings.push(warning),
        // TASK-934 — a decode profile the row declared but this gateway cannot act on
        // (unknown key, wrong type, out of range) is DROPPED, because tuning is
        // `open-to-default` and a session must not fail on it. This is what stops it
        // being silent: §2.2 spent a day on a profile value that never took effect.
        onProfileRejection: ({ modelSlug, rejected }) =>
          this.logger.warn(
            `ASR model '${modelSlug}' declares _metadata.asr members this runtime ignored: ${rejected.join(', ')}. ` +
              `Fix them on the model row — the engine default applies until then.`,
          ),
      });
    } catch (error) {
      // TASK-880 — `code` is the error's own. Since TASK-1048 only a CORE problem (no primary
      // ASR model, a non-SPEECH_TO_TEXT primary) reaches here; optional stages degrade.
      if (error instanceof AsrSpecBuildError) throw new ConflictException({ code: error.code, message: error.message });
      throw error;
    }
    // One WARN line per degradation — codes and agent identity only, no PHI.
    for (const warning of warnings) {
      this.logger.warn({
        message: 'ASR optional stage degraded for this session',
        tenantId,
        code: warning.code,
        stage: warning.stage,
        agentSlug: warning.agentSlug,
        ...(warning.agentVersionNumber !== undefined ? { agentVersionNumber: warning.agentVersionNumber } : {}),
      });
    }

    // TASK-951 — the PRIMARY agent's bound schema. The fallback agent's is deliberately ignored:
    // a session's accepted `context` is decided once, at create, and must not change under the
    // caller when the engine fails over mid-session.
    const contextSchema = agent.compiledConfig.contextSchema ?? undefined;
    return {
      spec,
      ...(providerOverrides ? { providerOverrides } : {}),
      ...(fundingTier ? { fundingTier } : {}),
      ...(contextSchema ? { contextSchema } : {}),
      ...(workflowDefinitionSlug ? { workflowDefinitionSlug } : {}),
      ...(consultation ? { consultationLanguageMode: consultation.spokenLanguageMode } : {}),
      ...(warnings.length > 0 ? { warnings } : {}),
    };
  }

  /**
   * TASK-1048 (owner decision OD-2) — the platform default speaker-embedding model, or `null`.
   *
   * Consulted ONLY when a chain enables diarization and names no embedding model
   * ({@link needsPlatformEmbeddingDefault}). The setting resolves tenant → SYSTEM on absence
   * (`stt.diarization.defaultEmbeddingModelSlug`, `failMode: 'closed'`, no code default — the
   * SYSTEM row is seeded); its slug is then resolved EXACTLY like an agent-named one, as a
   * SPEAKER_EMBEDDING row visible to the tenant. "Unset" (the declared fail-closed raise) and "not
   * visible" both answer `null`, which the builder turns into `DIARIZATION_MODEL_MISSING`; a backend
   * error propagates and is never disguised as "no default".
   */
  private async resolveDefaultEmbeddingModel(tenantId: string, chainAgents: ReadonlyArray<ResolvedAgent | null>): Promise<ResolvedAgentModel | null> {
    if (!chainAgents.some((candidate) => candidate && needsPlatformEmbeddingDefault(candidate))) return null;
    if (!this.effectiveSettings) return null;
    let setting: { value: unknown; sourceScope: string };
    try {
      setting = await this.effectiveSettings.resolveEffective(STT_DIARIZATION_DEFAULT_EMBEDDING_MODEL_SETTING_KEY, { tenantId });
    } catch (error) {
      if (!(error instanceof ArgumentInvalidException)) throw error;
      return null;
    }
    const slug = typeof setting.value === 'string' ? setting.value.trim() : '';
    if (!slug) return null;
    const model = await this.agents.resolveModelBySlug(slug, tenantId, { role: 'embedding', taskType: 'SPEAKER_EMBEDDING' });
    if (!model) {
      this.logger.warn({
        message: 'Platform default speaker-embedding model is not a SPEAKER_EMBEDDING model visible to this tenant; diarization degrades',
        tenantId,
        settingKey: STT_DIARIZATION_DEFAULT_EMBEDDING_MODEL_SETTING_KEY,
        modelSlug: slug,
        sourceScope: setting.sourceScope,
      });
      return null;
    }
    // Which tier supplied it — the spec has no model-provenance field, so it is logged here.
    this.logger.log({
      message: 'ASR diarization uses the platform default speaker-embedding model',
      tenantId,
      modelSlug: model.slug,
      sourceScope: setting.sourceScope,
    });
    return model;
  }

  /**
   * TASK-1004 — the ASR engine CHAIN (model formats, primary first) the agent would run on, for
   * the language-capability catalog and the configuration-time warnings. The SAME agent + fallback
   * resolution as {@link resolve} (explicit slug, else the tenant assignment cascade), minus the
   * credentials and the spec build: judging capability needs neither, and a catalog read must not
   * decrypt anybody's key.
   */
  async resolveChainFormats(input: { tenantId: string; agentSlug?: string | null }): Promise<{ agentSlug: string; formats: string[] }> {
    const { agent } = await this.resolvePrimary({ tenantId: input.tenantId, agentSlug: input.agentSlug ?? null, departmentId: null });
    const fallbackAgent = await this.resolveFallbackAgent(agent, input.tenantId);
    const { primary, fallbackChain } = asrChainModels(agent, fallbackAgent);
    const formats: string[] = [];
    for (const model of [primary, ...fallbackChain]) {
      if (model?.format && !formats.includes(model.format)) formats.push(model.format);
    }
    return { agentSlug: agent.slug, formats };
  }

  /**
   * The agent a workflow's single SPEECH_TO_TEXT node NAMES (tier 2 and the TASK-1042 `workflowSlug`
   * arm), resolved fail-closed: a binding that can no longer serve is the named 409, never a quiet
   * chain mark (owner OD-1).
   */
  private async resolveWorkflowNamedAgent(
    tenantId: string,
    named: GoverningWorkflowAsrAgent,
    context: { consultationId?: string | null; workflowSlug?: string | null },
  ): Promise<{ agent: ResolvedAgent; workflowDefinitionSlug: string }> {
    let resolved: ResolvedAgent;
    try {
      resolved = await this.agents.resolve({
        tenantId,
        task: AgentTask.SPEECH_TO_TEXT,
        agentSlug: named.agentSlug,
        departmentId: null,
        // Owner OD-1 — the workflow NAMED this agent, so a binding that can no longer serve
        // (e.g. a connection disabled after publish) is the named 409 below, not a quiet
        // chain mark.
        primaryBinding: 'fail-closed',
      });
    } catch (error) {
      // Only the resolver's own refusals (404 / 400 / 409 / 503) are "unavailable"; a backend
      // fault propagates and is never disguised as a configuration answer.
      if (!(error instanceof HttpException)) throw error;
      throw workflowAsrAgentUnavailable({
        reason: 'unavailable',
        workflowDefinitionSlug: named.workflowDefinitionSlug,
        agentSlug: named.agentSlug,
        cause: error.message,
      });
    }
    this.logger.log({
      message: context.workflowSlug
        ? 'ASR agent chosen by the standalone workflow the session feeds, ahead of the assignment cascade'
        : 'ASR agent chosen by the consultation’s governing workflow, ahead of the assignment cascade',
      tenantId,
      ...(context.consultationId ? { consultationId: context.consultationId } : {}),
      workflowDefinitionSlug: named.workflowDefinitionSlug,
      nodeId: named.nodeId,
      agentSlug: resolved.slug,
    });
    return { agent: { ...resolved, source: 'workflow' }, workflowDefinitionSlug: named.workflowDefinitionSlug };
  }

  /** TASK-1002 — tiers 1 → 3 for the PRIMARY agent. See {@link resolve}. */
  private async resolvePrimary(
    input: ResolveAsrSpecInput,
  ): Promise<{ agent: ResolvedAgent; workflowDefinitionSlug?: string; consultation?: ConsultationAsrContext }> {
    const { tenantId } = input;
    const cascade = (departmentId: string | null) =>
      this.agents.resolve({
        tenantId,
        task: AgentTask.SPEECH_TO_TEXT,
        agentSlug: input.agentSlug ?? null,
        departmentId,
        // TASK-958 F11 — a chain plane. A primary whose named connection cannot serve
        // is stamped on the core and left without a credential (F7), so `apps/stt` fails
        // that chain closed and switches to the fallback; a 409 here would take the
        // fallback out with it.
        primaryBinding: 'mark',
      });

    // TASK-1042 (C1) — a session opened for a STANDALONE workflow run: that workflow's single
    // SPEECH_TO_TEXT node, the same "workflow wins" rule as tier 2, else the assignment cascade.
    if (!input.agentSlug && input.workflowSlug) {
      if (!this.governingWorkflows) {
        throw new ServiceUnavailableException('Workflow-governed ASR resolution is not configured on this gateway');
      }
      const workflow = await this.governingWorkflows.readPublishedWorkflow(tenantId, input.workflowSlug);
      if (!workflow) throw new NotFoundException(`Workflow '${input.workflowSlug}' not found.`);
      const named = await this.governingWorkflows.findAsrAgent(tenantId, workflow);
      if (named) return this.resolveWorkflowNamedAgent(tenantId, named, { workflowSlug: input.workflowSlug });
      return { agent: await cascade(input.departmentId ?? null) };
    }

    // Tier 1, and every caller without a consultation: byte-identical to the pre-1002 call.
    if (input.agentSlug || !input.consultationId) {
      // TASK-1004 — the one exception: an explicit agent on a consultation-bound request that
      // declared no language reads the consultation ONCE for its mode (never for the agent).
      const consultation =
        input.agentSlug && input.consultationId && input.inheritConsultationLanguage && this.governingWorkflows
          ? await this.governingWorkflows.readConsultation(tenantId, input.consultationId)
          : undefined;
      return { agent: await cascade(input.departmentId ?? null), ...(consultation ? { consultation } : {}) };
    }

    if (!this.governingWorkflows) {
      throw new ServiceUnavailableException('Consultation-governed ASR resolution is not configured on this gateway');
    }
    const consultation = await this.governingWorkflows.readConsultation(tenantId, input.consultationId);

    // Tier 2 — the governing workflow's one SPEECH_TO_TEXT node.
    const workflow = await this.governingWorkflows.readGoverningWorkflow(tenantId, consultation.metadata);
    const named = workflow ? await this.governingWorkflows.findAsrAgent(tenantId, workflow) : null;
    if (named) {
      return { ...(await this.resolveWorkflowNamedAgent(tenantId, named, { consultationId: input.consultationId })), consultation };
    }

    // Tier 3 (→ 4) — the assignment cascade, under the CONSULTATION's department.
    return { agent: await cascade(consultation.departmentId ?? null), consultation };
  }

  /**
   * TASK-861 follow-up — the batch worker's whole-service credential pull
   * (`GET internal/stt/provider-overrides?tenantId=`), successor of the
   * deprecated `TenantSttConfigService.resolveProviderOverrides`.
   *
   * The Dramatiq message carries `resolved_spec` and never a key, and the
   * worker names no provider when it pulls, so every cloud STT provider the
   * platform knows is resolved through the ONE resolver exactly as
   * `resolveCredentials` does for a session's chain — tenant row → SYSTEM
   * fallback, `funding` derived from the row that served — keyed as the
   * `apps/stt` loaders read it.
   *
   * Fail-closed PER PROVIDER, not per pull: a veto (`ProviderVetoedException`,
   * a DISABLED tenant row) or an entitlement refusal of the platform default
   * (`QuotaExceededException`) leaves that provider OUT of the map. No tier
   * serves it, and every STT cloud loader is BYOK-only with no env key, so a
   * job on that engine fails at load rather than on another tier's credential
   * — while a tenant that vetoed one provider still transcribes on another.
   * (A session names its chain, so `resolve` lets the veto propagate as a 409;
   * a whole-service map cannot tell which provider the job runs on.) A
   * backend fault propagates — it is never disguised as "no credential".
   */
  async resolveProviderOverrides(tenantId: string): Promise<SttProviderOverrides> {
    if (!this.credentials) {
      throw new ServiceUnavailableException('Provider credential resolution is not configured on this gateway');
    }
    const overrides: SttProviderOverrides = {};
    const identities = new ConnectionIdentityLookup(this.connections, 'stt', tenantId);
    // TASK-1021 — the self-host engines too: a batch job whose spec names `vllm` needs its entry.
    for (const provider of [...CLOUD_BYO_PROVIDERS.stt, ...(PLATFORM_SELF_HOST_PROVIDERS.stt ?? [])]) {
      try {
        const binding = await this.credentials.resolve('stt', provider, tenantId);
        if (binding) overrides[provider] = binding.override;
        // TASK-958 F8 — and every NAMED SIBLING of that provider. Resolving by provider
        // NAME can only ever answer with the tenant's DEFAULT row, so a map built from
        // the provider list alone cannot serve a job whose spec names a sibling: the
        // loader would miss its declared key and (before the readers were made strict)
        // transcribe on the default account. The worker names no provider when it pulls,
        // so the map has to cover every connection a spec it is paired with can name.
        for (const row of await identities.siblings(provider)) {
          const named = await this.credentials.resolve('stt', provider, tenantId, { connectionId: row.id });
          if (named) overrides[providerOverrideKey(provider, row)] = named.override;
        }
      } catch (error) {
        if (!(error instanceof ProviderVetoedException) && !(error instanceof QuotaExceededException)) throw error;
        this.logger.warn({
          message: 'STT provider credential refused; provider left out of the batch pull',
          tenantId,
          provider,
          reason: error instanceof ProviderVetoedException ? 'vetoed' : 'platform-default-not-entitled',
        });
      }
    }
    return overrides;
  }

  /**
   * The primary's `parameters.fallback.agentSlug`, resolved — or `null`, and when the agent named
   * one that cannot serve, a `FALLBACK_UNRUNNABLE` warning (TASK-1048). Screened HERE, before the
   * credentials are resolved, so a fallback that will never run never has a credential resolved for
   * it and the model chain that replaces it keeps its own binding.
   */
  private async resolveFallbackAgent(agent: ResolvedAgent, tenantId: string, warnings: AsrSessionWarning[] = []): Promise<ResolvedAgent | null> {
    const slug = rec(rec(agent.compiledConfig.parameters).fallback).agentSlug;
    if (typeof slug !== 'string' || slug.length === 0 || slug === agent.slug) return null;
    let fallback: ResolvedAgent;
    try {
      fallback = await this.agents.resolve({ tenantId, task: AgentTask.SPEECH_TO_TEXT, agentSlug: slug, departmentId: null, primaryBinding: 'mark' });
    } catch (error) {
      this.logger.warn({
        message: 'ASR fallback agent did not resolve; continuing without it',
        tenantId,
        agentSlug: agent.slug,
        fallbackAgentSlug: slug,
        error: error instanceof Error ? error.message : String(error),
      });
      warnings.push(asrDegradation('FALLBACK_UNRUNNABLE', { slug }));
      return null;
    }
    if (!fallback) {
      warnings.push(asrDegradation('FALLBACK_UNRUNNABLE', { slug }));
      return null;
    }
    if (fallback.task !== 'SPEECH_TO_TEXT' || !fallback.models.some((m) => m.role === 'primary')) {
      warnings.push(asrDegradation('FALLBACK_UNRUNNABLE', fallback));
      return null;
    }
    return fallback;
  }

  /**
   * One credential per CHAIN POSITION — the primary's AND the fallback's, each with
   * the funding DERIVED from the row that served it.
   *
   * TASK-958 turned "per distinct cloud PROVIDER" into "per chain position": a tenant
   * may hold two accounts of one vendor, so two chains naming `openai` are two
   * credentials, not one shared entry, and the map is keyed by CONNECTION KEY rather
   * than by provider id (which they share).
   *
   * TASK-874 — both entries matter, because fallback to the platform default is
   * a metered HA capability: `apps/stt` bills engine-time by looking each served
   * engine's own entry up. `fundingTier` is therefore resolved from the PRIMARY
   * engine's provider SPECIFICALLY, not first-resolved-wins over the chain. The
   * old `??=` reported the FALLBACK's tier under the primary's name for the
   * commonest HA shape — a self-hosted primary with a cloud fallback contributes
   * no provider of its own, so the fallback was simply first in the list.
   */
  private async resolveCredentials(
    agent: ResolvedAgent,
    fallbackAgent: ResolvedAgent | null,
    tenantId: string,
  ): Promise<{
    providerOverrides?: SttProviderOverrides;
    fundingTier?: ProviderFunding;
    connections?: { primary?: AsrConnectionBinding | null; fallback?: AsrConnectionBinding | null };
  }> {
    const chain = asrChainModels(agent, fallbackAgent);
    const overrides: SttProviderOverrides = {};
    const bindings: { primary?: AsrConnectionBinding | null; fallback?: AsrConnectionBinding | null } = {};
    const identities = new ConnectionIdentityLookup(this.connections, 'stt', tenantId);

    for (const position of ['primary', 'fallback'] as const) {
      const model = chain[position];
      const provider = model?.provider ?? null;
      // TASK-1021 — a platform self-host ENGINE (`vllm`) rides the same plane as a cloud BYO vendor:
      // its SYSTEM connection row carries WHERE the engine lives and how much it may take, which is
      // exactly what `apps/stt`'s loader reads off the entry. The spec stays credential-free.
      if (!model || !provider || !(isCloudByoProvider('stt', provider) || isPlatformSelfHostProvider('stt', provider))) continue;

      // TASK-958 D-3 — the model row names the account; a SYSTEM catalogue row names
      // none and keeps the provider-NAME cascade (the tenant's DEFAULT connection).
      const connectionId = model.sourceConnectionId ?? null;
      const bound = connectionId ? await identities.byId(connectionId) : null;
      const binding = this.credentials
        ? await (connectionId
            ? this.credentials.resolve('stt', provider, tenantId, { connectionId })
            : this.credentials.resolve('stt', provider, tenantId))
        : null;
      const entry = binding?.override ?? (this.credentials ? null : (this.overrideFromAgents(provider, agent, fallbackAgent) ?? null));
      if (!entry) {
        // TASK-958 F7 — a NAMED connection that answered nothing is disabled, keyless or
        // gone. The chain still DECLARES it, and the map gets no entry for it: `apps/stt`
        // then reads the declared key, misses and fails that chain closed. Leaving the
        // core silent is what made this dangerous — with no key the loader falls back to
        // the provider id, which the OTHER chain (or the batch pull) may well have filled
        // with the tenant's DEFAULT account, lending a credential to a binding that never
        // named it. The key is always namespaced, so it can never collide with one.
        if (connectionId) {
          bindings[position] = {
            connectionId,
            ...(bound?.slug ? { connectionSlug: bound.slug } : {}),
            connectionKey: failedBindingKey(provider, bound?.slug, connectionId),
          };
        }
        continue;
      }

      // D-4/F6 — the key the loaders read their entry under: the provider id for the
      // tenant's DEFAULT row and for a platform row (which keeps every pre-958 payload
      // byte-identical), `provider:slug` for a named sibling. An UNBOUND resolve was
      // answered by the default or the platform, so it always keeps the provider id.
      const slug = typeof entry.connection_slug === 'string' ? entry.connection_slug : provider;
      const key = connectionId ? providerOverrideKey(provider, { slug, isDefault: bound?.isDefault }) : provider;
      overrides[key] = entry;
      const rowId = binding?.connectionId ?? (typeof entry.connection_id === 'string' ? entry.connection_id : null);
      // The core carries the fields only when the row actually identified itself; a
      // one-hop override from an agent resolved without TASK-862's plane may not.
      if (rowId) bindings[position] = { connectionId: rowId, connectionSlug: slug, connectionKey: key };
    }

    if (Object.keys(overrides).length === 0) return { ...(bindings.primary || bindings.fallback ? { connections: bindings } : {}) };
    const primaryKey = bindings.primary?.connectionKey ?? chain.primary?.provider ?? null;
    const fundingTier = primaryKey ? overrides[primaryKey]?.funding : undefined;
    return {
      providerOverrides: overrides,
      ...(fundingTier ? { fundingTier } : {}),
      ...(bindings.primary || bindings.fallback ? { connections: bindings } : {}),
    };
  }

  /** Fallback when TASK-862's resolver is not wired: the override the agent resolver already derived. */
  private overrideFromAgents(provider: string, agent: ResolvedAgent, fallbackAgent: ResolvedAgent | null): SttProviderOverrides[string] | undefined {
    for (const candidate of [agent, fallbackAgent]) {
      const override = candidate?.providerOverride;
      if (override && override.provider === provider) {
        const { provider: _provider, ...entry } = override;
        return entry as SttProviderOverrides[string];
      }
    }
    return undefined;
  }
}
