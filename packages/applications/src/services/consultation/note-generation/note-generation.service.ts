import { randomUUID } from 'node:crypto';
import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { ClsService } from 'nestjs-cls';
import { ConsultationRepository, ResourceType } from '@arcaai/domains';
import { BaseService } from '../../../common';
import { IActiveUserContext } from '../../../interfaces';
import { ConfigResolver } from '../../config-resolver';
import { HarnessGatewayService } from '../harness/harness-gateway.service';
import { ConsultationPipelineConfig, DEFAULT_PIPELINE_CONFIG } from '../events/consultation.events';
import { INoteGenerationService } from './INoteGenerationService';
import { GenerateParams, GenerationDecision, GenerationTrigger, HARNESS_SUPPORTED_TRIGGERS } from './types';

/**
 * TASK-704 — Generator Entry-Point Seam.
 *
 * The single seam every consultation note-generation entry point routes
 * through (see the ticket README §2.1 for the full seven-entry-point map).
 * `harnessEnabled` is resolved and read in exactly one runtime location:
 * `generate()` below (enforced by the grep-gate test in
 * `__tests__/harness-enabled-single-reader.grep-gate.test.ts`).
 *
 * `NoteGenerationService` is deliberately named to become the interpreter
 * dispatcher once the workflow substrate exists (Wave 2+, D4/§Plane 1 in
 * design.md). Nothing about that future is built here — this is entry-point
 * consolidation only.
 */
@Injectable()
export class NoteGenerationService extends BaseService implements INoteGenerationService {
  private readonly logger = new Logger(NoteGenerationService.name);

  constructor(
    private readonly consultationRepository: ConsultationRepository,
    // REQUIRED, NOT @Optional() — this is the throw-loud fix for the §2.3
    // silent-drop defect. Nest DI fails fast at boot if
    // HarnessGatewayServiceModule isn't imported into whatever module
    // provides NoteGenerationService, which is the desired failure mode
    // (a missing gateway on a harness-enabled trigger must be loud, never a
    // success-shaped log with zero notes produced).
    private readonly harnessGatewayService: HarnessGatewayService,
    protected override readonly eventEmitter: EventEmitter2,
    protected override readonly clsService: ClsService<IActiveUserContext>,
    // (Pillar B cascade) — optional + trailing so legacy positional
    // fixtures keep compiling; when absent, resolveConfig falls back to
    // DEFAULT_PIPELINE_CONFIG (same degrade as the pre-TASK-704 handler).
    @Optional() @Inject(ConfigResolver) private readonly configResolver?: ConfigResolver,
  ) {
    // NoteGenerationService wraps existing generation calls and never
    // broadcasts its own sys-events (the wrapped services already do — see
    // ticket §2.5), so `resourceType` here is never actually used to emit an
    // event; ResourceType.Consultation is the closest fit for the
    // BaseService contract.
    super(eventEmitter, clsService, ResourceType.Consultation);
  }

  async generate(trigger: GenerationTrigger, params: GenerateParams): Promise<GenerationDecision> {
    const config = await this.resolveConfig(params.consultationId);

    if (!HARNESS_SUPPORTED_TRIGGERS.has(trigger)) {
      this.logger.log({
        message: 'Generation trigger has no harness equivalent — falling back to legacy',
        trigger,
        consultationId: params.consultationId,
        harnessEnabled: config.harnessEnabled ?? false,
      });
      return { generator: 'legacy', reason: 'harness-not-supported-for-trigger' };
    }

    if (!config.harnessEnabled) {
      this.logger.log({
        message: 'harnessEnabled is false for this consultation — using the legacy generator',
        trigger,
        consultationId: params.consultationId,
      });
      return { generator: 'legacy', reason: 'harnessEnabled-false' };
    }

    const harnessJobId = `harness-doc-${randomUUID()}`;

    // TASK-712 (consent-abac Phase 4): thread the consultation's external
    // patient id so the harness's call_mcp_tool/retrieve_context activities
    // can key a consent-gate lookup. Best-effort, non-fatal — a lookup
    // failure here must never block note generation itself; it only means
    // those two activities degrade to `consent_unavailable` (fail-closed,
    // distinguishable from a genuine denial — R4) instead of being gated.
    let externalPatientId: string | undefined;
    try {
      const consultation = await this.consultationRepository.findById(params.consultationId);
      externalPatientId = consultation.patientId;
    } catch (error) {
      this.logger.warn({
        message:
          'NoteGenerationService: could not resolve patientId for the consent-gate — harness tool/RAG calls will report consent as unavailable',
        consultationId: params.consultationId,
        error: error instanceof Error ? error.message : String(error),
      });
    }

    // NOT optional-chained (`.start(` not `?.start(`) — a missing gateway
    // throws here rather than silently no-op'ing. See the constructor note.
    await this.harnessGatewayService.start(params.consultationId, {
      tenantId: params.tenantId,
      userId: params.userId,
      jobId: harnessJobId,
      correlationId: params.correlationId ?? harnessJobId,
      contextItemId: params.contextItemId,
      transcriptText: params.transcriptText,
      redactionRules: params.redactionRules,
      externalPatientId,
    });

    this.logger.log({
      message: 'Harness document workflow start requested',
      trigger,
      consultationId: params.consultationId,
      harnessJobId,
      contextItemId: params.contextItemId,
    });

    return { generator: 'harness', harnessJobId };
  }

  /**
   * Resolve pipeline configuration for a consultation.
   *
   * Moved verbatim (TASK-704) from
   * `ConsultationEventHandler.resolvePipelineConfig` — same cascade-merge
   * behavior, same fail-closed-to-defaults `catch`. See that method's
   * original docstring (git history) for the full resolution-order writeup;
   * unchanged here:
   *
   * Resolution order (first non-null wins):
   *   1. Consultation `metadata.pipelineConfig` (per-consultation override, kept
   *      as the top overlay for back-compat).
   *   2. The `PipelinePolicy` cascade via `ConfigResolver` — doctor → department
   *      → tenant → SYSTEM-tenant default. Resolves
   *      `autoSummaryEnabled` / `autoNerEnabled` / `harnessEnabled`.
   *   3. System code defaults (`DEFAULT_PIPELINE_CONFIG`) — also the fallback when
   *      the resolver is not wired (legacy DI/fixtures).
   */
  async resolveConfig(consultationId: string): Promise<ConsultationPipelineConfig> {
    try {
      const consultation = await this.consultationRepository.findById(consultationId);
      if (!consultation) {
        this.logger.warn({
          message: 'Consultation not found — using default pipeline config',
          consultationId,
        });
        return { ...DEFAULT_PIPELINE_CONFIG };
      }

      const metadata = consultation.metadata as Record<string, unknown> | null;
      const override = (metadata?.pipelineConfig ?? {}) as Partial<ConsultationPipelineConfig>;

      // Cascade-resolved toggles (doctor → department → tenant → SYSTEM default).
      // When the resolver isn't wired, fall back to the code defaults so the
      // legacy behaviour is preserved exactly.
      const cascade = this.configResolver
        ? await this.configResolver.resolvePipelineToggles({
            tenantId: consultation.tenantId,
            departmentId: consultation.departmentId ?? null,
            doctorId: consultation.doctorId ?? null,
          })
        : null;

      const resolved: ConsultationPipelineConfig = {
        // The cascade owns the realtime toggles; the per-consultation metadata
        // override wins on top (back-compat).
        autoSummaryEnabled: override.autoSummaryEnabled ?? cascade?.autoSummaryEnabled ?? DEFAULT_PIPELINE_CONFIG.autoSummaryEnabled,
        autoNerEnabled: override.autoNerEnabled ?? cascade?.autoNerEnabled ?? DEFAULT_PIPELINE_CONFIG.autoNerEnabled,
        // dnaStyleId / summaryTemplate / includeSharedContext stay per-consultation.
        dnaStyleId: override.dnaStyleId ?? DEFAULT_PIPELINE_CONFIG.dnaStyleId,
        summaryTemplate: override.summaryTemplate ?? DEFAULT_PIPELINE_CONFIG.summaryTemplate,
        includeSharedContext: override.includeSharedContext ?? DEFAULT_PIPELINE_CONFIG.includeSharedContext,
        haltOnFailure: override.haltOnFailure ?? DEFAULT_PIPELINE_CONFIG.haltOnFailure,
      };

      // harnessEnabled: per-consultation override wins over the cascade. Only
      // surfaced when defined so callers reading a fully-specified legacy config
      // (no resolver) don't see a synthesized default (preserves back-compat).
      const harnessEnabled = override.harnessEnabled ?? cascade?.harnessEnabled;
      if (harnessEnabled !== undefined) {
        resolved.harnessEnabled = harnessEnabled;
      }

      return resolved;
    } catch (error) {
      this.logger.error({
        message: 'Error resolving pipeline config — using defaults',
        consultationId,
        error: error instanceof Error ? error.message : String(error),
      });
      return { ...DEFAULT_PIPELINE_CONFIG };
    }
  }
}
