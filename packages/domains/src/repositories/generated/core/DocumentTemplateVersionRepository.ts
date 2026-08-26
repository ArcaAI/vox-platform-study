import { Injectable } from '@nestjs/common';
import { Prisma } from '@arcaai/database';
import { DataNotFoundException } from '@arcaai/exceptions';

import { Repository } from '../../../common';
import { CoreUnitOfWorkService } from '../../../common/unitsOfWork/core';
import { DocumentTemplateVersionEntity } from '../../../entities';
import { DocumentTemplateVersionEntityMapper } from '../../../mappers';
import { DocumentTemplateVersion } from '../../../models';

/**
 * Immutable published snapshots of a `DocumentTemplate`.
 *
 * Listed in `MODELS_WITHOUT_SOFT_DELETE`: the table has no `resourceStatus`
 * column, so `softDelete`/`restore` throw and reads must NOT filter on it. A
 * document generated against version N has to resolve version N forever, which
 * is precisely why retraction is not available here.
 *
 * `update` is never called on this model. Publishing writes a NEW row — and
 * unlike the `ConsultationContextSchemaVersion` precedent that is not left to
 * convention: a DB trigger refuses UPDATE and DELETE outright (OD-13), so a
 * call site that ignores this comment gets a `restrict_violation`, not a
 * silently rewritten clinical template.
 */
@Injectable()
export class DocumentTemplateVersionRepository extends Repository<DocumentTemplateVersionEntity, DocumentTemplateVersion> {
  constructor(private readonly unitOfWorkService: CoreUnitOfWorkService) {
    super(unitOfWorkService, 'documentTemplateVersion', DocumentTemplateVersionEntityMapper.getInstance());
  }

  /** One exact snapshot, or null. This is what generation resolves the PIN to. */
  async findByTemplateAndVersionNumber(templateId: string, versionNumber: number): Promise<DocumentTemplateVersionEntity | null> {
    return this.findFirstTolerant({ templateId, versionNumber });
  }

  /**
   * The highest-numbered snapshot for a template — the comparison basis for the
   * additive-vs-breaking classification and for allocating the next
   * `versionNumber`. Null before the first publish.
   */
  async findLatestForTemplate(templateId: string, tx?: Prisma.TransactionClient | any): Promise<DocumentTemplateVersionEntity | null> {
    if (tx) {
      const model = await (tx as Record<string, any>).documentTemplateVersion.findFirst({
        where: { templateId },
        orderBy: { versionNumber: 'desc' },
      });
      return model ? DocumentTemplateVersionEntityMapper.getInstance().toDomainEntity(model) : null;
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- see findAllForTemplate.
    const rows = await this.findAll({ filters: { templateId } as any, sort: [{ versionNumber: 'desc' }], limit: 1, page: 1 });
    return rows[0] ?? null;
  }

  /** Every snapshot of a template, newest first. */
  async findAllForTemplate(templateId: string): Promise<DocumentTemplateVersionEntity[]> {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- DbFilters<DocumentTemplateVersion> would require importing the Prisma-generated model type here.
    return this.findAll({ filters: { templateId } as any, sort: [{ versionNumber: 'desc' }] });
  }

  private async findFirstTolerant(filters: Record<string, unknown>): Promise<DocumentTemplateVersionEntity | null> {
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- see findAllForTemplate.
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
