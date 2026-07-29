import { Injectable } from '@nestjs/common';
import { Prisma } from '@arcaai/database';

import { Repository } from '../../../common';
import { PromptVersionEntityMapper } from '../../../mappers';
import { PromptVersionEntity } from '../../../entities';
import { PromptVersion } from '../../../models';
import { CoreUnitOfWorkService } from '../../../common/unitsOfWork/core';

@Injectable()
export class PromptVersionRepository extends Repository<PromptVersionEntity, PromptVersion> {
  constructor(private readonly unitOfWorkService: CoreUnitOfWorkService) {
    super(unitOfWorkService, 'promptVersion', PromptVersionEntityMapper.getInstance());
  }

  // ============================================
  // Custom Query Methods
  // ============================================

  /**
   * Find all versions for a prompt template
   */
  async findByTemplate(templateId: string): Promise<PromptVersionEntity[]> {
    return this.findAll({
      filters: {
        promptTemplateId: templateId,
      },
      sort: [{ versionNumber: 'desc' }],
    });
  }

  /**
   * Find a specific version by template ID and version number
   */
  async findByVersionNumber(templateId: string, versionNumber: number): Promise<PromptVersionEntity | null> {
    try {
      return await this.findFirst({
        filters: {
          promptTemplateId: templateId,
          versionNumber,
        },
      });
    } catch {
      return null;
    }
  }

  /**
   * Find the latest version for a prompt template
   */
  async findLatestVersion(templateId: string): Promise<PromptVersionEntity | null> {
    try {
      return await this.findFirst({
        filters: {
          promptTemplateId: templateId,
        },
        sort: [{ versionNumber: 'desc' }],
      });
    } catch {
      return null;
    }
  }

  /**
   * Highest persisted `versionNumber` for a template, or 0 when none exist.
   *
   * CC-01 — the versioned-update path computes the next version as
   * `max(versionNumber) + 1` rather than `currentVersionNumber + 1`, so a
   * lagging row counter (or an orphaned history row left by a prior partial
   * write) cannot recompute an existing `versionNumber` and trip the
   * `(promptTemplateId, versionNumber)` unique constraint — which would
   * permanently brick further edits of the template.
   *
   * When `tx` is supplied the aggregate is issued through the interactive
   * transaction client so the read shares the same snapshot as the version
   * insert + CAS it guards (mirrors the `create(entity, tx)` /
   * `updateWithVersion(..., tx)` contract).
   */
  async findMaxVersionNumber(templateId: string, tx?: Prisma.TransactionClient | any): Promise<number> {
    const model: any = tx ? (tx as Record<string, any>)[this._modelName] : this.db;
    const result = await model.aggregate({
      where: { promptTemplateId: templateId },
      _max: { versionNumber: true },
    });
    return result?._max?.versionNumber ?? 0;
  }
}
