import { BadRequestException, Inject, Injectable, Logger, NotFoundException, Optional } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { ClsService } from 'nestjs-cls';
import {
  ConsultationApprovalRepository,
  ConsultationEncounterRepository,
  ConsultationEntity,
  ConsultationHistoryReadRepository,
  ConsultationRepository,
  ContextItemRepository,
  ContextItemSource,
  ContextItemType,
  ContextItemVersionRepository,
  ResourceType,
  SysEventType,
  UserRoleAssignmentRepository,
} from '@arcaai/domains';
import {
  ACTIVITY_KINDS,
  type ActivityEntry,
  type ActivityItemEntry,
  type ActivityKind,
  type ActivityRunRecord,
  type ActivitySegmentRunEntry,
  type Aggregates,
  type ConsultationActivityPage,
  type ConsultationProcessing,
  type ConsultationStatus,
  type EncounterRecap,
  type ItemVersionDetail,
  type ItemVersionSummary,
} from '@arcaai/types';
import { BaseService } from '../../../common';
import { clampCursorLimit, decodeCursor, encodeCursor } from '../../../common/cursorPagination';
import { IActiveUserContext } from '../../../interfaces';
import { IActivityRunRecordReader, IActivityRunRecordReaderToken } from '../../ai-activity-run/IAiActivityRunService';
import { assertPromptInspectorAccess } from '../../composed-prompt/prompt-inspector-access';
import { ContextDtoMapper } from '../context/context.dto.mapper';
import type { VersionDiffResponse } from '../context/dto/version-diff.response';
import type { FeedbackResponse } from '../feedback/dto/feedback.response';
import { ConsultationHistoryDtoMapper as Mapper, ACTIVITY_KIND_ITEM_TYPES } from './consultation-history.dto.mapper';
import {
  ConsultationActivityFeedbackSource,
  ConsultationActivityFeedbackSourceToken,
  type ConsultationActivityQueryInput,
  type HistoryItemHeader,
  type HistoryItemRow,
  type HistoryReadOptions,
  type HistoryVersionMetaRow,
  IConsultationHistoryService,
} from './IConsultationHistoryService';

export const HISTORY_DEFAULT_LIMIT = 50;
/** Most transcript segments one `segment_run` entry stands for. */
export const HISTORY_SEGMENT_RUN_CAP = 200;
/** Most item bodies one page decrypts (latest versions + run previews); the rest are listed without content. */
export const HISTORY_DECRYPT_CAP_PER_PAGE = 50;
const DECRYPT_BATCH = 20;
const DECRYPT_CONCURRENCY = 2;
const RUN_LOOKUP_CONCURRENCY = 4;
const PREVIEW_SEGMENTS = 3;
const PREVIEW_CHARS = 240;
/** Item rows read per round trip while assembling a page. */
const SCAN_BATCH = 200;
/** Rows one page may scan before it stops and hands back a cursor (long segment runs). */
const MAX_ROWS_SCANNED = 5000;
const FEEDBACK_PAGE = 100;
/** Feedback entries read per consultation; feedback is sparse, and the cap only bounds a pathological one. */
const FEEDBACK_SCAN_CAP = 500;

const FORBIDDEN = {
  code: 'CONSULTATION_HISTORY_FORBIDDEN',
  message: 'Consultation history carries patient data and is readable only by a super administrator or a tenant administrator of this tenant.',
};

/** Sources whose items an AI run produced (the `aiRuns` filter, and the items a run summary is looked up for). */
const AI_SOURCES = [ContextItemSource.AI, ContextItemSource.TRANSCRIPTION];

interface Key {
  at: Date;
  id: string;
}

type StreamElement = (Key & { source: 'row'; row: HistoryItemRow }) | (Key & { source: 'synthetic'; entry: ActivityEntry });

type PendingEntry =
  | { type: 'item'; key: Key; row: HistoryItemRow }
  | { type: 'run'; key: Key; rows: HistoryItemRow[] }
  | { type: 'synthetic'; key: Key; entry: ActivityEntry };

function compareKeys(a: Key, b: Key): number {
  const byTime = a.at.getTime() - b.at.getTime();
  if (byTime !== 0) return byTime;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

async function mapBounded<T, R>(items: readonly T[], concurrency: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await fn(items[index]);
    }
  });
  await Promise.all(workers);
  return results;
}

/** Item rows and synthetic entries merged in one `(at, id)` ascending order, rows read lazily in batches. */
class ActivityStream {
  private readonly buffer: HistoryItemRow[] = [];
  private exhausted: boolean;
  private lastRowKey: Key | null;
  private syntheticIndex = 0;
  scanned = 0;

  constructor(
    private readonly fetchRows: (after: Key | null, take: number) => Promise<HistoryItemRow[]>,
    private readonly synthetic: ReadonlyArray<Key & { entry: ActivityEntry }>,
    after: Key | null,
    private readonly batch: number,
    readRows: boolean,
  ) {
    this.lastRowKey = after;
    this.exhausted = !readRows;
  }

  async peek(): Promise<StreamElement | null> {
    if (this.buffer.length === 0 && !this.exhausted) await this.fill();
    const row = this.buffer[0];
    const syn = this.synthetic[this.syntheticIndex];
    const rowKey = row ? { at: row.occurredAt, id: row.id } : null;
    if (rowKey && (!syn || compareKeys(rowKey, syn) <= 0)) return { ...rowKey, source: 'row', row };
    return syn ? { at: syn.at, id: syn.id, source: 'synthetic', entry: syn.entry } : null;
  }

  /** Consume the element `peek` just returned. */
  consume(element: StreamElement): void {
    if (element.source === 'row') this.buffer.shift();
    else this.syntheticIndex += 1;
  }

  private async fill(): Promise<void> {
    const rows = await this.fetchRows(this.lastRowKey, this.batch);
    this.scanned += rows.length;
    if (rows.length < this.batch) this.exhausted = true;
    const last = rows[rows.length - 1];
    if (last) this.lastRowKey = { at: last.occurredAt, id: last.id };
    this.buffer.push(...rows);
  }
}

/**
 * The consultation's history as one oldest-first time series: its items (latest version by
 * default, decrypted under a per-page cap), consecutive transcript segments collapsed into runs,
 * feedback, and the lifecycle derivable from encounters, approvals and the close.
 *
 * The admin plane (`admin: true`) is gated by the prompt-inspector audience and additionally sees
 * the producing AI run of each item and the consultation's aggregates. The business plane relies
 * on the consultation being the caller's tenant's. Every read is audited.
 */
@Injectable()
export class ConsultationHistoryService extends BaseService implements IConsultationHistoryService {
  private readonly logger = new Logger(ConsultationHistoryService.name);

  constructor(
    private readonly consultationRepository: ConsultationRepository,
    private readonly encounterRepository: ConsultationEncounterRepository,
    private readonly approvalRepository: ConsultationApprovalRepository,
    private readonly contextItemRepository: ContextItemRepository,
    private readonly contextItemVersionRepository: ContextItemVersionRepository,
    private readonly historyReads: ConsultationHistoryReadRepository,
    protected override readonly eventEmitter: EventEmitter2,
    protected override readonly clsService: ClsService<IActiveUserContext>,
    @Optional() private readonly roleAssignments?: UserRoleAssignmentRepository,
    @Optional() @Inject(ConsultationActivityFeedbackSourceToken) private readonly feedbackSource?: ConsultationActivityFeedbackSource,
    @Optional() @Inject(IActivityRunRecordReaderToken) private readonly runReader?: IActivityRunRecordReader,
  ) {
    super(eventEmitter, clsService, ResourceType.Consultation);
  }

  // ── Activity feed ─────────────────────────────────────────────────────────────────────────

  async getActivity(consultationId: string, query: ConsultationActivityQueryInput, options: HistoryReadOptions): Promise<ConsultationActivityPage> {
    await this.assertReadable(options);
    const tenantId = this.requireTenant();
    const consultation = await this.loadConsultation(consultationId, tenantId);

    const limit = clampCursorLimit(query.limit ?? HISTORY_DEFAULT_LIMIT);
    const after = this.parseCursor(query.cursor);
    const kinds = this.parseKinds(query.kinds);
    const grouping = query.grouping ?? 'runs';
    const includeVersions = (query.include ?? []).includes('versions');
    const itemFiltered =
      query.encounterSeq !== undefined || !!query.edited || !!query.aiRuns || query.segmentSeqFrom !== undefined || query.segmentSeqTo !== undefined;
    const wants = (kind: ActivityKind) => !kinds || kinds.has(kind);

    const itemTypes = (kinds ? [...kinds] : [...ACTIVITY_KINDS]).flatMap((kind) => ACTIVITY_KIND_ITEM_TYPES[kind] ?? []);

    const [encounters, approvals, feedback] = await Promise.all([
      this.encounterRepository.findByConsultation(consultationId),
      this.approvalRepository.findByConsultation(consultationId),
      this.readFeedback(consultationId),
    ]);

    const synthetic: Array<Key & { entry: ActivityEntry }> = [];
    if (wants('LIFECYCLE') && !itemFiltered) {
      synthetic.push(...Mapper.toLifecycleEntries(encounters, approvals, consultation.closedAt));
    }
    if (wants('FEEDBACK') && !itemFiltered) {
      for (const record of feedback) synthetic.push({ at: new Date(record.createdAt), id: record.id, entry: Mapper.toFeedbackEntry(record) });
    }
    synthetic.sort(compareKeys);
    const pendingSynthetic = after ? synthetic.filter((entry) => compareKeys(entry, after) > 0) : synthetic;

    const stream = new ActivityStream(
      (from, take) =>
        this.historyReads.pageItems({
          tenantId,
          consultationId,
          after: from,
          take,
          types: itemTypes,
          ...(query.aiRuns ? { sources: AI_SOURCES } : {}),
          ...(query.encounterSeq !== undefined ? { encounterSeq: query.encounterSeq } : {}),
          ...(query.edited ? { editedOnly: true } : {}),
          ...(query.segmentSeqFrom !== undefined ? { segmentSeqFrom: query.segmentSeqFrom } : {}),
          ...(query.segmentSeqTo !== undefined ? { segmentSeqTo: query.segmentSeqTo } : {}),
        }),
      pendingSynthetic,
      after,
      Math.min(Math.max(limit + 1, 50), SCAN_BATCH),
      itemTypes.length > 0,
    );

    const { pending, hasMore } = await this.assemble(stream, limit, grouping);
    const items = await this.hydrate(pending, { tenantId, consultationId, admin: options.admin, includeVersions, feedback });
    const last = pending[pending.length - 1];

    const page: ConsultationActivityPage = {
      consultationId,
      status: consultation.status as unknown as ConsultationStatus,
      processing: consultation.processing as unknown as ConsultationProcessing,
      ...(consultation.processingReason ? { processingReason: consultation.processingReason } : {}),
      encounters: Mapper.toEncounterBlocks(encounters),
      items,
      nextCursor: hasMore && last ? encodeCursor({ k: last.key.at.toISOString(), id: last.key.id }) : null,
      hasMore,
    };
    if (options.admin && !after) page.aggregates = await this.aggregates(tenantId, consultationId, feedback);

    this.audit(consultationId, options, { view: 'activity', entryCount: items.length });
    return page;
  }

  private async assemble(stream: ActivityStream, limit: number, grouping: 'runs' | 'none'): Promise<{ pending: PendingEntry[]; hasMore: boolean }> {
    const pending: PendingEntry[] = [];
    while (pending.length < limit) {
      if (stream.scanned >= MAX_ROWS_SCANNED) return { pending, hasMore: true };
      const element = await stream.peek();
      if (!element) return { pending, hasMore: false };
      stream.consume(element);

      if (element.source === 'synthetic') {
        pending.push({ type: 'synthetic', key: element, entry: element.entry });
      } else if (grouping === 'runs' && element.row.type === ContextItemType.TRANSCRIPT_SEGMENT) {
        const rows = [element.row];
        while (rows.length < HISTORY_SEGMENT_RUN_CAP) {
          const next = await stream.peek();
          if (!next || next.source !== 'row' || next.row.type !== ContextItemType.TRANSCRIPT_SEGMENT || next.row.encounterSeq !== element.row.encounterSeq) break;
          stream.consume(next);
          rows.push(next.row);
        }
        const tail = rows[rows.length - 1];
        pending.push({ type: 'run', key: { at: tail.occurredAt, id: tail.id }, rows });
      } else {
        pending.push({ type: 'item', key: element, row: element.row });
      }
    }
    return { pending, hasMore: (await stream.peek()) !== null };
  }

  private async hydrate(
    pending: PendingEntry[],
    context: { tenantId: string; consultationId: string; admin: boolean; includeVersions: boolean; feedback: FeedbackResponse[] },
  ): Promise<ActivityEntry[]> {
    const itemRows = pending.flatMap((entry) => (entry.type === 'item' ? [entry.row] : []));

    // Bodies to decrypt, in page order, capped.
    const toDecrypt: string[] = [];
    for (const entry of pending) {
      if (entry.type === 'item' && entry.row.type !== ContextItemType.AUDIO_RECORDING) toDecrypt.push(entry.row.id);
      if (entry.type === 'run') toDecrypt.push(...entry.rows.slice(0, PREVIEW_SEGMENTS).map((row) => row.id));
    }

    const [metaRows, contents] = await Promise.all([
      this.historyReads.listVersionMeta(context.tenantId, itemRows.map((row) => row.id)),
      this.decryptCapped(context.tenantId, toDecrypt.slice(0, HISTORY_DECRYPT_CAP_PER_PAGE)),
    ]);
    const metaByItem = new Map<string, HistoryVersionMetaRow[]>();
    for (const meta of metaRows) metaByItem.set(meta.contextItemId, [...(metaByItem.get(meta.contextItemId) ?? []), meta]);
    for (const list of metaByItem.values()) list.sort((a, b) => a.versionNumber - b.versionNumber);

    const ratings = new Map<string, { up: number; down: number }>();
    for (const record of context.feedback) {
      if (!record.isLatest || !record.target || (record.rating !== 'up' && record.rating !== 'down')) continue;
      const counts = ratings.get(record.target.contextItemId) ?? { up: 0, down: 0 };
      counts[record.rating] += 1;
      ratings.set(record.target.contextItemId, counts);
    }

    const entries = pending.map((entry): ActivityEntry => {
      if (entry.type === 'synthetic') return entry.entry;
      if (entry.type === 'run') return this.toRunEntry(entry.rows, contents);
      return this.toItemEntry(entry.row, metaByItem.get(entry.row.id) ?? [], contents, ratings, context.includeVersions);
    });

    if (context.admin && this.runReader) await this.attachRuns(entries, context);
    return entries;
  }

  private toItemEntry(
    row: HistoryItemRow,
    metas: HistoryVersionMetaRow[],
    contents: Map<string, string | null>,
    ratings: Map<string, { up: number; down: number }>,
    includeVersions: boolean,
  ): ActivityItemEntry {
    const latest = metas[metas.length - 1];
    const edited = row.currentVersionNumber > 1 || metas.length > 1;
    const entry: ActivityItemEntry = {
      entryType: 'item',
      id: row.id,
      kind: Mapper.kindOf(row.type) ?? 'STRUCTURED',
      encounterSeq: row.encounterSeq ?? null,
      occurredAt: row.occurredAt.toISOString(),
      source: String(row.source),
      latestVersion: {
        number: latest?.versionNumber ?? row.currentVersionNumber,
        ...(contents.has(row.id) ? { content: contents.get(row.id) ?? null } : {}),
        ...(row.mediaId ? { mediaId: row.mediaId } : {}),
        changeSource: latest?.changeSource ?? 'unknown',
        changedBy: latest?.changedBy ?? row.createdBy ?? null,
        createdAt: (latest?.createdAt ?? row.createdAt).toISOString(),
      },
      versionCount: metas.length || row.currentVersionNumber,
      edited,
    };
    if (row.createdBy) entry.actor = { userId: row.createdBy };
    if (edited && latest) entry.lastEditedAt = latest.createdAt.toISOString();
    if (includeVersions) entry.versions = [...metas].reverse().map((meta) => Mapper.toVersionSummary(meta));
    const counts = ratings.get(row.id);
    if (counts) entry.feedback = counts;
    if (row.segmentSeq !== null && row.segmentSeq !== undefined) {
      entry.segment = { seq: row.segmentSeq, speaker: row.speaker ?? null, t0Ms: row.t0Ms ?? 0, t1Ms: row.t1Ms ?? 0 };
    }
    if (row.mediaId) entry.media = { mediaId: row.mediaId };
    return entry;
  }

  private toRunEntry(rows: HistoryItemRow[], contents: Map<string, string | null>): ActivitySegmentRunEntry {
    const first = rows[0];
    const last = rows[rows.length - 1];
    const preview = rows
      .slice(0, PREVIEW_SEGMENTS)
      .map((row) => contents.get(row.id))
      .filter((text): text is string => !!text)
      .join(' ')
      .slice(0, PREVIEW_CHARS);
    return {
      entryType: 'segment_run',
      runId: first.id,
      encounterSeq: first.encounterSeq ?? 0,
      firstSeq: first.segmentSeq ?? 0,
      lastSeq: last.segmentSeq ?? 0,
      count: rows.length,
      t0Ms: first.t0Ms ?? 0,
      t1Ms: last.t1Ms ?? 0,
      speakers: [...new Set(rows.map((row) => row.speaker).filter((speaker): speaker is string => !!speaker))],
      occurredAt: first.occurredAt.toISOString(),
      preview,
      edited: rows.some((row) => row.currentVersionNumber > 1),
    };
  }

  /** Decrypt in batches (one Vault batch each), at most `DECRYPT_CONCURRENCY` in flight. */
  private async decryptCapped(tenantId: string, ids: string[]): Promise<Map<string, string | null>> {
    const batches: string[][] = [];
    for (let index = 0; index < ids.length; index += DECRYPT_BATCH) batches.push(ids.slice(index, index + DECRYPT_BATCH));
    const maps = await mapBounded(batches, DECRYPT_CONCURRENCY, (batch) => this.historyReads.readContents(tenantId, batch));
    return new Map(maps.flatMap((map) => [...map]));
  }

  private async attachRuns(entries: ActivityEntry[], context: { tenantId: string; consultationId: string }): Promise<void> {
    const reader = this.runReader!;
    const targets = entries.filter(
      (entry): entry is ActivityItemEntry => entry.entryType === 'item' && (AI_SOURCES as string[]).includes(entry.source),
    );
    await mapBounded(targets, RUN_LOOKUP_CONCURRENCY, async (entry) => {
      try {
        const producer = await reader.findProducerOf({
          tenantId: context.tenantId,
          consultationId: context.consultationId,
          contextItemId: entry.id,
          versionNumber: entry.latestVersion.number,
        });
        if (producer) entry.run = Mapper.toRunSummary(producer);
      } catch (error) {
        this.logger.warn(`Run lookup failed for an activity item: ${error instanceof Error ? error.message : String(error)}`);
      }
    });
  }

  private async aggregates(tenantId: string, consultationId: string, feedback: FeedbackResponse[]): Promise<Aggregates> {
    const [runs, editedItems] = await Promise.all([
      this.runReader ? this.runReader.listForConsultation({ tenantId, consultationId }) : Promise.resolve([]),
      this.historyReads.countEditedItems(tenantId, consultationId),
    ]);
    const latestRatings = feedback.filter((record) => record.isLatest);
    return {
      aiRunCount: runs.length,
      tokensIn: runs.reduce((sum, run) => sum + (run.tokensIn ?? 0), 0),
      tokensOut: runs.reduce((sum, run) => sum + (run.tokensOut ?? 0), 0),
      costMicros: runs.reduce((sum, run) => sum + Number(run.costMicros ?? 0), 0),
      costBasis: [...new Set(runs.map((run) => run.costBasis).filter((basis): basis is string => !!basis))].sort(),
      editedItems,
      feedbackUp: latestRatings.filter((record) => record.rating === 'up').length,
      feedbackDown: latestRatings.filter((record) => record.rating === 'down').length,
    };
  }

  private async readFeedback(consultationId: string): Promise<FeedbackResponse[]> {
    if (!this.feedbackSource) return [];
    const out: FeedbackResponse[] = [];
    let cursor: string | null = null;
    do {
      const page: { items: FeedbackResponse[]; nextCursor: string | null } = await this.feedbackSource.listForActivity(consultationId, {
        cursor,
        limit: FEEDBACK_PAGE,
      });
      out.push(...page.items);
      cursor = page.nextCursor;
    } while (cursor && out.length < FEEDBACK_SCAN_CAP);
    return out.slice(0, FEEDBACK_SCAN_CAP);
  }

  // ── Versions, runs, recap ─────────────────────────────────────────────────────────────────

  async listItemVersions(consultationId: string, contextItemId: string, options: HistoryReadOptions): Promise<ItemVersionSummary[]> {
    await this.assertReadable(options);
    const tenantId = this.requireTenant();
    await this.loadConsultation(consultationId, tenantId);
    await this.loadItem(tenantId, consultationId, contextItemId);
    const metas = await this.historyReads.listVersionMeta(tenantId, [contextItemId]);
    const list = metas.sort((a, b) => b.versionNumber - a.versionNumber).map((meta) => Mapper.toVersionSummary(meta));
    this.audit(consultationId, options, { view: 'item_versions', contextItemId, versionCount: list.length });
    return list;
  }

  async getItemVersion(consultationId: string, contextItemId: string, versionNumber: number, options: HistoryReadOptions): Promise<ItemVersionDetail> {
    await this.assertReadable(options);
    const tenantId = this.requireTenant();
    await this.loadConsultation(consultationId, tenantId);
    await this.loadItem(tenantId, consultationId, contextItemId);
    const version = await this.contextItemVersionRepository.getVersion(contextItemId, versionNumber);
    if (!version) throw new NotFoundException(`Version ${versionNumber} not found for context item ${contextItemId}`);
    this.audit(consultationId, options, { view: 'item_version', contextItemId, versionNumber });
    return Mapper.toVersionDetail(version);
  }

  async diffItemVersions(
    consultationId: string,
    contextItemId: string,
    versionNumber: number,
    against: number,
    options: HistoryReadOptions,
  ): Promise<VersionDiffResponse> {
    await this.assertReadable(options);
    const tenantId = this.requireTenant();
    await this.loadConsultation(consultationId, tenantId);
    await this.loadItem(tenantId, consultationId, contextItemId);
    const [from, to] = await Promise.all([
      this.contextItemVersionRepository.getVersion(contextItemId, against),
      this.contextItemVersionRepository.getVersion(contextItemId, versionNumber),
    ]);
    if (!from) throw new NotFoundException(`Version ${against} not found for context item ${contextItemId}`);
    if (!to) throw new NotFoundException(`Version ${versionNumber} not found for context item ${contextItemId}`);
    this.audit(consultationId, options, { view: 'item_diff', contextItemId, fromVersion: against, toVersion: versionNumber });
    return { contextItemId, from: ContextDtoMapper.toVersionResponse(from), to: ContextDtoMapper.toVersionResponse(to) };
  }

  async listItemRuns(consultationId: string, contextItemId: string, versionNumber: number | undefined, options: HistoryReadOptions): Promise<ActivityRunRecord[]> {
    await this.assertReadable(options);
    const tenantId = this.requireTenant();
    await this.loadConsultation(consultationId, tenantId);
    const item = await this.loadItem(tenantId, consultationId, contextItemId);
    const version = versionNumber ?? item.currentVersionNumber;
    const producer = this.runReader
      ? await this.runReader.findProducerOf({ tenantId, consultationId, contextItemId, versionNumber: version })
      : null;
    this.audit(consultationId, options, { view: 'item_runs', contextItemId, versionNumber: version });
    return producer ? [Mapper.toRunRecord(producer, version)] : [];
  }

  async getRecap(consultationId: string, encounterSeq: number, options: HistoryReadOptions): Promise<EncounterRecap> {
    await this.assertReadable(options);
    const tenantId = this.requireTenant();
    await this.loadConsultation(consultationId, tenantId);
    const recap = await this.contextItemRepository.findEncounterArtifact(consultationId, ContextItemType.ENCOUNTER_RECAP, encounterSeq);
    if (!recap) throw new NotFoundException(`No recap for encounter ${encounterSeq} of consultation ${consultationId}`);

    const meta = (recap.metaData ?? {}) as Record<string, unknown>;
    let ledgerContextItemId = typeof meta.ledgerItemId === 'string' ? meta.ledgerItemId : null;
    if (!ledgerContextItemId) {
      const ledger = await this.contextItemRepository.findEncounterArtifact(consultationId, ContextItemType.FACT_LEDGER, encounterSeq);
      ledgerContextItemId = ledger?.id ?? '';
    }
    const sections = Array.isArray(meta.sections) ? (meta.sections as EncounterRecap['sections']) : undefined;

    this.audit(consultationId, options, { view: 'recap', contextItemId: recap.id, encounterSeq });
    return {
      encounterSeq,
      contextItemId: recap.id,
      versionNumber: recap.currentVersionNumber,
      text: recap.content ?? '',
      ...(sections ? { sections } : {}),
      generatedAt: recap.updatedAt.toISOString(),
      ledgerContextItemId,
    };
  }

  // ── Gate, existence, parsing, audit ───────────────────────────────────────────────────────

  /** Admin plane only, and FIRST: the answer never depends on a row. */
  private async assertReadable(options: HistoryReadOptions): Promise<void> {
    if (!options.admin) return;
    await assertPromptInspectorAccess(
      {
        user: this.requestUser,
        serviceAccount: (this.clsService as unknown as { get(key: string): unknown }).get('serviceAccount'),
        tenantId: this.tenantId ?? '',
        roleAssignments: this.roleAssignments,
        logger: this.logger,
      },
      FORBIDDEN,
    );
  }

  private requireTenant(): string {
    const tenantId = this.tenantId;
    if (!tenantId) throw new BadRequestException('Tenant ID is required');
    return tenantId;
  }

  /** The consultation, or 404 when it is unknown or another tenant's. */
  private async loadConsultation(consultationId: string, tenantId: string): Promise<ConsultationEntity> {
    const consultation = await this.consultationRepository.findByIdOrNull(consultationId);
    if (!consultation || consultation.tenantId !== tenantId) throw new NotFoundException(`Consultation ${consultationId} not found`);
    return consultation;
  }

  /** The item, or 404 when it is unknown or belongs to another consultation. */
  private async loadItem(tenantId: string, consultationId: string, contextItemId: string): Promise<HistoryItemHeader> {
    const item = await this.historyReads.findItem(tenantId, contextItemId);
    if (!item || item.consultationId !== consultationId) throw new NotFoundException(`Context item ${contextItemId} not found`);
    return item;
  }

  private parseCursor(cursor: string | undefined): Key | null {
    if (!cursor) return null;
    const decoded = decodeCursor(cursor);
    const at = decoded ? new Date(decoded.k) : null;
    if (!decoded || !at || Number.isNaN(at.getTime())) throw new BadRequestException('Invalid cursor');
    return { at, id: decoded.id };
  }

  private parseKinds(kinds: ConsultationActivityQueryInput['kinds']): Set<ActivityKind> | null {
    if (!kinds || kinds.length === 0) return null;
    const unknown = kinds.filter((kind) => !(ACTIVITY_KINDS as readonly string[]).includes(kind));
    if (unknown.length > 0) throw new BadRequestException(`Unknown activity kind: ${unknown.join(', ')}`);
    return new Set(kinds as ActivityKind[]);
  }

  /** Ids and counts only — never content. */
  private audit(consultationId: string, options: HistoryReadOptions, data: Record<string, unknown>): void {
    this.broadcastSysEvent(SysEventType.ResourceViewed, {
      resourceId: consultationId,
      forceAuditLog: true,
      data: { action: 'consultation_history_read', consultationId, plane: options.admin ? 'admin' : 'business', ...data },
    });
  }
}
