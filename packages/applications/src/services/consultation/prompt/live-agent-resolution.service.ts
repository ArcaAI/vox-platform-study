/**
 * `ILiveAgentResolver` implementation.
 *
 * Composes the pieces the live loop must NOT know about: the consultation's
 * department and the capability-keyed prompt chain. What comes back is one
 * immutable {@link FrozenLiveAgentSnapshot} that governs a whole session.
 *
 * ## Two fields that used to come off a `DepartmentAgent` row
 *
 * `toolPlan` was `DepartmentAgent.toolConfig`, normalised. Its successor is not
 * another config blob but the GRAPH: in the workflow substrate "is NER on for
 * this session" is answered by whether the tenant's realtime lane contains an
 * entity-extraction node, and `LiveDocumentationService.ensureLaneResolved`
 * resolves that lane independently of this snapshot. The snapshot therefore
 * carries `DEFAULT_LIVE_TOOL_PLAN` — exactly what a tenant with no `toolConfig`
 * always got — for the LEGACY flush path that still reads it.
 *
 * `liveLlm` was `DepartmentAgent.llmOverrides.live`, frozen to a
 * `{provider, model}` pair. Its successor is a per-node `llmBinding`
 * which has not landed. `null` here is not a gap: it puts the
 * session on the per-flush assigned `TEXT_GENERATION` agent, which is the
 * tenant → SYSTEM cascade and was already the behaviour for every session whose
 * agent carried no override. The fail-OPEN posture that made the override safe
 * on the live path is preserved by construction — there is nothing left to fail.
 *
 * TOTALITY IS THE CONTRACT. Neither method may throw. A live consultation must
 * never be failed by a prompt-resolution error, so every failure path lands on
 * the code-default snapshot (the in-code constants), whose bytes are proven
 * identical to the seeded SYSTEM default by paired sha256 guards — which is the
 * only reason "fail-open" is acceptable on a clinical surface: it degrades to
 * IDENTICAL behavior, not to different behavior.
 */

import { Injectable, Logger, Optional } from '@nestjs/common';
import { ConsultationRepository, PromptTemplateRepository, PromptVersionRepository } from '@arcaai/domains';

import {
  DEFAULT_LIVE_TOOL_PLAN,
  type FrozenLiveAgentSnapshot,
  type ILiveAgentResolver,
  type PersistedLiveAgentLineage,
} from '../live-documentation/live-agent.port';
import { LIVE_DOCUMENT_STABLE_SYSTEM_PREFIX, LIVE_DOCUMENT_SYSTEM_PROMPT } from '../live-documentation/live-documentation.service';
import { readRecordedVisitType } from '../consultation/open-markers';
import { DEFAULT_VISIT_TYPE_SERVICE, VisitTypeService } from '../visit-type/visit-type.service';
import { PromptResolutionService } from './prompt-resolution.service';

@Injectable()
export class LiveAgentResolutionService implements ILiveAgentResolver {
  private readonly logger = new Logger(LiveAgentResolutionService.name);

  constructor(
    private readonly consultationRepository: ConsultationRepository,
    private readonly promptResolutionService: PromptResolutionService,
    private readonly promptVersionRepository: PromptVersionRepository,
    private readonly promptTemplateRepository: PromptTemplateRepository,
    // Kept for constructor-arity compatibility with positional fixtures. Since
    // TASK-882 the live chain has no visit-type axis (the `(live, visitType)`
    // binding retired with the `consultation.visitTypes` key), so nothing here
    // reads it.
    @Optional() private readonly visitTypes?: VisitTypeService,
  ) {}

  async resolveForSession(input: { consultationId: string; tenantId: string; visitType?: string | null }): Promise<FrozenLiveAgentSnapshot> {
    try {
      const consultation = await this.readConsultation(input.consultationId, input.tenantId);

      // The visit type the governing graph branches on (`trigger.context.visit_type`), derived
      // exactly as the live session derives its own: the RECORDED value first, the parent link
      // second. Without it the per-turn agent tier served the graph's FIRST per-turn node to
      // every consultation (measured 2026-09-13: revisits ran the New Referral prompt).
      const visitType =
        input.visitType ??
        (consultation
          ? (this.visitTypes ?? DEFAULT_VISIT_TYPE_SERVICE).forConsultation(input.tenantId, {
              isFollowUp: Boolean(consultation.parentConsultationId),
              recorded: readRecordedVisitType(consultation.metadata),
            }).key
          : null);

      const resolved = await this.promptResolutionService.resolve({
        promptType: 'live',
        tenantId: input.tenantId,
        ...(consultation?.departmentId ? { departmentId: consultation.departmentId } : {}),
        ...(visitType ? { visitType } : {}),
      });

      // Tier 3 (`code-default`) carries no content by design — the absence IS
      // the signal that the in-code constants apply.
      if (resolved.resolvedFrom === 'code-default' || !resolved.content) {
        return this.codeDefault();
      }

      return {
        resolvedFrom: resolved.resolvedFrom === 'agent' ? 'agent' : 'default',
        // The workflow NODE id that supplied the prompt, when the node tier
        // resolved. `agentName` has no successor — a node has an id and a type,
        // and inventing a display name for it would be a second thing to keep
        // in step with the graph.
        agentId: resolved.resolvedAgentId ?? null,
        agentName: null,
        promptTemplateId: resolved.promptId,
        promptVersionNumber: resolved.resolvedVersionNumber ?? null,
        stableUserPrefix: resolved.content,
        systemPrompt: await this.systemPromptFor(resolved.promptId),
        toolPlan: DEFAULT_LIVE_TOOL_PLAN,
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

      return {
        resolvedFrom: lineage.resolvedFrom === 'agent' ? 'agent' : 'default',
        agentId: lineage.agentId,
        agentName: lineage.agentName ?? null,
        promptTemplateId: lineage.promptTemplateId,
        promptVersionNumber: version.versionNumber,
        stableUserPrefix: version.content,
        systemPrompt: await this.systemPromptFor(lineage.promptTemplateId),
        toolPlan: DEFAULT_LIVE_TOOL_PLAN,
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
      stableUserPrefix: LIVE_DOCUMENT_STABLE_SYSTEM_PREFIX,
      systemPrompt: LIVE_DOCUMENT_SYSTEM_PROMPT,
      toolPlan: DEFAULT_LIVE_TOOL_PLAN,
      frozenAt: new Date().toISOString(),
    };
  }

  /**
   * The consultation's department, with a tenant guard: a cross-tenant id is
   * treated as "no department" (never as an error, and never as a way to reach
   * another tenant's agent bindings).
   */
  /**
   * The consultation's two resolution axes — its department and its follow-up
   * link — read in ONE lookup.
   *
   * It used to return the department id alone; the visit type needs
   * `parentConsultationId` off the same row, and a second read for one boolean
   * on the session-start path would be a wasted round trip.
   *
   * Null on a miss, a cross-tenant id, or a lookup error: live resolution
   * proceeds with no department and no visit-type opinion rather than failing,
   * which is this service's documented fail-open posture.
   */
  private async readConsultation(
    consultationId: string,
    tenantId: string,
  ): Promise<{ departmentId: string | null; parentConsultationId: string | null; metadata: unknown } | null> {
    try {
      const consultation = await this.consultationRepository.findById(consultationId);
      if (!consultation || consultation.tenantId !== tenantId) return null;
      return {
        departmentId: consultation.departmentId ?? null,
        parentConsultationId: consultation.parentConsultationId ?? null,
        metadata: (consultation as { metadata?: unknown }).metadata ?? null,
      };
    } catch (error) {
      this.logger.warn({
        message: 'Failed to read the consultation for live-agent resolution — proceeding without a department',
        consultationId,
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  }

  /**
   * The system-role string served for this session.
   *
   * Reads the resolved template's `metaData.promptConfig.systemPrompt` —
   * surfaced via a hand-authored accessor on `PromptTemplateEntity` (mirrors
   * the `DepartmentAgentEntity` / `AiModelEntity` precedent: `IBaseEntity.metaData`
   * is declared but not wired on the abstract base, so each entity that needs it
   * wires its own `setProperty`-routed getter/setter) — and falls back to the
   * in-code `LIVE_DOCUMENT_SYSTEM_PROMPT` constant when a custom prompt is absent.
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
      return this.extractCustomSystemPrompt(template?.metaData) ?? LIVE_DOCUMENT_SYSTEM_PROMPT;
    } catch (error) {
      this.logger.warn({
        message: 'Failed to resolve a custom system prompt for the live template — falling back to the code-default system prompt',
        promptTemplateId,
        error: error instanceof Error ? error.message : String(error),
      });
      return LIVE_DOCUMENT_SYSTEM_PROMPT;
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
}
