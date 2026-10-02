import { Inject, Injectable } from '@nestjs/common';

import { Repository } from '../../../common';
import { CoreDatabaseService } from '../../../common/databaseServices/core/core.database.service';
import { CoreUnitOfWorkService } from '../../../common/unitsOfWork/core';
import { type SecretsServiceLike, decryptCiphertextToString, encryptStringToCiphertext } from '../../../common/field-encryption';
import { ComposedPromptRecordEntity } from '../../../entities';
import { ResourceStatusType } from '../../../enums';
import { ComposedPromptRecordEntityMapper } from '../../../mappers';
import { ComposedPromptRecord } from '../../../models';

/**
 * The composed-prompt incident records (OD-9). Every read names `tenantId` explicitly; the two
 * retention methods are the sanctioned cross-tenant maintenance path and use the base client.
 */
@Injectable()
export class ComposedPromptRecordRepository extends Repository<ComposedPromptRecordEntity, ComposedPromptRecord> {
  constructor(
    private readonly unitOfWorkService: CoreUnitOfWorkService,
    @Inject('CORE_DATABASE_SERVICE') private readonly databaseService: CoreDatabaseService,
  ) {
    super(unitOfWorkService, 'composedPromptRecord', ComposedPromptRecordEntityMapper.getInstance());
  }

  /**
   * The base Prisma client's delegate — NO tenant-scope and NO soft-delete extension. Used ONLY by
   * the retention purge, a tenant-less daily job whose job is to find and HARD-delete expired rows
   * across every tenant.
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private get unscoped(): any {
    return (this.databaseService.baseClient as unknown as Record<string, unknown>).composedPromptRecord;
  }

  private toEntity(model: ComposedPromptRecord): ComposedPromptRecordEntity {
    return ComposedPromptRecordEntityMapper.getInstance().toDomainEntity(model);
  }

  /**
   * Vault-Transit (hope-phi) encrypt. An EMPTY message (an invocation with no input) is stored as
   * zero bytes: there is nothing to protect and the column is NOT NULL.
   */
  async encryptText(secrets: SecretsServiceLike, plaintext: string): Promise<{ ciphertext: Buffer; keyVersion: number | null }> {
    const encrypted = await encryptStringToCiphertext(secrets, plaintext);
    return encrypted ?? { ciphertext: Buffer.alloc(0), keyVersion: null };
  }

  async decryptText(secrets: SecretsServiceLike, ciphertext: Buffer | Uint8Array | null | undefined): Promise<string> {
    return (await decryptCiphertextToString(secrets, ciphertext)) ?? '';
  }

  /** One tenant's records, newest first, optionally for one consultation. */
  async findPage(
    tenantId: string,
    filter: { consultationId?: string },
    page: number,
    limit: number,
  ): Promise<{ data: ComposedPromptRecordEntity[]; count: number }> {
    const where: Record<string, unknown> = { tenantId, resourceStatus: { not: ResourceStatusType.DELETED } };
    if (filter.consultationId) where.consultationId = filter.consultationId;
    const [models, count] = await Promise.all([
      this.db.findMany({ where, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], skip: (page - 1) * limit, take: limit }),
      this.db.count({ where }),
    ]);
    return { data: (models as ComposedPromptRecord[]).map((model) => this.toEntity(model)), count };
  }

  /** Every tenant that holds a record created before `before` — the retention purge's work list. */
  async findTenantIdsWithRecordsBefore(before: Date): Promise<string[]> {
    const groups: Array<{ tenantId: string }> = await this.unscoped.groupBy({ by: ['tenantId'], where: { createdAt: { lt: before } } });
    return groups.map((group) => group.tenantId);
  }

  /**
   * HARD-delete one tenant's records created before `cutoff`. Sanctioned: a composed prompt is an
   * expired PHI audit copy once its retention window passes, so it is removed, not soft-deleted.
   */
  async hardDeleteBefore(tenantId: string, cutoff: Date): Promise<number> {
    const result: { count: number } = await this.unscoped.deleteMany({ where: { tenantId, createdAt: { lt: cutoff } } });
    return result.count;
  }
}
