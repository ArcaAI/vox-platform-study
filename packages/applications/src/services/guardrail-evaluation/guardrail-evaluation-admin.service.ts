import { BadRequestException, Inject, Injectable, Logger, NotFoundException, Optional } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { ClsService } from 'nestjs-cls';
import {
  ConsultationRepository,
  GuardrailEvaluationRepository,
  GuardrailNoticeRepository,
  ResourceType,
  SysEventType,
  UserRoleAssignmentRepository,
  type GuardrailEvaluationEntity,
} from '@arcaai/domains';
import { GUARDRAIL_CHECK_IDS, GUARDRAIL_DECISIONS, GUARDRAIL_DIRECTIONS, type GuardrailEvaluationCheck } from '@arcaai/types';
import { BaseService } from '../../common';
import { buildCursorFindAllProps, clampCursorLimit, decodeCursor, toCursorPage } from '../../common/cursorPagination';
import { IActiveUserContext } from '../../interfaces';
import { SecretsService } from '../baseServices/_meta/secrets';
import { assertPromptInspectorAccess } from '../composed-prompt/prompt-inspector-access';
import { decisionFromRow, decisionToRow, directionFromRow, directionToRow } from '../guardrail-notice/guardrail-wire';
import { countGuardrailAggregates, type GuardrailAggregates } from './guardrail-aggregates';

const PHI_TRANSIT_KEY = 'hope-phi';
const DEFAULT_LIMIT = 50;

/** The refusal the withheld review answers to everyone outside the Prompt Inspector audience. */
const WITHHELD_FORBIDDEN = {
  code: 'GUARDRAIL_WITHHELD_FORBIDDEN',
  message: 'Withheld output can carry patient data and is readable only by a super administrator or a tenant administrator of this tenant.',
} as const;

export interface GuardrailEvaluationListQueryInput {
  cursor?: string;
  limit?: number;
  /** The evaluation's decision: allow | warn | block | unverified. */
  action?: string;
  direction?: string;
  /** A check id the evaluation ran (`checks[].checkId`). */
  check?: string;
  /** Only the evaluations of one workflow run (run-detail). */
  runId?: string;
  /** Only the evaluations of one `AiActivityRun` (`runKey`). */
  runKey?: string;
}

/** One evaluation row as the admin grid reads it. No content and no judge reasoning. */
export interface GuardrailEvaluationRow {
  evaluationId: string;
  at: string;
  requestId: string;
  consultationId: string | null;
  runId: string | null;
  runKey: string | null;
  nodeId: string | null;
  agentSlug: string | null;
  caller: string;
  direction: 'inbound' | 'outbound';
  decision: 'allow' | 'warn' | 'block' | 'unverified';
  exempt: string | null;
  policyVersion: string;
  noticeIds: string[];
  checks: GuardrailEvaluationCheck[];
  /** An outbound block whose output was withheld (readable through the withheld review route). */
  hasWithheldContent: boolean;
}

export interface GuardrailEvaluationPage {
  consultationId: string;
  items: GuardrailEvaluationRow[];
  nextCursor: string | null;
  hasMore: boolean;
  limit: number;
}

export interface GuardrailWithheldContent {
  evaluationId: string;
  consultationId: string;
  at: string;
  policyVersion: string;
  noticeIds: string[];
  content: string;
}

function toRow(entity: GuardrailEvaluationEntity): GuardrailEvaluationRow {
  return {
    evaluationId: entity.id,
    at: new Date(entity.at).toISOString(),
    requestId: entity.requestId,
    consultationId: entity.consultationId ?? null,
    runId: entity.runId ?? null,
    runKey: entity.runKey ?? null,
    nodeId: entity.nodeId ?? null,
    agentSlug: entity.agentSlug ?? null,
    caller: entity.caller,
    direction: directionFromRow(entity.direction),
    decision: decisionFromRow(entity.decision),
    exempt: entity.exempt ?? null,
    policyVersion: entity.policyVersion,
    noticeIds: [...(entity.noticeIds ?? [])],
    checks: Array.isArray(entity.checks) ? (entity.checks as unknown as GuardrailEvaluationCheck[]) : [],
    hasWithheldContent: !!entity.encryptedWithheldContent && entity.encryptedWithheldContent.length > 0,
  };
}

/**
 * TASK-1050 W2e — the admin read plane over guardrail evaluations (README §9.6, §9.7.6).
 *
 * `list` returns ids, verdicts and counts only — no content, so it carries the consultation-read
 * posture of the admin activity routes (tenant-scoped, 404 for another tenant's consultation).
 * `getWithheld` DECRYPTS the output an outbound block withheld: PHI, so it is gated like the
 * Prompt Inspector (`assertPromptInspectorAccess`, TASK-1035 OD-9) — row-independent and therefore
 * FIRST, before any id is resolved — and every read is audited.
 */
@Injectable()
export class GuardrailEvaluationAdminService extends BaseService {
  private readonly logger = new Logger(GuardrailEvaluationAdminService.name);

  constructor(
    private readonly consultations: ConsultationRepository,
    private readonly evaluations: GuardrailEvaluationRepository,
    private readonly notices: GuardrailNoticeRepository,
    protected override readonly eventEmitter: EventEmitter2,
    protected override readonly clsService: ClsService<IActiveUserContext>,
    @Optional() private readonly roleAssignments?: UserRoleAssignmentRepository,
    @Optional() @Inject(SecretsService) private readonly secrets?: Pick<SecretsService, 'decrypt'> & { getPhiTransitKeyName?(): string | undefined },
  ) {
    super(eventEmitter, clsService, ResourceType.GuardrailEvaluation);
  }

  async list(consultationId: string, query: GuardrailEvaluationListQueryInput): Promise<GuardrailEvaluationPage> {
    const tenantId = this.requireTenant();
    await this.loadConsultation(consultationId, tenantId);
    const where: Record<string, unknown> = { tenantId, consultationId };
    if (query.action !== undefined) {
      if (!(GUARDRAIL_DECISIONS as readonly string[]).includes(query.action)) throw new BadRequestException(`Unknown action: ${query.action}`);
      where.decision = decisionToRow(query.action as (typeof GUARDRAIL_DECISIONS)[number]);
    }
    if (query.direction !== undefined) {
      if (!(GUARDRAIL_DIRECTIONS as readonly string[]).includes(query.direction))
        throw new BadRequestException(`Unknown direction: ${query.direction}`);
      where.direction = directionToRow(query.direction as (typeof GUARDRAIL_DIRECTIONS)[number]);
    }
    if (query.check !== undefined) {
      if (!(GUARDRAIL_CHECK_IDS as readonly string[]).includes(query.check)) throw new BadRequestException(`Unknown check: ${query.check}`);
      where.checks = { array_contains: [{ checkId: query.check }] };
    }
    if (query.runId !== undefined) where.runId = query.runId;
    if (query.runKey !== undefined) where.runKey = query.runKey;
    const cursor = query.cursor ? decodeCursor(query.cursor) : null;
    if (query.cursor && !cursor) throw new BadRequestException('Invalid cursor');
    const limit = clampCursorLimit(query.limit ?? DEFAULT_LIMIT);

    const rows = await this.evaluations.findAll(buildCursorFindAllProps(cursor, limit, { where: where as never, sortKey: 'at', direction: 'desc' }));
    const page = toCursorPage(rows, limit, (row) => new Date(row.at).toISOString());
    return { consultationId, items: page.data.map((row) => toRow(row)), nextCursor: page.nextCursor, hasMore: page.hasMore, limit: page.limit };
  }

  async getWithheld(consultationId: string, evaluationId: string): Promise<GuardrailWithheldContent> {
    // Privilege before existence: the gate does not vary by row, so it cannot leak one.
    await assertPromptInspectorAccess(
      {
        user: this.requestUser,
        serviceAccount: (this.clsService as unknown as { get(key: string): unknown }).get('serviceAccount'),
        tenantId: this.tenantId ?? '',
        roleAssignments: this.roleAssignments,
        logger: this.logger,
      },
      WITHHELD_FORBIDDEN,
    );
    const tenantId = this.requireTenant();
    await this.loadConsultation(consultationId, tenantId);
    const entity = await this.evaluations.findByIdOrNull(evaluationId);
    if (!entity || entity.tenantId !== tenantId || entity.consultationId !== consultationId || !entity.encryptedWithheldContent?.length) {
      throw new NotFoundException(`Withheld output ${evaluationId} not found`);
    }
    if (!this.secrets) throw new NotFoundException(`Withheld output ${evaluationId} cannot be read: no secrets provider is available to decrypt it`);
    const ciphertext = Buffer.from(entity.encryptedWithheldContent).toString('utf8');
    const content = (await this.secrets.decrypt(ciphertext, this.secrets.getPhiTransitKeyName?.() ?? PHI_TRANSIT_KEY)).toString('utf8');
    this.broadcastSysEvent(SysEventType.ResourceViewed, {
      resourceId: entity.id,
      resourceType: ResourceType.GuardrailEvaluation,
      forceAuditLog: true,
      data: { action: 'guardrail_withheld_decrypt', consultationId, keyVersion: entity.keyVersion ?? null },
    });
    return {
      evaluationId: entity.id,
      consultationId,
      at: new Date(entity.at).toISOString(),
      policyVersion: entity.policyVersion,
      noticeIds: [...(entity.noticeIds ?? [])],
      content,
    };
  }

  /** The consultation's guardrail counts (ids and numbers only) for the activity aggregates. */
  aggregates(tenantId: string, consultationId: string): Promise<GuardrailAggregates> {
    return countGuardrailAggregates(this.evaluations, this.notices, tenantId, consultationId);
  }

  private requireTenant(): string {
    const tenantId = this.tenantId;
    if (!tenantId) throw new BadRequestException('Tenant ID is required');
    return tenantId;
  }

  private async loadConsultation(consultationId: string, tenantId: string): Promise<void> {
    const consultation = await this.consultations.findByIdOrNull(consultationId);
    if (!consultation || consultation.tenantId !== tenantId) throw new NotFoundException(`Consultation ${consultationId} not found`);
  }
}
