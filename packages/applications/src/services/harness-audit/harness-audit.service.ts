import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import {
  GENESIS_PREV_HASH,
  HarnessAuditAction,
  HarnessAuditChainVerification,
  HarnessAuditEventEntity,
  HarnessAuditEventFactory,
  HarnessAuditEventRepository,
  JsonValue,
  toHarnessAuditChainRecord,
  verifyHarnessAuditChain,
} from '@arcaai/domains';
import { InternalServerErrorException } from '@arcaai/exceptions';
import { SecretsService } from '../baseServices/_meta/secrets';

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
  private readonly logger = new Logger(HarnessAuditService.name);

  constructor(
    private readonly harnessAuditEventRepository: HarnessAuditEventRepository,
    // TASK-369 Phase 3D — optional + @Inject so existing direct-construction unit
    // fixtures (which don't wire the @Global SecretsService) keep working, and
    // non-Vault deployments degrade to plaintext. Mirrors ContextService.
    @Optional() @Inject(SecretsService) private readonly secretsService?: SecretsService,
  ) {}

  /**
   * Append a new audit event, computing its place in the tenant's hash chain.
   *
   * TASK-369 Phase 3D — ENCRYPT-BEFORE-HASH: when SecretsService (Vault) is
   * wired, `sensorScores`/`citations` are encrypted first and the factory derives
   * the `hash` over the CIPHERTEXT (writing a redaction sentinel into the
   * plaintext JSONB). Best-effort: if encryption throws (Vault down) or no
   * SecretsService is present, the event is appended in plaintext with the hash
   * over plaintext — the clinical audit append must never fail closed here.
   */
  async append(input: AppendHarnessAuditInput): Promise<HarnessAuditEventEntity> {
    const latest = await this.harnessAuditEventRepository.getLatestForTenant(input.tenantId);
    const prevHash = latest?.hash ?? GENESIS_PREV_HASH;

    let encrypted: { encryptedSensorScores: Buffer | null; encryptedCitations: Buffer | null; keyVersion: number | null } | null = null;
    if (this.secretsService) {
      try {
        encrypted = await this.harnessAuditEventRepository.encryptPayloads(this.secretsService, input.sensorScores, input.citations);
      } catch (error) {
        this.logger.warn({
          message: 'HarnessAuditEvent payload encryption failed — appending plaintext (hash over plaintext)',
          tenantId: input.tenantId,
          consultationId: input.consultationId,
          error: error instanceof Error ? error.message : String(error),
        });
        encrypted = null;
      }
    }

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
      encryptedSensorScores: encrypted?.encryptedSensorScores ?? null,
      encryptedCitations: encrypted?.encryptedCitations ?? null,
      keyVersion: encrypted?.keyVersion ?? null,
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

    // TASK-369 Phase 3D — map via the shared helper so the verifier hashes over
    // the SAME representation the insert path used (ciphertext for encrypted rows,
    // plaintext for legacy rows). Using this on the writer AND every verifier is
    // what keeps the encrypt-before-hash chain consistent.
    const records = chain.map(toHarnessAuditChainRecord);

    return verifyHarnessAuditChain(records);
  }

  /**
   * Audit events for a single consultation, oldest → newest.
   */
  async getByConsultation(tenantId: string, consultationId: string): Promise<HarnessAuditEventEntity[]> {
    return this.harnessAuditEventRepository.getByConsultation(tenantId, consultationId);
  }
}
