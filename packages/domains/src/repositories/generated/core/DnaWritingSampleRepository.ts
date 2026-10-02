import { Injectable } from '@nestjs/common';

import { Repository } from '../../../common';
import { DnaWritingSampleEntityMapper } from '../../../mappers';
import { DnaWritingSampleEntity } from '../../../entities';
import { DnaWritingSample } from '../../../models';
import { CoreUnitOfWorkService } from '../../../common/unitsOfWork/core';
import { DnaSampleSource } from '../../../enums';
import { type SecretsServiceLike, decryptCiphertextToString, encryptStringToCiphertext } from '../../../common/field-encryption';

/** Per-doctor memory roll-up for the admin summary (TASK-1034). */
export interface DnaWritingSampleDoctorSummary {
  doctorId: string;
  total: number;
  unconsumed: number;
  bySource: Record<'EDIT' | 'SIGNOFF' | 'INGEST', number>;
  lastSampleAt: Date | null;
}

export interface DnaWritingSampleListFilter {
  tenantId: string;
  doctorId?: string;
  source?: DnaSampleSource;
  consumed?: boolean;
}

/**
 * TASK-1034 — DNA writing-style memory samples. Every query names `tenantId`
 * explicitly (the scheduler runs outside a request's CLS tenant), and the
 * extended client already hides DELETED rows.
 */
@Injectable()
export class DnaWritingSampleRepository extends Repository<DnaWritingSampleEntity, DnaWritingSample> {
  constructor(private readonly unitOfWorkService: CoreUnitOfWorkService) {
    super(unitOfWorkService, 'dnaWritingSample', DnaWritingSampleEntityMapper.getInstance());
  }

  /** Vault-Transit (hope-phi) encrypt — the same helper the DNA report text uses. */
  async encryptText(secrets: SecretsServiceLike, plaintext: string): Promise<{ ciphertext: Buffer; keyVersion: number } | null> {
    return encryptStringToCiphertext(secrets, plaintext);
  }

  async decryptText(secrets: SecretsServiceLike, ciphertext: Buffer | Uint8Array | null | undefined): Promise<string | null> {
    return decryptCiphertextToString(secrets, ciphertext);
  }

  private toEntity(model: DnaWritingSample): DnaWritingSampleEntity {
    return (this as any)._mapper.toDomainEntity(model);
  }

  /** Dedupe lookup: a live sample with the same normalised-text hash for this doctor. */
  async findByContentHash(tenantId: string, doctorId: string, contentHash: string): Promise<DnaWritingSampleEntity | null> {
    const model = await this.db.findFirst({ where: { tenantId, doctorId, contentHash, resourceStatus: { not: 'DELETED' } } });
    return model ? this.toEntity(model) : null;
  }

  /** Unconsumed samples created at/after `since` for one doctor (R1 feedback). */
  async countUnconsumedSince(tenantId: string, doctorId: string, since: Date): Promise<number> {
    return this.db.count({
      where: { tenantId, doctorId, consumedByReportId: null, createdAt: { gte: since }, resourceStatus: { not: 'DELETED' } },
    });
  }

  /** Doctors with at least one unconsumed sample created at/after `since`. */
  async findDoctorIdsWithUnconsumedSince(tenantId: string, since: Date): Promise<string[]> {
    const groups: Array<{ doctorId: string }> = await this.db.groupBy({
      by: ['doctorId'],
      where: { tenantId, consumedByReportId: null, createdAt: { gte: since }, resourceStatus: { not: 'DELETED' } },
    });
    return groups.map((g) => g.doctorId);
  }

  /** Corpus input: live samples for a doctor, newest first. */
  async findForCorpus(tenantId: string, doctorId: string, limit: number): Promise<DnaWritingSampleEntity[]> {
    const models = await this.db.findMany({
      where: { tenantId, doctorId, resourceStatus: { not: 'DELETED' } },
      orderBy: [{ writtenAt: 'desc' }, { createdAt: 'desc' }],
      take: limit,
    });
    return models.map((m: DnaWritingSample) => this.toEntity(m));
  }

  /** Admin list, newest first. */
  async findPaginated(filter: DnaWritingSampleListFilter, page: number, limit: number): Promise<{ data: DnaWritingSampleEntity[]; count: number }> {
    const where: Record<string, unknown> = { tenantId: filter.tenantId, resourceStatus: { not: 'DELETED' } };
    if (filter.doctorId) where.doctorId = filter.doctorId;
    if (filter.source) where.source = filter.source;
    if (filter.consumed === true) where.consumedByReportId = { not: null };
    if (filter.consumed === false) where.consumedByReportId = null;
    const [models, count] = await Promise.all([
      this.db.findMany({ where, orderBy: [{ createdAt: 'desc' }], skip: (page - 1) * limit, take: limit }),
      this.db.count({ where }),
    ]);
    return { data: models.map((m: DnaWritingSample) => this.toEntity(m)), count };
  }

  /** Per-doctor roll-up across the tenant. */
  async summarizeByDoctor(tenantId: string): Promise<DnaWritingSampleDoctorSummary[]> {
    const base = { tenantId, resourceStatus: { not: 'DELETED' } };
    const [bySource, unconsumed]: [
      Array<{ doctorId: string; source: string; _count: { _all: number }; _max: { createdAt: Date | null } }>,
      Array<{ doctorId: string; _count: { _all: number } }>,
    ] = await Promise.all([
      this.db.groupBy({ by: ['doctorId', 'source'], where: base, _count: { _all: true }, _max: { createdAt: true } }),
      this.db.groupBy({ by: ['doctorId'], where: { ...base, consumedByReportId: null }, _count: { _all: true } }),
    ]);
    const out = new Map<string, DnaWritingSampleDoctorSummary>();
    for (const g of bySource) {
      const row = out.get(g.doctorId) ?? {
        doctorId: g.doctorId,
        total: 0,
        unconsumed: 0,
        bySource: { EDIT: 0, SIGNOFF: 0, INGEST: 0 },
        lastSampleAt: null,
      };
      row.total += g._count._all;
      row.bySource[g.source as 'EDIT' | 'SIGNOFF' | 'INGEST'] = g._count._all;
      const max = g._max.createdAt;
      if (max && (!row.lastSampleAt || max > row.lastSampleAt)) row.lastSampleAt = max;
      out.set(g.doctorId, row);
    }
    for (const g of unconsumed) {
      const row = out.get(g.doctorId);
      if (row) row.unconsumed = g._count._all;
    }
    return [...out.values()];
  }

  /** Stamp the samples a report was built from. */
  async markConsumed(tenantId: string, ids: string[], reportId: string, at: Date = new Date()): Promise<number> {
    if (ids.length === 0) return 0;
    const result = await this.db.updateMany({
      where: { tenantId, id: { in: ids }, consumedByReportId: null },
      data: { consumedByReportId: reportId, consumedAt: at, version: { increment: 1 } },
    });
    return result.count;
  }
}
