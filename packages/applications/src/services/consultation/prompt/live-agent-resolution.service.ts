/**
 * `ILiveAgentResolver` implementation.
 *
 * Composes the pieces the live loop must NOT know about: the consultation's
 * department, the capability-keyed prompt chain, and the agent row's
 * `toolConfig` / `llmOverrides`. What comes back is one immutable
 * {@link FrozenLiveAgentSnapshot} that governs a whole session.
 *
 * TOTALITY IS THE CONTRACT. Neither method may throw. A live consultation must
 * never be failed by a prompt-resolution error, so every failure path lands on
 * the code-default snapshot (the in-code constants), whose bytes are proven
 * identical to the seeded SYSTEM default by paired sha256 guards — which is the
 * only reason "fail-open" is acceptable on a clinical surface: it degrades to
 * IDENTICAL behavior, not to different behavior.
 */

import { Injectable, Logger } from '@nestjs/common';
import {
  AiModelRepository,
  ConsultationRepository,
  DepartmentAgentRepository,
  ModelTaskType,
  PromptTemplateRepository,
  PromptVersionRepository,
  ResourceStatusType,
} from '@arcaai/domains';

import {
  DEFAULT_LIVE_TOOL_PLAN,
  normalizeToolPlan,
  type FrozenLiveAgentSnapshot,
  type ILiveAgentResolver,
  type PersistedLiveAgentLineage,
} from '../live-documentation/live-agent.port';
import { LIVE_SOAP_STABLE_SYSTEM_PREFIX, LIVE_SOAP_SYSTEM_PROMPT } from '../live-documentation/live-documentation.service';
import { PromptResolutionService } from './prompt-resolution.service';

@Injectable()
export class LiveAgentResolutionService implements ILiveAgentResolver {
  private readonly logger = new Logger(LiveAgentResolutionService.name);

  constructor(
    private readonly consultationRepository: ConsultationRepository,
    private readonly promptResolutionService: PromptResolutionService,
    private readonly departmentAgentRepository: DepartmentAgentRepository,
    private readonly promptVersionRepository: PromptVersionRepository,
    private readonly aiModelRepository: AiModelRepository,
    private readonly promptTemplateRepository: PromptTemplateRepository,
  ) {}

  async resolveForSession(input: { consultationId: string; tenantId: string }): Promise<FrozenLiveAgentSnapshot> {
    try {
      const departmentId = await this.resolveDepartmentId(input.consultationId, input.tenantId);

      const resolved = await this.promptResolutionService.resolve({
        promptType: 'live',
        tenantId: input.tenantId,
        ...(departmentId ? { departmentId } : {}),
      });

      // Tier 3 (`code-default`) carries no content by design — the absence IS
      // the signal that the in-code constants apply.
      if (resolved.resolvedFrom === 'code-default' || !resolved.content) {
        return this.codeDefault();
      }

      // The agent row is read ONLY when the agent tier actually resolved, so a
      // default-tier session costs no extra query.
      const agent = resolved.resolvedAgentId ? await this.safeFindAgent(resolved.resolvedAgentId) : null;

      return {
        resolvedFrom: resolved.resolvedFrom === 'agent' ? 'agent' : 'default',
        agentId: agent?.id ?? null,
        agentName: agent?.name ?? null,
        promptTemplateId: resolved.promptId,
        promptVersionNumber: resolved.resolvedVersionNumber ?? null,
        stableUserPrefix: resolved.content,
        systemPrompt: await this.systemPromptFor(resolved.promptId),
        toolPlan: normalizeToolPlan(agent?.toolConfig ?? null),
        liveLlm: await this.resolveLiveLlm(agent?.llmOverrides ?? null),
        frozenAt: new Date().toISOString(),
      };
    } catch (error) {
      this.logger.error({
        message: 'Live-agent resolution failed — serving the code-default snapshot (fail-open)',
        consultationId: input.consultationId,
        error: error instanceof Error ? error.message : String(error),
      });
      return this.codeDefault();
    }
  }

  /**
   * Crash-recovery tier 2: rebuild a snapshot from a durable lineage block by
   * re-reading the PINNED, IMMUTABLE `PromptVersion`. Because the version is
   * pinned (never "latest"), the rebuild is byte-identical to what the session
   * was serving before the crash.
   *
   * Returns null — not the code-default — when the pin can no longer be
   * honored, so the caller falls through to a FRESH resolve rather than
   * silently downgrading a governed session to the constants.
   */
  async rehydrateFromLineage(input: { tenantId: string; lineage: PersistedLiveAgentLineage }): Promise<FrozenLiveAgentSnapshot | null> {
    const { lineage } = input;
    if (!lineage?.promptTemplateId || lineage.promptVersionNumber === null || lineage.promptVersionNumber === undefined) return null;

    try {
      const version = await this.promptVersionRepository.findByVersionNumber(lineage.promptTemplateId, lineage.promptVersionNumber);
      if (!version?.content) return null;

      const agent = lineage.agentId ? await this.safeFindAgent(lineage.agentId) : null;

      return {
        resolvedFrom: lineage.resolvedFrom === 'agent' ? 'agent' : 'default',
        agentId: lineage.agentId,
        agentName: lineage.agentName ?? agent?.name ?? null,
        promptTemplateId: lineage.promptTemplateId,
        promptVersionNumber: version.versionNumber,
        stableUserPrefix: version.content,
        systemPrompt: await this.systemPromptFor(lineage.promptTemplateId),
        toolPlan: normalizeToolPlan(agent?.toolConfig ?? null),
        // The model pair was FROZEN at the original session start; re-using the
        // recorded pair keeps the recovered session on the same model rather
        // than re-deriving one that may since have changed.
        liveLlm: lineage.liveLlm ?? null,
        frozenAt: lineage.frozenAt ?? new Date().toISOString(),
      };
    } catch (error) {
      this.logger.warn({
        message: 'Failed to re-pin the live agent from durable lineage — falling through to a fresh resolve',
        promptTemplateId: lineage.promptTemplateId,
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  }

  // =========================================================================
  // Internals
  // =========================================================================

  private codeDefault(): FrozenLiveAgentSnapshot {
    return {
      resolvedFrom: 'code-default',
      agentId: null,
      agentName: null,
      promptTemplateId: null,
      promptVersionNumber: null,
      stableUserPrefix: LIVE_SOAP_STABLE_SYSTEM_PREFIX,
      systemPrompt: LIVE_SOAP_SYSTEM_PROMPT,
      toolPlan: DEFAULT_LIVE_TOOL_PLAN,
      liveLlm: null,
      frozenAt: new Date().toISOString(),
    };
  }

  /**
   * The consultation's department, with a tenant guard: a cross-tenant id is
   * treated as "no department" (never as an error, and never as a way to reach
   * another tenant's agent bindings).
   */
  private async resolveDepartmentId(consultationId: string, tenantId: string): Promise<string | null> {
    try {
      const consultation = await this.consultationRepository.findById(consultationId);
      if (!consultation || consultation.tenantId !== tenantId) return null;
      return consultation.departmentId ?? null;
    } catch (error) {
      this.logger.warn({
        message: 'Failed to read the consultation for live-agent resolution — proceeding without a department',
        consultationId,
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  }

  private async safeFindAgent(agentId: string) {
    try {
      return await this.departmentAgentRepository.findById(agentId);
    } catch {
      return null;
    }
  }

  /**
   * The system-role string served for this session (step 4).
   *
   * Reads the resolved template's `metaData.promptConfig.systemPrompt` —
   * surfaced via a hand-authored accessor on `PromptTemplateEntity` (mirrors
   * the `DepartmentAgentEntity` / `AiModelEntity` precedent: `IBaseEntity.metaData`
   * is declared but not wired on the abstract base, so each entity that needs it
   * wires its own `setProperty`-routed getter/setter) — and falls back to the
   * in-code `LIVE_SOAP_SYSTEM_PROMPT` constant when a custom prompt is absent.
   *
   * `metaData` is untrusted JSON (admin-writable, no schema enforced at the DB
   * layer): defensively reject anything that isn't `{ promptConfig: { systemPrompt: <non-empty string> } }`
   * and fall back silently. A malformed value must never throw into a live
   * consultation — the live path is fail-open by design, same as every other
   * branch of this resolver.
   */
  private async systemPromptFor(promptTemplateId: string): Promise<string> {
    try {
      const template = await this.promptTemplateRepository.findById(promptTemplateId);
      return this.extractCustomSystemPrompt(template?.metaData) ?? LIVE_SOAP_SYSTEM_PROMPT;
    } catch (error) {
      this.logger.warn({
        message: 'Failed to resolve a custom system prompt for the live template — falling back to the code-default system prompt',
        promptTemplateId,
        error: error instanceof Error ? error.message : String(error),
      });
      return LIVE_SOAP_SYSTEM_PROMPT;
    }
  }

  /**
   * Defensive extraction of `metaData.promptConfig.systemPrompt`. `metaData` is
   * JSON with no DB-enforced shape, so every level is validated: not an
   * object, an array, missing, or the wrong type at any step ⇒ `null` (the
   * caller's cue to fall back to the code-default constant).
   */
  private extractCustomSystemPrompt(metaData: unknown): string | null {
    if (!metaData || typeof metaData !== 'object' || Array.isArray(metaData)) return null;

    const promptConfig = (metaData as Record<string, unknown>).promptConfig;
    if (!promptConfig || typeof promptConfig !== 'object' || Array.isArray(promptConfig)) return null;

    const systemPrompt = (promptConfig as Record<string, unknown>).systemPrompt;
    if (typeof systemPrompt !== 'string' || systemPrompt.trim().length === 0) return null;

    return systemPrompt;
  }

  /**
   * Freeze the agent's `llmOverrides.live` into a concrete `{provider, model}`.
   *
   * FAIL-OPEN (live posture): an unknown, disabled, or wrong-task slug logs and
   * degrades to null, which puts the session back on the per-flush tenant
   * `smr.live` AiTaskDefault — today's behavior. Contrast the finalize side,
   * where model SELECTION is fail-closed.
   */
  private async resolveLiveLlm(llmOverrides: unknown): Promise<{ provider: string; model: string } | null> {
    const slug = (llmOverrides as { live?: { aiModelSlug?: unknown } } | null | undefined)?.live?.aiModelSlug;
    if (typeof slug !== 'string' || slug.trim().length === 0) return null;

    try {
      const models = await this.aiModelRepository.findAll({ filters: { slug, resourceStatus: ResourceStatusType.ENABLED } });
      const model = models[0];
      if (!model || model.taskType !== ModelTaskType.TEXT_GENERATION || !model.sourceUri) {
        this.logger.warn({
          message: 'Agent llmOverrides.live names an unusable model — falling back to the tenant smr.live default',
          slug,
        });
        return null;
      }
      // The catalog seeds `azure`; SMR registers it as `azure-openai`
      // (mirrors HarnessPolicyService.resolveSmrSelection).
      const provider = model.provider === 'azure' ? 'azure-openai' : (model.provider ?? '');
      if (!provider) return null;
      return { provider, model: model.sourceUri };
    } catch (error) {
      this.logger.warn({
        message: 'Failed to resolve the agent live-LLM override — falling back to the tenant smr.live default',
        slug,
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  }
}
