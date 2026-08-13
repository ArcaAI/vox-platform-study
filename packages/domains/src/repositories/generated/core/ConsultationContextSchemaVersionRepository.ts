import { Injectable } from '@nestjs/common';
import { Prisma } from '@arcaai/database';
import { DataNotFoundException } from '@arcaai/exceptions';

import { Repository } from '../../../common';
import { CoreUnitOfWorkService } from '../../../common/unitsOfWork/core';
import { ConsultationContextSchemaVersionEntity } from '../../../entities';
import { ConsultationContextSchemaVersionEntityMapper } from '../../../mappers';
import { ConsultationContextSchemaVersion } from '../../../models';

/**
 * Immutable published snapshots of a `ConsultationContextSchema`.
 *
 * Listed in `MODELS_WITHOUT_SOFT_DELETE`: the table has no `resourceStatus`
 * column, so `softDelete`/`restore` throw and reads must NOT filter on it. A
 * context item validated against version N has to resolve version N forever,
 * which is precisely why retraction is not available here.
 *
 * `update` is never called on this model. Publishing writes a NEW row.
 */
@Injectable()
export class ConsultationContextSchemaVersionRepository extends Repository<
  ConsultationContextSchemaVersionEntity,
  ConsultationContextSchemaVersion
> {
  constructor(private readonly unitOfWorkService: CoreUnitOfWorkService) {
    super(unitOfWorkService, 'consultationContextSchemaVersion', ConsultationContextSchemaVersionEntityMapper.getInstance());
  }

  /** One exact snapshot, or null. This is what payload validation resolves the PIN to. */
  async findBySchemaAndVersionNumber(schemaId: string, versionNumber: number): Promise<ConsultationContextSchemaVersionEntity | null> {
    return this.findFirstTolerant({ schemaId, versionNumber });
  }

  /**
   * The highest-numbered snapshot for a schema — the comparison basis for the
   * additive-vs-breaking classification and for allocating the next
   * `versionNumber`. Null before the first publish.
   */
  async findLatestForSchema(schemaId: string, tx?: Prisma.TransactionClient | any): Promise<ConsultationContextSchemaVersionEntity | null> {
    if (tx) {
      const model = await (tx as Record<string, any>).consultationContextSchemaVersion.findFirst({
        where: { schemaId },
        orderBy: { versionNumber: 'desc' },
      });
      return model ? ConsultationContextSchemaVersionEntityMapper.getInstance().toDomainEntity(model) : null;
    }
    const rows = await this.findAll({ filters: { schemaId } as any, sort: [{ versionNumber: 'desc' }], limit: 1, page: 1 });
    return rows[0] ?? null;
  }

  /** Every snapshot of a schema, newest first. */
  async findAllForSchema(schemaId: string): Promise<ConsultationContextSchemaVersionEntity[]> {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- DbFilters<ConsultationContextSchemaVersion> would require importing the Prisma-generated model type here.
    return this.findAll({ filters: { schemaId } as any, sort: [{ versionNumber: 'desc' }] });
  }

  private async findFirstTolerant(filters: Record<string, unknown>): Promise<ConsultationContextSchemaVersionEntity | null> {
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- see findAllForSchema.
      const result = await this.findFirst({ filters: filters as any });
      return result ?? null;
    } catch (err) {
      if (err instanceof DataNotFoundException) {
        return null;
      }
      throw err;
    }
  }
}
