/**
 * The Prompt Inspector: a DRY RUN of the prompt a real consultation would send, without calling
 * any model.
 *
 *  - the messages come from the SAME assembly the harness sends (`HarnessInternalService`), shaped
 *    for the requested phase, optionally composing a named agent's instruction;
 *  - the locality is the one the call would be stamped with: the model the tenant's text selection
 *    resolves (or the named agent's), through the gateway's own locality rule — unknown is cloud;
 *  - the provider view runs guardrail's PII detection over the messages and pseudonymizes them
 *    with the SAME `[<LABEL>_<n>]` grammar `apps/text` applies to a cloud call, plus the platform
 *    token sentence `apps/text` appends.
 *
 * The response carries the consultation's PHI (the messages ARE the prompt), so every preview is
 * audited (`forceAuditLog`) and another tenant's consultation is a 404.
 */
import { BadRequestException, Inject, Injectable, Logger, NotFoundException, Optional } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { ClsService } from 'nestjs-cls';
import { AgentRepository, AgentTask, ConsultationRepository, ResourceType, SysEventType } from '@arcaai/domains';
import type { ComposableResolvedPrompt } from '@arcaai/workflow-contract';
import { BaseService } from '../../../common/base.service';
import { assertParentInScope } from '../../../common/tenant-guards';
import { IActiveUserContext } from '../../../interfaces';
import { HarnessPolicyService } from '../../harness-policy/harness-policy.service';
import { EffectiveSettingsService } from '../../settings-registry/effective-settings.service';
import { KnownPhiService } from '../../text-request/known-phi.service';
import { providerLocality } from '../../text-request/provider-locality';
import { HarnessInternalService } from '../harness/harness-internal.service';
import { resolvePlatformOutputLanguage } from '../summary/platform-output-language';
import { PromptPreviewRequest, PromptPreviewResponse } from './dto/prompt-preview.dto';
import { GuardrailPiiDetector } from './guardrail-pii-detector';
import { PreviewPseudonymizer, type PreviewPiiSpan } from './preview-pseudonymizer';

/**
 * Appended by `apps/text` to the provider-facing system prompt of every CLOUD call
 * (`services/egress.py::PLATFORM_TOKEN_SENTENCE`); repeated here so the provider view is exact.
 */
export const PLATFORM_TOKEN_SENTENCE =
  'Bracketed tokens such as [PERSON_1] are placeholders for redacted identifiers: copy each one verbatim wherever it is needed, and never expand, alter or guess it.';

/** How `apps/text` joins the texts of one request for the inbound screen. */
const SEGMENT_SEPARATOR = '\n\n';

/** A rough, documented estimate: ~4 characters per token. */
function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

@Injectable()
export class PromptPreviewService extends BaseService {
  private readonly logger = new Logger(PromptPreviewService.name);

  constructor(
    private readonly consultationRepository: ConsultationRepository,
    private readonly agentRepository: AgentRepository,
    private readonly harnessInternal: HarnessInternalService,
    private readonly detector: GuardrailPiiDetector,
    protected override readonly eventEmitter: EventEmitter2,
    protected override readonly clsService: ClsService<IActiveUserContext>,
    @Optional() @Inject(HarnessPolicyService) private readonly harnessPolicy?: HarnessPolicyService,
    @Optional() @Inject(KnownPhiService) private readonly knownPhi?: KnownPhiService,
    @Optional() @Inject(EffectiveSettingsService) private readonly effectiveSettings?: EffectiveSettingsService,
  ) {
    super(eventEmitter, clsService, ResourceType.Consultation);
  }

  async preview(consultationId: string, request: PromptPreviewRequest): Promise<PromptPreviewResponse> {
    const tenantId = this.tenantId;
    if (!tenantId) throw new BadRequestException('A working tenant is required to preview a consultation prompt.');
    // Cross-tenant ⇒ 404, never 403 (no existence leak).
    const consultation = await assertParentInScope(this.consultationRepository, consultationId, tenantId);

    const agent = request.agentSlug ? await this.namedAgent(tenantId, request.agentSlug) : null;
    const outputLanguage = await resolvePlatformOutputLanguage(this.effectiveSettings, tenantId, this.logger);
    const assembled = await this.harnessInternal.previewAssembly(
      consultationId,
      { tenantId, userId: this.requestUserId ?? undefined, conversationLanguage: outputLanguage.tag },
      { phase: request.phase, ...(agent ? { instructionOverride: agent } : {}) },
    );
    const system = assembled.systemPrompt;
    const user = assembled.userPrompt;

    const locality = await this.localityOf(tenantId, request, consultation.departmentId ?? null);
    const { providerView, egressPreview } = await this.egressOf(tenantId, consultationId, system, user, locality);

    this.broadcastSysEvent(SysEventType.ResourceViewed, {
      resourceId: consultationId,
      forceAuditLog: true,
      data: { action: 'prompt-preview', phase: request.phase, agentSlug: request.agentSlug ?? null, locality },
    });

    return {
      system,
      user,
      locality,
      providerView,
      egressPreview,
      tokenEstimate: { system: estimateTokens(system), user: estimateTokens(user) },
      resolvedFrom: assembled.resolvedFrom,
      selected: assembled.selected ?? [],
      excluded: assembled.excluded ?? [],
      blocks: (assembled.blocks ?? []).map((block) => ({ key: block.key, chars: block.chars, truncated: block.truncated })),
    };
  }

  /** The named agent's FROZEN instruction — a published TEXT_GENERATION agent of this tenant, else 404. */
  private async namedAgent(
    tenantId: string,
    slug: string,
  ): Promise<{ resolvedPrompt: ComposableResolvedPrompt; variables: Record<string, unknown> }> {
    const agent = await this.agentRepository.findPublishedActiveBySlug(tenantId, slug).catch(() => null);
    if (!agent || String(agent.task) !== String(AgentTask.TEXT_GENERATION)) {
      throw new NotFoundException(`No published TEXT_GENERATION agent '${slug}' in this tenant.`);
    }
    const compiled = agent.compiledConfig as { resolvedPrompt?: ComposableResolvedPrompt } | null | undefined;
    const instruction = agent.instruction as { variables?: unknown } | null | undefined;
    const variables =
      instruction?.variables && typeof instruction.variables === 'object' && !Array.isArray(instruction.variables)
        ? (instruction.variables as Record<string, unknown>)
        : {};
    return { resolvedPrompt: compiled?.resolvedPrompt ?? null, variables };
  }

  /**
   * The locality the call would be stamped with: the model the tenant's text selection resolves
   * for the phase (or the named agent's), by the gateway's own rule. An unresolvable selection is
   * CLOUD — what `apps/text` assumes of an unstamped provider.
   */
  private async localityOf(tenantId: string, request: PromptPreviewRequest, departmentId: string | null): Promise<'local' | 'cloud'> {
    if (!this.harnessPolicy) return 'cloud';
    try {
      const selection = await this.harnessPolicy.resolveTextSelection(tenantId, request.phase === 'live' ? 'live' : 'finalize', departmentId, request.agentSlug ?? null);
      return providerLocality(selection.provider ?? '', selection.deploymentKind ?? null) ?? 'cloud';
    } catch {
      return 'cloud';
    }
  }

  /** Detection over both messages; pseudonymized on CLOUD, counted only on LOCAL — exactly as `apps/text` does. */
  private async egressOf(
    tenantId: string,
    consultationId: string,
    system: string,
    user: string,
    locality: 'local' | 'cloud',
  ): Promise<Pick<PromptPreviewResponse, 'providerView' | 'egressPreview'>> {
    const combined = `${system}${SEGMENT_SEPARATOR}${user}`;
    const spans = await this.detector.detect(combined, tenantId);
    const [systemSpans, userSpans] = splitSpans(spans, [system, user]);
    const known = this.knownPhi ? await this.knownPhi.forConsultation(consultationId).catch(() => []) : [];
    const pseudonymizer = new PreviewPseudonymizer(known.map((entry) => [entry.label, entry.value] as const));

    if (locality === 'local') {
      pseudonymizer.count(system, systemSpans);
      pseudonymizer.count(user, userSpans);
      return { providerView: null, egressPreview: { detected: { ...pseudonymizer.detected }, redacted: 0 } };
    }
    const providerSystem = system ? pseudonymizer.pseudonymize(system, systemSpans) : system;
    const providerUser = user ? pseudonymizer.pseudonymize(user, userSpans) : user;
    return {
      providerView: {
        system: providerSystem ? `${providerSystem}${SEGMENT_SEPARATOR}${PLATFORM_TOKEN_SENTENCE}` : PLATFORM_TOKEN_SENTENCE,
        user: providerUser,
      },
      egressPreview: { detected: { ...pseudonymizer.detected }, redacted: pseudonymizer.redacted },
    };
  }
}

/**
 * Re-base the detector's spans (code points of the joined text) onto the segment each fell in;
 * a span crossing a segment boundary is dropped — the mirror of `apps/text`'s `_split_spans`.
 */
export function splitSpans(spans: readonly PreviewPiiSpan[], segments: readonly string[]): PreviewPiiSpan[][] {
  const bySegment: PreviewPiiSpan[][] = segments.map(() => []);
  const offsets: number[] = [];
  let position = 0;
  segments.forEach((segment, index) => {
    if (index > 0) position += Array.from(SEGMENT_SEPARATOR).length;
    offsets.push(position);
    position += Array.from(segment).length;
  });
  for (const span of spans) {
    offsets.forEach((base, index) => {
      const limit = base + Array.from(segments[index]!).length;
      if (base <= span.start && span.end <= limit) bySegment[index]!.push({ label: span.label, start: span.start - base, end: span.end - base });
    });
  }
  return bySegment;
}
