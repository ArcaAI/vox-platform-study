import { Injectable } from '@nestjs/common';
import {
  GENESIS_PREV_HASH,
  HarnessAuditAction,
  HarnessAuditChainVerification,
  HarnessAuditEventEntity,
  HarnessAuditEventFactory,
  HarnessAuditEventRepository,
  JsonValue,
  verifyHarnessAuditChain,
} from '@arcaai/domains';
import { InternalServerErrorException } from '@arcaai/exceptions';

/**
 * HarnessAuditService (TASK-330 Phase 0) — append-only, hash-chained WORM audit
 * trail for the clinical documentation harness.
 *
 * `append` computes the tamper-evident hash chain: it reads the tenant's most
 * recent event to derive `prevHash` (genesis for the first), builds the event
 * via the factory (which computes `hash` over the canonical fields), and writes
 * it through the repository. The backing table REVOKEs UPDATE/DELETE from the
 * app role, so rows are immutable at the database-privilege layer.
 *
 * `verifyChain` re-derives each event's hash and validates the prevHash linkage
 * to detect tampering or splicing.
 *
 * Phase 0 is data-layer only: `tenantId` is supplied explicitly by the caller.
 *
 * NOTE (Phase 0 limitation): `append` reads-then-writes without a serializing
 * lock, so two concurrent appends for the same tenant could compute the same
 * `prevHash`. The `hash` UNIQUE constraint still rejects an exact duplicate, but
 * a transactional `SELECT … FOR UPDATE` (or per-tenant advisory lock) should be
 * added when concurrent writers are introduced in a later phase.
 */
export interface AppendHarnessAuditInput {
  tenantId: string;
  consultationId: string;
  contextItemVersionId?: string | null;
  action: HarnessAuditAction;
  modelName: string;
  modelVersion: string;
  promptTemplateId?: string | null;
  promptVersion?: string | null;
  sensorScores: JsonValue;
  citations: JsonValue;
  gateDecision?: string | null;
  clinicianId?: string | null;
  attestationHash?: string | null;
  createdBy?: string | null;
}

@Injectable()
export class HarnessAuditService {
  constructor(private readonly harnessAuditEventRepository: HarnessAuditEventRepository) {}

  /**
   * Append a new audit event, computing its place in the tenant's hash chain.
   */
  async append(input: AppendHarnessAuditInput): Promise<HarnessAuditEventEntity> {
    const latest = await this.harnessAuditEventRepository.getLatestForTenant(input.tenantId);
    const prevHash = latest?.hash ?? GENESIS_PREV_HASH;

    const event = HarnessAuditEventFactory.CreateHarnessAuditEvent({
      tenantId: input.tenantId,
      consultationId: input.consultationId,
      contextItemVersionId: input.contextItemVersionId ?? null,
      action: input.action,
      modelName: input.modelName,
      modelVersion: input.modelVersion,
      promptTemplateId: input.promptTemplateId ?? null,
      promptVersion: input.promptVersion ?? null,
      sensorScores: input.sensorScores,
      citations: input.citations,
      gateDecision: input.gateDecision ?? null,
      clinicianId: input.clinicianId ?? null,
      attestationHash: input.attestationHash ?? null,
      prevHash,
      createdBy: input.createdBy ?? null,
    });

    const created = await this.harnessAuditEventRepository.create(event);
    if (!created) {
      throw new InternalServerErrorException('Failed to create HarnessAuditEventEntity');
    }
    return created;
  }

  /**
   * Verify the integrity of a tenant's audit chain (oldest → newest). Returns
   * `{ valid, brokenAtIndex }` — `brokenAtIndex` points at the first event whose
   * hash or prevHash linkage fails.
   */
  async verifyChain(tenantId: string): Promise<HarnessAuditChainVerification> {
    const chain = await this.harnessAuditEventRepository.getChainForTenant(tenantId);

    const records = chain.map((event) => ({
      tenantId: event.tenantId,
      consultationId: event.consultationId,
      contextItemVersionId: event.contextItemVersionId ?? null,
      action: event.action,
      modelName: event.modelName,
      modelVersion: event.modelVersion,
      promptTemplateId: event.promptTemplateId ?? null,
      promptVersion: event.promptVersion ?? null,
      sensorScores: event.sensorScores,
      citations: event.citations,
      gateDecision: event.gateDecision ?? null,
      clinicianId: event.clinicianId ?? null,
      attestationHash: event.attestationHash ?? null,
      createdAt: event.createdAt,
      prevHash: event.prevHash,
      hash: event.hash,
    }));

    return verifyHarnessAuditChain(records);
  }

  /**
   * Audit events for a single consultation, oldest → newest.
   */
  async getByConsultation(tenantId: string, consultationId: string): Promise<HarnessAuditEventEntity[]> {
    return this.harnessAuditEventRepository.getByConsultation(tenantId, consultationId);
  }
}
