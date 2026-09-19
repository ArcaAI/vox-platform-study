import { Injectable } from '@nestjs/common';

import { Repository } from '../../../common';
import { ContextItemEntityMapper } from '../../../mappers';
import { ContextItemEntity } from '../../../entities';
import { ContextItem } from '../../../models';
import { CoreUnitOfWorkService } from '../../../common/unitsOfWork/core';
import { ResourceStatusType, ContextItemType, ContextItemSource } from '../../../enums';

@Injectable()
export class ContextItemRepository extends Repository<ContextItemEntity, ContextItem> {
  constructor(private readonly unitOfWorkService: CoreUnitOfWorkService) {
    super(unitOfWorkService, 'contextItem', ContextItemEntityMapper.getInstance());
  }

  // ============================================
  // Custom Query Methods
  // ============================================

  /**
   * Find all context items for a consultation
   */
  async findByConsultation(consultationId: string, filters?: { type?: ContextItemType; source?: ContextItemSource }): Promise<ContextItemEntity[]> {
    const whereClause: Record<string, unknown> = {
      consultationId,
      resourceStatus: ResourceStatusType.ENABLED,
    };

    if (filters?.type) {
      whereClause.type = filters.type;
    }
    if (filters?.source) {
      whereClause.source = filters.source;
    }

    return this.findAll({
      filters: whereClause as any,
      sort: [{ createdAt: 'asc' }],
    });
  }

  /**
   * Find transcripts for a consultation
   */
  async findTranscripts(consultationId: string): Promise<ContextItemEntity[]> {
    return this.findByConsultation(consultationId, { type: ContextItemType.TRANSCRIPT });
  }

  /**
   * Find case notes for a consultation
   */
  async findCaseNotes(consultationId: string): Promise<ContextItemEntity[]> {
    return this.findByConsultation(consultationId, { type: ContextItemType.CASE_NOTE });
  }

  /**
   * The NEWEST context item a consultation carries under a tenant-declared KIND KEY, or `null`.
   *
   * Every other finder here selects by {@link ContextItemType} — the PLATFORM's vocabulary. What a
   * client states at `open` is addressed by `kindKey`, the name the tenant's own consultation
   * context schema declares and the writer stamps, and this is the read for it. Filtering on the
   * kind key ALONE (never also on a type) is deliberate: binding the read to a type as well would
   * make it disagree with the writer the moment either side chose a different enum member for the
   * same declared kind.
   *
   * NEWEST rather than first: a kind declared `ONE` is written once at `open`, but a re-open or a
   * later correction can leave two rows behind, and a reader must see what the client last said.
   * `ContextItem_consultation_kindKey_idx` is the index this rides.
   *
   * Answers `null` rather than throwing on a read failure, mirroring `findLatestPreSummary`: the
   * callers are prompt CONTEXT, so an unreadable row must degrade to "the client sent nothing"
   * rather than stop a clinical note being produced.
   */
  async findLatestByKindKey(consultationId: string, kindKey: string, tx?: unknown): Promise<ContextItemEntity | null> {
    try {
      const delegate = tx ? (tx as Record<string, any>)[(this as any)._modelName] : (this as any).db;
      const model = await delegate.findFirst({
        where: {
          consultationId,
          kindKey,
          resourceStatus: ResourceStatusType.ENABLED,
        },
        orderBy: { createdAt: 'desc' },
      });
      if (!model) return null;
      return (this as any)._mapper.toDomainEntity(model);
    } catch {
      return null;
    }
  }

  /**
   * Find worknotes for a consultation
   */
  async findWorknotes(consultationId: string): Promise<ContextItemEntity[]> {
    return this.findByConsultation(consultationId, { type: ContextItemType.WORKNOTE });
  }

  /**
   * Find summaries for a consultation (raw, modified, and pre-summaries)
   */
  async findSummaries(consultationId: string): Promise<ContextItemEntity[]> {
    const models = await (this as any).db.findMany({
      where: {
        consultationId,
        OR: [{ type: ContextItemType.RAW_SUMMARY }, { type: ContextItemType.MODIFIED_SUMMARY }, { type: ContextItemType.PRE_SUMMARY }],
        resourceStatus: ResourceStatusType.ENABLED,
      },
      orderBy: { createdAt: 'desc' },
      include: { SummaryMeta: true },
    });

    return models.map((model: ContextItem) => (this as any)._mapper.toDomainEntity(model));
  }

  /**
   * Find final summaries for a consultation (raw and modified only, excludes pre-summaries)
   */
  async findFinalSummaries(consultationId: string): Promise<ContextItemEntity[]> {
    const models = await (this as any).db.findMany({
      where: {
        consultationId,
        OR: [{ type: ContextItemType.RAW_SUMMARY }, { type: ContextItemType.MODIFIED_SUMMARY }],
        resourceStatus: ResourceStatusType.ENABLED,
      },
      orderBy: { createdAt: 'desc' },
    });

    return models.map((model: ContextItem) => (this as any)._mapper.toDomainEntity(model));
  }

  /**
   * Final summaries (RAW or MODIFIED) written under a DOCTOR, newest first.
   *
   * `ContextItem` carries no `doctorId` — the doctor lives on the parent consultation
   * (`Consultation.doctorId`), so the selection rides the relation rather than a scalar
   * column, which is also why it cannot be expressed through the generic `findAll`
   * props (`DbFilters<T>` is keyed on scalars only).
   *
   * The TYPE constraint belongs IN the query for the same reason `take` does: a caller
   * that fetched the newest `limit` items and filtered to summaries afterwards would
   * spend its whole budget on transcripts, case notes and audio rows and come back with
   * nothing. Both bounds have to be applied by the database or neither is real.
   *
   * Consumer: the DNA writing-style corpus (`dna-writing-style.processor.ts`), which then
   * keeps only the items carrying an `approved` version.
   */
  async findFinalSummariesByDoctor(doctorId: string, limit: number): Promise<ContextItemEntity[]> {
    const models = await this.db.findMany({
      where: {
        Consultation: { doctorId },
        type: { in: [ContextItemType.RAW_SUMMARY, ContextItemType.MODIFIED_SUMMARY] },
        resourceStatus: ResourceStatusType.ENABLED,
      },
      orderBy: { createdAt: 'desc' },
      take: limit,
    });

    // `this.db` is the protected delegate (decrypt-on-read wrapped), and the base class's
    // `_mapper` is PRIVATE — so map through the same singleton the constructor handed it,
    // as `AiPriceBookRepository.findByBookVersion` does. No `any` casts in this method.
    const mapper = ContextItemEntityMapper.getInstance();
    return models.map((model: ContextItem) => mapper.toDomainEntity(model));
  }

  /**
   * Find pre-summaries for a consultation
   */
  async findPreSummaries(consultationId: string): Promise<ContextItemEntity[]> {
    return this.findByConsultation(consultationId, { type: ContextItemType.PRE_SUMMARY });
  }

  /**
   * Find latest pre-summary for a consultation
   */
  async findLatestPreSummary(consultationId: string): Promise<ContextItemEntity | null> {
    try {
      const model = await (this as any).db.findFirst({
        where: {
          consultationId,
          type: ContextItemType.PRE_SUMMARY,
          resourceStatus: ResourceStatusType.ENABLED,
        },
        orderBy: { createdAt: 'desc' },
      });
      if (!model) return null;
      return (this as any)._mapper.toDomainEntity(model);
    } catch {
      return null;
    }
  }

  /**
   * Find latest raw summary for a consultation
   */
  async findLatestRawSummary(consultationId: string): Promise<ContextItemEntity | null> {
    try {
      const model = await (this as any).db.findFirst({
        where: {
          consultationId,
          type: ContextItemType.RAW_SUMMARY,
          resourceStatus: ResourceStatusType.ENABLED,
        },
        orderBy: { createdAt: 'desc' },
      });
      if (!model) return null;
      return (this as any)._mapper.toDomainEntity(model);
    } catch {
      return null;
    }
  }

  /**
   * Find latest modified summary for a consultation
   */
  async findLatestModifiedSummary(consultationId: string): Promise<ContextItemEntity | null> {
    try {
      const model = await (this as any).db.findFirst({
        where: {
          consultationId,
          type: ContextItemType.MODIFIED_SUMMARY,
          resourceStatus: ResourceStatusType.ENABLED,
        },
        orderBy: { createdAt: 'desc' },
      });
      if (!model) return null;
      return (this as any)._mapper.toDomainEntity(model);
    } catch {
      return null;
    }
  }

  /**
   * Find shared context from all consultations in a chain
   */
  async findSharedContext(consultationIds: string[]): Promise<ContextItemEntity[]> {
    const models = await (this as any).db.findMany({
      where: {
        consultationId: { in: consultationIds },
        resourceStatus: ResourceStatusType.ENABLED,
      },
      orderBy: { createdAt: 'asc' },
    });

    return models.map((model: ContextItem) => (this as any)._mapper.toDomainEntity(model));
  }

  /**
   * Find case notes from all consultations in a chain
   * Case notes are shared across linked consultations as additional context
   */
  async findCaseNotesFromChain(consultationIds: string[]): Promise<ContextItemEntity[]> {
    const models = await (this as any).db.findMany({
      where: {
        consultationId: { in: consultationIds },
        type: ContextItemType.CASE_NOTE,
        resourceStatus: ResourceStatusType.ENABLED,
      },
      orderBy: { createdAt: 'asc' },
    });

    return models.map((model: ContextItem) => (this as any)._mapper.toDomainEntity(model));
  }

  /**
   * Find AI-generated context items for a consultation
   */
  async findAiGenerated(consultationId: string): Promise<ContextItemEntity[]> {
    return this.findByConsultation(consultationId, { source: ContextItemSource.AI });
  }

  /**
   * Find user-entered context items for a consultation
   */
  async findUserEntered(consultationId: string): Promise<ContextItemEntity[]> {
    return this.findByConsultation(consultationId, { source: ContextItemSource.USER });
  }

  /**
   * Find context items by type
   */
  async findByType(consultationId: string, type: ContextItemType): Promise<ContextItemEntity[]> {
    return this.findByConsultation(consultationId, { type });
  }

  /**
   * Count context items by type for a consultation
   */
  async countByType(consultationId: string, type: ContextItemType): Promise<number> {
    return this.count({
      filters: {
        consultationId,
        type,
        resourceStatus: ResourceStatusType.ENABLED,
      } as any,
    });
  }

  // ============================================
  // Qdrant Sync Methods
  // ============================================

  /**
   * Find items that need Qdrant sync
   */
  async findNeedingQdrantSync(limit: number = 100): Promise<ContextItemEntity[]> {
    const models = await (this as any).db.findMany({
      where: {
        qdrantSynced: false,
        resourceStatus: ResourceStatusType.ENABLED,
        // Only sync text content types
        type: {
          in: [
            ContextItemType.TRANSCRIPT,
            ContextItemType.RAW_SUMMARY,
            ContextItemType.MODIFIED_SUMMARY,
            ContextItemType.PRE_SUMMARY,
            ContextItemType.WORKNOTE,
            ContextItemType.CASE_NOTE,
          ],
        },
      },
      orderBy: { createdAt: 'asc' },
      take: limit,
    });

    return models.map((model: ContextItem) => (this as any)._mapper.toDomainEntity(model));
  }

  /**
   * Mark item as synced to Qdrant
   */
  async markQdrantSynced(id: string): Promise<void> {
    await (this as any).db.update({
      where: { id },
      data: {
        qdrantSynced: true,
        qdrantSyncedAt: new Date(),
      },
    });
  }

  /**
   * Mark multiple items as synced to Qdrant
   */
  async markManyQdrantSynced(ids: string[]): Promise<void> {
    await (this as any).db.updateMany({
      where: { id: { in: ids } },
      data: {
        qdrantSynced: true,
        qdrantSyncedAt: new Date(),
      },
    });
  }

  // ============================================
  // Audio Recording Methods
  // ============================================

  /**
   * Find audio recording containers for a consultation
   */
  async findAudioRecordings(consultationId: string): Promise<ContextItemEntity[]> {
    return this.findByConsultation(consultationId, { type: ContextItemType.AUDIO_RECORDING });
  }

  /**
   * Find attachments for a consultation
   */
  async findAttachments(consultationId: string): Promise<ContextItemEntity[]> {
    return this.findByConsultation(consultationId, { type: ContextItemType.ATTACHMENT });
  }

  // ============================================
  // Include Relations Methods
  // ============================================

  /**
   * Find context item with version history
   */
  async findWithVersions(id: string): Promise<ContextItemEntity | null> {
    try {
      const model = await (this as any).db.findFirst({
        where: {
          id,
          resourceStatus: ResourceStatusType.ENABLED,
        },
        include: {
          Versions: {
            orderBy: { versionNumber: 'desc' },
          },
        },
      });
      if (!model) return null;
      return (this as any)._mapper.toDomainEntity(model);
    } catch {
      return null;
    }
  }

  /**
   * Find context item with audio recordings
   */
  async findWithAudioRecordings(id: string): Promise<ContextItemEntity | null> {
    try {
      const model = await (this as any).db.findFirst({
        where: {
          id,
          resourceStatus: ResourceStatusType.ENABLED,
        },
        include: {
          AudioRecordings: {
            orderBy: { sequenceNumber: 'asc' },
          },
        },
      });
      if (!model) return null;
      return (this as any)._mapper.toDomainEntity(model);
    } catch {
      return null;
    }
  }

  /**
   * Find context item with summary metadata
   */
  async findWithSummaryMeta(id: string): Promise<ContextItemEntity | null> {
    try {
      const model = await (this as any).db.findFirst({
        where: {
          id,
          resourceStatus: ResourceStatusType.ENABLED,
        },
        include: {
          SummaryMeta: true,
        },
      });
      if (!model) return null;
      return (this as any)._mapper.toDomainEntity(model);
    } catch {
      return null;
    }
  }

  /**
   * Find context item with named entities
   */
  async findWithNamedEntities(id: string): Promise<ContextItemEntity | null> {
    try {
      const model = await (this as any).db.findFirst({
        where: {
          id,
          resourceStatus: ResourceStatusType.ENABLED,
        },
        include: {
          NamedEntities: {
            orderBy: { startOffset: 'asc' },
          },
        },
      });
      if (!model) return null;
      return (this as any)._mapper.toDomainEntity(model);
    } catch {
      return null;
    }
  }

  /**
   * Find context item with all relations
   */
  async findWithAllRelations(id: string): Promise<ContextItemEntity | null> {
    try {
      const model = await (this as any).db.findFirst({
        where: {
          id,
          resourceStatus: ResourceStatusType.ENABLED,
        },
        include: {
          AudioRecordings: { orderBy: { sequenceNumber: 'asc' } },
          SummaryMeta: true,
          NamedEntities: { orderBy: { startOffset: 'asc' } },
          Versions: { orderBy: { versionNumber: 'desc' } },
        },
      });
      if (!model) return null;
      return (this as any)._mapper.toDomainEntity(model);
    } catch {
      return null;
    }
  }

  /**
   * Find context items by DNA writing style
   */
  async findByDnaWritingStyle(dnaWritingStyleId: string): Promise<ContextItemEntity[]> {
    const models = await (this as any).db.findMany({
      where: {
        dnaWritingStyleId,
        resourceStatus: ResourceStatusType.ENABLED,
      },
      orderBy: { createdAt: 'desc' },
    });

    return models.map((model: ContextItem) => (this as any)._mapper.toDomainEntity(model));
  }
}
