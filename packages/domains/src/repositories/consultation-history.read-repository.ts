import { Injectable } from '@nestjs/common';

import { CoreUnitOfWorkService } from '../common/unitsOfWork/core';
import { getPhiReadSecrets, wrapDelegateWithPhiDecrypt } from '../common/phi-read-decrypt';
import { ContextItemSource, ContextItemType, ResourceStatusType } from '../enums';

/** One context item as the history feed lists it — identity and timeline columns, never a body. */
export interface HistoryItemRow {
  id: string;
  type: ContextItemType;
  source: ContextItemSource | string;
  encounterSeq: number | null;
  segmentSeq: number | null;
  speaker: string | null;
  t0Ms: number | null;
  t1Ms: number | null;
  occurredAt: Date;
  currentVersionNumber: number;
  mediaId: string | null;
  createdBy: string | null;
  createdAt: Date;
}

/** One durable lifecycle moment of a consultation, read from its `lifecycle` audit rows. */
export interface HistoryLifecycleRow {
  id: string;
  createdAt: Date;
  data: Record<string, unknown> | null;
  responsibleUserId: string | null;
  responsibleServiceAccountId: string | null;
}

/** One version of an item without its snapshot. */
export interface HistoryVersionMetaRow {
  contextItemId: string;
  versionNumber: number;
  changeSource: string | null;
  changedBy: string | null;
  changeReason: string | null;
  createdAt: Date;
}

export interface HistoryItemHeader {
  id: string;
  consultationId: string;
  type: ContextItemType;
  currentVersionNumber: number;
}

export interface HistoryPageInput {
  tenantId: string;
  consultationId: string;
  /** Exclusive lower bound on `(occurredAt, id)`; null = from the start. */
  after: { at: Date; id: string } | null;
  take: number;
  types?: ContextItemType[];
  sources?: ContextItemSource[];
  encounterSeq?: number;
  editedOnly?: boolean;
  /** Inclusive `segmentSeq` bounds; rows without a `segmentSeq` never match a bound. */
  segmentSeqFrom?: number;
  segmentSeqTo?: number;
}

const ITEM_COLUMNS = {
  id: true,
  type: true,
  source: true,
  encounterSeq: true,
  segmentSeq: true,
  speaker: true,
  t0Ms: true,
  t1Ms: true,
  occurredAt: true,
  currentVersionNumber: true,
  mediaId: true,
  createdBy: true,
  createdAt: true,
  // TASK-1050: the denormalised guardrail marker (no ciphertext), for activity badges.
  guardrailStatus: true,
} as const;

/**
 * Read side of the consultation history feed.
 *
 * Every listing here selects named columns and leaves the ciphertext out, so the decrypt-on-read
 * wrapper has nothing to decrypt: listing a long consultation never pushes its transcript through
 * Vault. `readContents` is the one decrypting read, and its caller decides how many ids to pass.
 *
 * Reads go through the tenant-scoped extended client and also name the tenant explicitly.
 */
@Injectable()
export class ConsultationHistoryReadRepository {
  constructor(private readonly unitOfWorkService: CoreUnitOfWorkService) {}

  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- the two Prisma model delegates share no common type; each caller reads its own model's shape
  private delegate(model: 'contextItem' | 'contextItemVersion', decrypt = false): any {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- the database service is indexed by model name
    const delegate = (this.unitOfWorkService.getDatabaseService() as Record<string, any>)[model];
    return decrypt && getPhiReadSecrets() ? wrapDelegateWithPhiDecrypt(delegate, model) : delegate;
  }

  /** One page of items in `(occurredAt, id)` ascending order, after the keyset bound. */
  async pageItems(input: HistoryPageInput): Promise<HistoryItemRow[]> {
    const and: Record<string, unknown>[] = [
      { tenantId: input.tenantId, consultationId: input.consultationId, resourceStatus: ResourceStatusType.ENABLED },
    ];
    if (input.types) and.push({ type: { in: input.types } });
    if (input.sources) and.push({ source: { in: input.sources } });
    if (input.encounterSeq !== undefined) and.push({ encounterSeq: input.encounterSeq });
    if (input.editedOnly) and.push({ currentVersionNumber: { gt: 1 } });
    if (input.segmentSeqFrom !== undefined || input.segmentSeqTo !== undefined) {
      and.push({
        segmentSeq: {
          ...(input.segmentSeqFrom !== undefined ? { gte: input.segmentSeqFrom } : {}),
          ...(input.segmentSeqTo !== undefined ? { lte: input.segmentSeqTo } : {}),
        },
      });
    }
    if (input.after) {
      and.push({
        OR: [{ occurredAt: { gt: input.after.at } }, { AND: [{ occurredAt: input.after.at }, { id: { gt: input.after.id } }] }],
      });
    }
    return this.delegate('contextItem').findMany({
      where: { AND: and },
      select: ITEM_COLUMNS,
      orderBy: [{ occurredAt: 'asc' }, { id: 'asc' }],
      take: input.take,
    });
  }

  /**
   * The consultation's lifecycle moments, oldest first. Every lifecycle change (opened, closed,
   * reopened, ...) leaves one audit row (`data.action = 'lifecycle'`); the consultation row and its
   * encounters keep only the latest of each, so this is the one durable record of a repeated move.
   * Named columns only — the ciphertext columns are never read.
   */
  async listLifecycleEvents(tenantId: string, consultationId: string): Promise<HistoryLifecycleRow[]> {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- the database service is indexed by model name
    const delegate = (this.unitOfWorkService.getDatabaseService() as Record<string, any>)['auditLog'];
    return delegate.findMany({
      where: { tenantId, resourceType: 'Consultation', resourceId: consultationId, data: { path: ['action'], equals: 'lifecycle' } },
      select: { id: true, createdAt: true, data: true, responsibleUserId: true, responsibleServiceAccountId: true },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    });
  }

  /** Version metadata of the given items (no snapshot), oldest first per item. */
  async listVersionMeta(tenantId: string, contextItemIds: string[]): Promise<HistoryVersionMetaRow[]> {
    if (contextItemIds.length === 0) return [];
    return this.delegate('contextItemVersion').findMany({
      where: { tenantId, contextItemId: { in: contextItemIds } },
      select: { contextItemId: true, versionNumber: true, changeSource: true, changedBy: true, changeReason: true, createdAt: true },
      orderBy: [{ contextItemId: 'asc' }, { versionNumber: 'asc' }],
    });
  }

  /** The current content of each item, decrypted in one batch. Ids not found are absent. */
  async readContents(tenantId: string, contextItemIds: string[]): Promise<Map<string, string | null>> {
    if (contextItemIds.length === 0) return new Map();
    const rows: Array<{ id: string; content?: string | null }> = await this.delegate('contextItem', true).findMany({
      where: { tenantId, id: { in: contextItemIds }, resourceStatus: ResourceStatusType.ENABLED },
      select: { id: true, encryptedContent: true, contentKeyVersion: true },
    });
    return new Map(rows.map((row) => [row.id, row.content ?? null]));
  }

  async findItem(tenantId: string, contextItemId: string): Promise<HistoryItemHeader | null> {
    return this.delegate('contextItem').findFirst({
      where: { tenantId, id: contextItemId, resourceStatus: ResourceStatusType.ENABLED },
      select: { id: true, consultationId: true, type: true, currentVersionNumber: true },
    });
  }

  /** Items of the consultation that carry more than one version. */
  async countEditedItems(tenantId: string, consultationId: string): Promise<number> {
    return this.delegate('contextItem').count({
      where: { tenantId, consultationId, resourceStatus: ResourceStatusType.ENABLED, currentVersionNumber: { gt: 1 } },
    });
  }
}
