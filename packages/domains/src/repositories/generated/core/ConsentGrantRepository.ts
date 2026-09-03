import { Injectable } from '@nestjs/common';
import { Prisma } from '@arcaai/database';
import { DataNotFoundException } from '@arcaai/exceptions';

import { Repository } from '../../../common';
import { CoreUnitOfWorkService } from '../../../common/unitsOfWork/core';
import { ConsentGrantEntity } from '../../../entities';
import { ConsentPurpose, ResourceStatusType } from '../../../enums';
import { ConsentGrantEntityMapper } from '../../../mappers';
import { ConsentGrant } from '../../../models';

/**
 * ConsentGrant repository (consent-abac).
 *
 * HAND-AUTHORED — `gen:repository` is broken; this follows the
 * `AiProviderConnectionRepository` precedent in this folder.
 *
 * One row per (tenant, externalPatientId, purpose) — enforced by the
 * `ConsentGrant_tenant_patient_purpose_key` unique index. Ordinary
 * tenant-scoped model (no SYSTEM row, no widening) — see
 * `packages/database/src/extensions/tenant-scope.ts`.
 */
@Injectable()
export class ConsentGrantRepository extends Repository<ConsentGrantEntity, ConsentGrant> {
  constructor(private readonly unitOfWorkService: CoreUnitOfWorkService) {
    super(unitOfWorkService, 'consentGrant', ConsentGrantEntityMapper.getInstance());
  }

  /**
   * The (tenant, patient, purpose) lookup `assertConsent`/`checkConsent`
   * evaluate against. Returns `null` on a genuine miss; a cross-tenant read
   * (tenant-scope extension mismatch) SURFACES rather than silently
   * returning null — mirrors `AiProviderConnectionRepository.findByTenantServiceProvider`.
   *
   * Does NOT filter `revokedAt: null` in the WHERE clause — it orders by
   * `revokedAt DESC` instead, and relies on Postgres's own default NULL
   * ordering (`NULLS FIRST` for `DESC`) so the query returns, in order of
   * preference:
   *   1. the ACTIVE grant (`revokedAt IS NULL`), if one exists — the same
   *      row the DB's partial unique index
   *      (`ConsentGrant_tenant_patient_purpose_active_key`) treats as "the"
   *      grant for this triple;
   *   2. otherwise the MOST RECENTLY REVOKED grant.
   * This is deliberate: filtering `revokedAt: null` in the WHERE clause
   * would make a revoked-with-no-re-grant lookup indistinguishable from a
   * NEVER-granted one — `checkConsent` needs the revoked row specifically
   * so it can report `reason: 'revoked'` rather than the less useful
   * `'no_grant'` (a real regression caught by
   * `apps/api/tests/e2e/consent-abac.spec.ts`'s revocation case). Ordering
   * by `revokedAt DESC` gives the right row in ONE query either way.
   */
  async findByTenantPatientPurpose(
    tenantId: string,
    externalPatientId: string,
    purpose: ConsentPurpose,
    tx?: Prisma.TransactionClient | any,
  ): Promise<ConsentGrantEntity | null> {
    const where = { tenantId, externalPatientId, purpose, resourceStatus: ResourceStatusType.ENABLED };

    if (tx) {
      const model = await (tx as Record<string, any>).consentGrant.findFirst({ where, orderBy: { revokedAt: 'desc' } });
      return model ? ConsentGrantEntityMapper.getInstance().toDomainEntity(model) : null;
    }

    try {
      return await this.findFirst({ filters: where, sort: [{ revokedAt: 'desc' }] });
    } catch (err) {
      if (err instanceof DataNotFoundException) return null;
      throw err;
    }
  }

  /** Every ENABLED grant for one patient within a tenant (admin listing). */
  async findByTenantAndPatient(tenantId: string, externalPatientId: string, tx?: Prisma.TransactionClient | any): Promise<ConsentGrantEntity[]> {
    const where = { tenantId, externalPatientId, resourceStatus: ResourceStatusType.ENABLED };

    if (tx) {
      const models = await (tx as Record<string, any>).consentGrant.findMany({
        where,
        orderBy: [{ purpose: 'asc' }],
      });
      const mapper = ConsentGrantEntityMapper.getInstance();
      return models.map((m: any) => mapper.toDomainEntity(m));
    }

    return this.findAll({ filters: where, sort: [{ purpose: 'asc' }] });
  }
}
