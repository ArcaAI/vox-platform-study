import { BadRequestException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { ClsService } from 'nestjs-cls';
import { ConsultationRepository, ResourceType, SysEventType, WorkflowDefinitionRepository, WorkflowRunKind, WorkflowRunRepository } from '@arcaai/domains';
import type { ConsultationEntity } from '@arcaai/domains';
import { CONSULTATION_READ_SCHEMA_VERSION } from '@arcaai/workflow-contract';
import { BaseService } from '../../common';
import { IActiveUserContext } from '../../interfaces';
import {
  declaredReadsForNode,
  isPathDeclared,
  phiPathCount,
  pickPath,
  rootsOf,
  runBelongsToConsultation,
  unknownConsultationPaths,
} from './consultation-read-access';
import { ConsultationReadModelAssembler } from './consultation-read-model.assembler';
import type { IConsultationReadService } from './IConsultationReadService';

/** Upper bound on paths per call — a node declares a handful; a large list is a client defect. */
export const CONSULTATION_READ_MAX_PATHS = 64;

export interface ConsultationReadInput {
  tenantId: string;
  consultationId: string;
  runId: string;
  nodeId: string;
  paths: string[];
}

export interface ConsultationReadResult {
  /** Requested path → value (`null` when the consultation holds no value there). */
  values: Record<string, unknown>;
  readAt: string;
  schemaVersion: number;
}

/** DI token for {@link ConsultationReadModelAssembler} (the service takes it by token so a fixture can stub it). */
export const CONSULTATION_READ_MODEL_ASSEMBLER = Symbol('CONSULTATION_READ_MODEL_ASSEMBLER');

/**
 * TASK-1036 §9.3 / TASK-1038 — the gateway half of the harness's `consultation.read` activity.
 *
 * Returns EXACTLY the `consultation.*` paths one node of one run declared (least privilege, PHI
 * minimisation), assembled from the consultation's rows at the moment of the call (the harness
 * records the answer in its activity result, so replay is deterministic). Every refusal that could
 * reveal another tenant's data is a 404; a malformed or undeclared request is a 400 naming the
 * paths. Each read is audited with paths and a PHI count — never values.
 */
@Injectable()
export class ConsultationReadService extends BaseService implements IConsultationReadService {
  constructor(
    protected override readonly eventEmitter: EventEmitter2,
    protected override readonly clsService: ClsService<IActiveUserContext>,
    private readonly workflowRunRepository: WorkflowRunRepository,
    private readonly workflowDefinitionRepository: WorkflowDefinitionRepository,
    private readonly consultationRepository: ConsultationRepository,
    @Inject(CONSULTATION_READ_MODEL_ASSEMBLER) private readonly assembler: Pick<ConsultationReadModelAssembler, 'assemble'>,
  ) {
    super(eventEmitter, clsService, ResourceType.Consultation);
  }

  async read(input: ConsultationReadInput): Promise<ConsultationReadResult> {
    const paths = [...new Set(input.paths ?? [])];
    if (paths.length === 0) {
      throw new BadRequestException({ code: 'CONSULTATION_READ_NO_PATHS', message: 'Name at least one `consultation.*` path to read.' });
    }
    if (paths.length > CONSULTATION_READ_MAX_PATHS) {
      throw new BadRequestException({ code: 'CONSULTATION_READ_TOO_MANY_PATHS', message: `At most ${CONSULTATION_READ_MAX_PATHS} paths per read.` });
    }
    const unknown = unknownConsultationPaths(paths);
    if (unknown.length > 0) {
      throw new BadRequestException({
        code: 'CONSULTATION_READ_UNKNOWN_PATH',
        message: `Not a path of the consultation read schema v${CONSULTATION_READ_SCHEMA_VERSION}: ${unknown.join(', ')}`,
        paths: unknown,
      });
    }

    // Run → tenant. `findAll` (not `findFirst`, which throws) so a miss is a plain 404. WORKFLOW
    // runs only (TASK-1038 OD-26): an agent run has no workflow version and no declared reads.
    const [run] = await this.workflowRunRepository.findAll({ filters: { tenantId: input.tenantId, runId: input.runId, kind: WorkflowRunKind.WORKFLOW } });
    if (!run || run.tenantId !== input.tenantId || !run.workflowVersionId) throw this.notFound(input);

    const consultation = (await this.consultationRepository.findByIdOrNull(input.consultationId)) as ConsultationEntity | null;
    if (!consultation || consultation.tenantId !== input.tenantId) throw this.notFound(input);
    if (!runBelongsToConsultation({ runId: run.runId, metaData: (run as { metaData?: Record<string, unknown> | null }).metaData }, consultation)) {
      throw this.notFound(input);
    }

    // The run's EXACT workflow version — the reads it declared, not whatever is active now.
    const definition = await this.workflowDefinitionRepository.findById(run.workflowVersionId).catch(() => null);
    if (!definition || definition.tenantId !== input.tenantId) throw this.notFound(input);

    const declared = declaredReadsForNode(definition.compiledConfig, definition.graph, input.nodeId);
    const undeclared = paths.filter((path) => !isPathDeclared(path, declared));
    if (undeclared.length > 0) {
      throw new BadRequestException({
        code: 'CONSULTATION_READ_UNDECLARED',
        message: `Step \`${input.nodeId}\` of this workflow version does not declare: ${undeclared.join(', ')}`,
        paths: undeclared,
      });
    }

    const model = await this.assembler.assemble(consultation, input.tenantId, rootsOf(paths));
    const values = Object.fromEntries(paths.map((path) => [path, pickPath(model, path)]));
    const readAt = new Date().toISOString();

    this.broadcastSysEvent(SysEventType.ResourceViewed, {
      resourceId: consultation.id,
      forceAuditLog: true,
      data: {
        action: 'consultationDeclaredRead',
        runId: input.runId,
        nodeId: input.nodeId,
        workflowVersionId: run.workflowVersionId,
        paths,
        phiPathCount: phiPathCount(paths),
        schemaVersion: CONSULTATION_READ_SCHEMA_VERSION,
      },
    });

    return { values, readAt, schemaVersion: CONSULTATION_READ_SCHEMA_VERSION };
  }

  private notFound(input: ConsultationReadInput): NotFoundException {
    return new NotFoundException(`Consultation '${input.consultationId}' has no run '${input.runId}'.`);
  }
}
