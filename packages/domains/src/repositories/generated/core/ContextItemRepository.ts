import { Injectable } from '@nestjs/common';

import { Repository } from '../../../common';
import { ContextItemEntityMapper } from '../../../mappers';
import { ContextItemEntity } from '../../../entities';
import { ContextItem } from '../../../models';
import { CoreUnitOfWorkService } from '../../../common/unitsOfWork/core';
import { ResourceStatusType, ContextItemType, ContextItemSource, GuardrailItemStatus } from '../../../enums';
import { removeNullValues } from '../../../common/removeNullValues';
import { ArgumentInvalidException } from '@arcaai/exceptions';
import { Prisma } from '@arcaai/database';

/** Optional narrowing for {@link ContextItemRepository.findSegments}. */
export interface SegmentReadFilters {
  encounterSeq?: number;
  /** Inclusive lower bound on `segmentSeq`. */
  fromSeq?: number;
  /** Inclusive upper bound on `segmentSeq`. */
  toSeq?: number;
}

/** Outcome of {@link ContextItemRepository.createSegmentsBatch}. */
export interface SegmentBatchResult {
  /** The rows this call inserted, in `segmentSeq` order. */
  inserted: ContextItemEntity[];
  /** `segmentKey`s that already existed (idempotent replays). */
  duplicateKeys: string[];
}

/**
 * TASK-999 — PHI-safe length rollup for one `(consultation, type)` pair.
 *
 * `count` is every ENABLED item of that type. `measuredCount` is the subset
 * carrying a non-NULL `contentWordCount`. `wordCount`/`charCount` sum the
 * measured subset only, and are NULL when `measuredCount` is 0 — "unknown" and
 * "zero" are different answers for a telemetry pane.
 */
export interface ContextItemContentCounts {
  count: number;
  measuredCount: number;
  wordCount: number | null;
  charCount: number | null;
}

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
   * TASK-999 — how many context items of one TYPE a consultation carries, and
   * the totals of the write-time length counters, WITHOUT reading a single row.
   *
   * ## Why this is not `findCaseNotes(...).length`
   *
   * The plaintext `content` column was DROPPED; the body survives only as
   * Vault-Transit ciphertext, and the base `db` getter wraps the delegate with
   * decrypt-on-read (`phi-read-decrypt.ts`). So ANY row-returning finder here
   * pulls every case-note body through a Vault batch decrypt — which is exactly
   * what an admin telemetry read must not do to produce a number (TASK-999
   * D-3(a): counters are written at write time so the read never decrypts).
   *
   * `count`/`aggregate` return non-row shapes and are deliberately absent from
   * `DECRYPT_METHODS`, so they pass through the proxy untouched. This method
   * therefore reads counters and nothing else — no ciphertext leaves Postgres.
   *
   * ## Why `measuredCount` is separate from `count`
   *
   * `contentWordCount` is NULL on every row written before TASK-999 and on any
   * writer that has not adopted the counters. NULL means NEVER MEASURED; 0
   * means a genuinely empty body. Summing over the measured subset while
   * reporting both totals lets a caller say "12 notes, 9 measured" instead of
   * implying the other three were empty. `wordCount`/`charCount` are NULL —
   * never 0 — when nothing was measured at all.
   */
  async aggregateContentCounts(consultationId: string, type: ContextItemType): Promise<ContextItemContentCounts> {
    const where = { consultationId, type, resourceStatus: ResourceStatusType.ENABLED };

    const [count, measured] = await Promise.all([
      this.db.count({ where }),
      this.db.aggregate({
        where: { ...where, contentWordCount: { not: null } },
        _count: { _all: true },
        _sum: { contentWordCount: true, contentCharCount: true },
      }),
    ]);

    const measuredCount = measured?._count?._all ?? 0;
    return {
      count,
      measuredCount,
      // `_sum` is null when nothing matched; keep NULL rather than coercing to
      // 0, which would read as "measured, and it was empty".
      wordCount: measuredCount > 0 ? (measured?._sum?.contentWordCount ?? null) : null,
      charCount: measuredCount > 0 ? (measured?._sum?.contentCharCount ?? null) : null,
    };
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
   * TASK-999 — the id of the NEWEST ENABLED item of each requested type, and
   * nothing else.
   *
   * Exists so a caller that only needs to JOIN onward (the telemetry pane looks
   * up `SummaryMeta` by `contextItemId`) never materialises a body. The
   * projected `select` omits `encryptedContent`, and the decrypt-on-read walker
   * skips any registered ciphertext column that is not present in the row — so
   * this read is decrypt-free even though `findMany` is otherwise a decrypting
   * method. `findLatestPreSummary` / `findLatestRawSummary` /
   * `findLatestModifiedSummary` all return whole rows and are the right call
   * when the body IS wanted; they are the wrong call when only the id is.
   *
   * One query for every type asked for. A type with no item is absent from the
   * returned map (not null-valued), so `Object.hasOwn` and a plain lookup agree.
   */
  async findLatestIdsByTypes(consultationId: string, types: ContextItemType[]): Promise<Partial<Record<ContextItemType, string>>> {
    if (types.length === 0) return {};

    const rows = await this.db.findMany({
      where: {
        consultationId,
        type: { in: types },
        resourceStatus: ResourceStatusType.ENABLED,
      },
      select: { id: true, type: true, createdAt: true },
      orderBy: [{ createdAt: 'desc' }],
    });

    const latest: Partial<Record<ContextItemType, string>> = {};
    for (const row of rows as Array<{ id: string; type: ContextItemType }>) {
      // Rows arrive newest-first, so the FIRST sighting of a type is its latest.
      if (latest[row.type] === undefined) latest[row.type] = row.id;
    }
    return latest;
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
   * Find latest pre-summary for a consultation.
   *
   * BUG-025 — `excludeSubTypes` skips rows by `metaData.subType` (the live note's durable
   * `LIVE_SOAP_SNAPSHOT` is stored as a PRE_SUMMARY too). Filtered after an ordered read rather than
   * in SQL: a JSON-path `NOT` would also drop rows with no `subType`, since the comparison is NULL.
   */
  async findLatestPreSummary(consultationId: string, options?: { excludeSubTypes?: readonly string[] }): Promise<ContextItemEntity | null> {
    try {
      const query = {
        where: {
          consultationId,
          type: ContextItemType.PRE_SUMMARY,
          resourceStatus: ResourceStatusType.ENABLED,
        },
        orderBy: { createdAt: 'desc' },
      };
      const excluded = options?.excludeSubTypes ?? [];
      const model =
        excluded.length === 0
          ? await (this as any).db.findFirst(query)
          : ((await (this as any).db.findMany(query)) as Array<{ metaData?: unknown }>).find(
              (row) => !excluded.includes((row.metaData as Record<string, unknown> | null | undefined)?.subType as string),
            );
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
  // TASK-1050 — guardrail marker (outside OCC, OD-21)
  // ============================================

  /**
   * Set the denormalised guardrail marker of one item. Writes ONLY the
   * `guardrailStatus` column and never increments `_version`, so a background
   * verdict never makes a clinician's open editor 412. Pass `tx` to write in
   * the same transaction as the GuardrailEvaluation the marker derives from.
   */
  async setGuardrailStatus(id: string, status: GuardrailItemStatus, tx?: Prisma.TransactionClient | any): Promise<void> {
    const delegate = tx ? (tx as Record<string, any>).contextItem : (this as any).db;
    await delegate.update({ where: { id }, data: { guardrailStatus: status } });
  }

  /**
   * {@link setGuardrailStatus} for many items in one write — an inbound
   * transcript window spans many TRANSCRIPT_SEGMENT items (§9.7.4). Returns the
   * number of rows marked; an empty list touches nothing.
   */
  async setGuardrailStatusMany(ids: string[], status: GuardrailItemStatus, tx?: Prisma.TransactionClient | any): Promise<number> {
    if (ids.length === 0) return 0;
    const delegate = tx ? (tx as Record<string, any>).contextItem : (this as any).db;
    const { count } = await delegate.updateMany({ where: { id: { in: ids } }, data: { guardrailStatus: status } });
    return count;
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

  // ============================================
  // Consultation record model (transcript segments + per-encounter artifacts)
  // ============================================

  /**
   * The consultation's TRANSCRIPT_SEGMENT items in `segmentSeq` order,
   * optionally narrowed to one encounter and/or an inclusive seq range.
   */
  async findSegments(consultationId: string, filters: SegmentReadFilters = {}): Promise<ContextItemEntity[]> {
    const where: Record<string, unknown> = {
      consultationId,
      type: ContextItemType.TRANSCRIPT_SEGMENT,
      resourceStatus: ResourceStatusType.ENABLED,
    };
    if (filters.encounterSeq !== undefined) where.encounterSeq = filters.encounterSeq;
    if (filters.fromSeq !== undefined || filters.toSeq !== undefined) {
      where.segmentSeq = {
        ...(filters.fromSeq !== undefined ? { gte: filters.fromSeq } : {}),
        ...(filters.toSeq !== undefined ? { lte: filters.toSeq } : {}),
      };
    }
    const models = await (this as any).db.findMany({ where, orderBy: [{ segmentSeq: 'asc' }] });
    return models.map((model: ContextItem) => (this as any)._mapper.toDomainEntity(model));
  }

  /**
   * The consultation's single live FULL_TRANSCRIPT item (rebuilt from the
   * segments; at most one per consultation by partial unique index), or `null`.
   */
  async findFullTranscript(consultationId: string): Promise<ContextItemEntity | null> {
    const model = await (this as any).db.findFirst({
      where: { consultationId, type: ContextItemType.FULL_TRANSCRIPT, resourceStatus: ResourceStatusType.ENABLED },
    });
    return model ? (this as any)._mapper.toDomainEntity(model) : null;
  }

  /**
   * The live FACT_LEDGER or ENCOUNTER_RECAP item of one encounter (at most one
   * each by partial unique index), or `null`.
   */
  async findEncounterArtifact(
    consultationId: string,
    type: ContextItemType.FACT_LEDGER | ContextItemType.ENCOUNTER_RECAP,
    encounterSeq: number,
  ): Promise<ContextItemEntity | null> {
    const model = await (this as any).db.findFirst({
      where: { consultationId, type, encounterSeq, resourceStatus: ResourceStatusType.ENABLED },
    });
    return model ? (this as any)._mapper.toDomainEntity(model) : null;
  }

  /**
   * Insert a batch of TRANSCRIPT_SEGMENT items in ONE `createMany`, idempotent
   * on `segmentKey`: a key that already exists for the consultation (partial
   * unique index `ContextItem_segmentKey_uq`) is skipped, never an error.
   * Every entity must carry its own id and `segmentKey` (and its ciphertext —
   * this method does not encrypt). Version rows are the caller's to write for
   * `inserted`, in the same transaction when `tx` is given.
   */
  async createSegmentsBatch(entities: ContextItemEntity[], tx?: Prisma.TransactionClient | any): Promise<SegmentBatchResult> {
    if (entities.length === 0) return { inserted: [], duplicateKeys: [] };
    for (const entity of entities) {
      if (!entity.segmentKey) {
        throw new ArgumentInvalidException('createSegmentsBatch: every segment needs a segmentKey');
      }
    }

    const delegate = tx ? (tx as Record<string, any>).contextItem : (this as any).db;
    const data = entities.map((entity) => removeNullValues((this as any)._mapper.toPersistence(entity)));
    await delegate.createMany({ data, skipDuplicates: true });

    const ids = entities.map((entity) => entity.id);
    const models = await delegate.findMany({ where: { id: { in: ids } }, orderBy: [{ segmentSeq: 'asc' }] });
    const inserted: ContextItemEntity[] = models.map((model: ContextItem) => (this as any)._mapper.toDomainEntity(model));
    const insertedIds = new Set(inserted.map((entity) => entity.id));
    const duplicateKeys = entities.filter((entity) => !insertedIds.has(entity.id)).map((entity) => entity.segmentKey as string);
    return { inserted, duplicateKeys };
  }
}
