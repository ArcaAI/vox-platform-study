import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { generateId, WorkflowDefinitionRepository } from '@arcaai/domains';
import { IWorkflowAssignmentService } from '../../workflow-assignment/IWorkflowAssignmentService';
import { IWorkflowRunService } from '../../workflow-run/IWorkflowRunService';
import { HarnessGatewayService } from '../harness/harness-gateway.service';
import { IS3Service } from '../../baseServices/storage/s3/IS3Service';
import { mintCompiledConfigClaimCheckRef } from '../../workflow-exposure/claim-check';
import {
  ConsultationWorkflowDispatchResult,
  DispatchForConsultationInput,
  IConsultationWorkflowDispatchService,
} from './IConsultationWorkflowDispatchService';

/** The palette a consultation-governing graph must declare. */
const CONSULTATION_PALETTE_KEY = 'consultation';

/** Mirrors `WorkflowExposureService`'s bucket choice so both dispatchers mint refs the same way. */
const DEFAULT_CLAIM_CHECK_BUCKET = 'hope-workflow-config';

/** Mirrors `interpreterSessionId` in the exposure plane. */
function interpreterSessionId(runId: string): string {
  return `wf-${runId}`;
}

/**
 * Dispatches a tenant-authored `consultation`-palette workflow at consultation open.
 * See `IConsultationWorkflowDispatchService` for why this is opt-in and exclusive.
 */
@Injectable()
export class ConsultationWorkflowDispatchService implements IConsultationWorkflowDispatchService {
  private readonly logger = new Logger(ConsultationWorkflowDispatchService.name);

  constructor(
    @Inject(IWorkflowAssignmentService) private readonly assignments: IWorkflowAssignmentService,
    private readonly definitionRepository: WorkflowDefinitionRepository,
    @Inject(IWorkflowRunService) private readonly workflowRunService: IWorkflowRunService,
    @Inject(HarnessGatewayService) private readonly harnessGateway: HarnessGatewayService,
    @Optional() @Inject(IS3Service) private readonly s3Service?: IS3Service,
  ) {}

  async dispatchForConsultation(input: DispatchForConsultationInput): Promise<ConsultationWorkflowDispatchResult> {
    const { consultationId, tenantId, departmentId, userId, externalPatientId } = input;

    const resolved = await this.assignments.resolve(tenantId, CONSULTATION_PALETTE_KEY, departmentId ?? null);

    // No tier assigned anything -> Substrate A keeps the consultation. This is the DEFAULT and
    // must stay the default: a tenant that has authored nothing sees today's behaviour exactly.
    if (!resolved.workflowDefinitionSlug) {
      return { dispatched: false, source: resolved.source, workflowDefinitionSlug: null, runId: null };
    }

    const notDispatched = (skippedReason: string): ConsultationWorkflowDispatchResult => ({
      dispatched: false,
      source: resolved.source,
      workflowDefinitionSlug: resolved.workflowDefinitionSlug,
      runId: null,
      skippedReason,
    });

    try {
      const definition = await this.definitionRepository.findPublishedBySlug(tenantId, resolved.workflowDefinitionSlug);

      // `resolve()` already re-checks publication, but it is a REFERENCE across a service
      // boundary — re-verify rather than trust, and never dispatch a graph from another palette
      // into a consultation (an `stt` graph has no consultation nodes and would bind nothing).
      if (!definition) return notDispatched('assignment names no ACTIVE PUBLISHED definition');
      if (definition.paletteKey !== CONSULTATION_PALETTE_KEY) {
        return notDispatched(`assigned definition is palette '${definition.paletteKey}', not '${CONSULTATION_PALETTE_KEY}'`);
      }
      if (!definition.compiledConfig) return notDispatched('definition has no compiled configuration');
      if (!this.s3Service) return notDispatched('no claim-check storage backend is configured');

      const configRef = await mintCompiledConfigClaimCheckRef(definition.compiledConfig, DEFAULT_CLAIM_CHECK_BUCKET, (b, key, data, contentType) =>
        this.s3Service!.putFile(b, key, data, contentType),
      );

      const runId = generateId();
      const sessionId = interpreterSessionId(runId);

      // Ownership anchor BEFORE dispatch — same ordering rule as `WorkflowExposureService.invoke`:
      // a durable row for a run that fails to start is recoverable; a started run nothing can
      // attribute to a tenant is not.
      await this.workflowRunService.recordRunStarted({
        tenantId,
        workflowVersionId: definition.id,
        workflowSlug: definition.slug,
        workflowVersionNumber: definition.versionNumber,
        definitionName: definition.name,
        sessionId,
        runId,
        trigger: 'consultation open',
        isSandbox: false,
      });

      // The identity every consultation node reads from `run_payload`
      // (`interpreter/nodes/_consultation_shared.py`). Omitting it is what made TASK-789 C-2 look
      // like a broken invoke path: `input.context_binding` is `critical=True`, so a run without
      // identity fails at its first node.
      await this.harnessGateway.startWorkflowRun({
        runId,
        sessionId,
        workflowVersionId: definition.id,
        tenantId,
        configRef,
        sandbox: false,
        payload: { consultationId, userId, externalPatientId: externalPatientId ?? null },
      });

      this.logger.log({
        message: 'Consultation governed by tenant-authored workflow',
        consultationId,
        runId,
        slug: definition.slug,
        source: resolved.source,
      });
      return { dispatched: true, source: resolved.source, workflowDefinitionSlug: definition.slug, runId };
    } catch (error) {
      // Best-effort BY DESIGN: a clinician must be able to open a consultation even when the
      // harness is down. The consultation proceeds under Substrate A and the reason is recorded.
      const reason = error instanceof Error ? error.message : String(error);
      this.logger.warn({ message: 'Consultation workflow dispatch failed — falling back to the default loop', consultationId, reason });
      return notDispatched(reason);
    }
  }
}
