/**
 * The consultation history read service — the admin activity feed and the business history feed.
 *
 *  - admin reads are gated FIRST (row-independent: SUPER_ADMIN, TENANT_ADMIN of the working tenant,
 *    or a service account) with `CONSULTATION_HISTORY_FORBIDDEN`; a foreign id is then 404;
 *  - items come oldest-first on a keyset over `(occurredAt, id)`, merged with lifecycle entries
 *    (derived from encounters / approvals / closedAt) and feedback entries;
 *  - consecutive transcript segments of one encounter collapse into a `segment_run`, capped;
 *  - the latest version's content is decrypted under a per-page cap with bounded concurrency;
 *  - run summaries and aggregates are admin-only; every read is audited with `forceAuditLog`.
 */
import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ContextItemSource, ContextItemType, SysEventType } from '@arcaai/domains';
import type {
  ActivityFeedbackEntry,
  ActivityItemEntry,
  ActivityLifecycleEntry,
  ActivitySegmentRunEntry,
} from '@arcaai/types';
import { encodeCursor } from '../../../../common/cursorPagination';
import { ConsultationHistoryService, HISTORY_DECRYPT_CAP_PER_PAGE, HISTORY_SEGMENT_RUN_CAP } from '../consultation-history.service';
import type { HistoryItemRow, HistoryVersionMetaRow } from '../IConsultationHistoryService';

const TENANT = 'tenant-a';
const CID = 'cons-1';
const SUPER_ADMIN = { id: 'sadmin-1', roles: ['SUPER_ADMIN'] };
const DOCTOR = { id: 'doctor-1', roles: ['DOCTOR'] };

const clsStore: Record<string, unknown> = {};
const cls = { get: vi.fn((key: string) => clsStore[key]), set: vi.fn() };
const events = { emit: vi.fn() };
const roleAssignments = { findAll: vi.fn(async () => [] as unknown[]) };

const consultations = { findByIdOrNull: vi.fn() };
const encounters = { findByConsultation: vi.fn() };
const approvals = { findByConsultation: vi.fn() };
const contextItems = { findEncounterArtifact: vi.fn() };
const versions = { getVersion: vi.fn() };
const reads = {
  pageItems: vi.fn(),
  listVersionMeta: vi.fn(),
  readContents: vi.fn(),
  findItem: vi.fn(),
  countEditedItems: vi.fn(),
};
const feedback = { listForActivity: vi.fn() };
const runs = { findProducerOf: vi.fn(), listForConsultation: vi.fn() };

let rows: HistoryItemRow[] = [];
let metas: HistoryVersionMetaRow[] = [];

const t = (sec: number) => new Date(Date.UTC(2026, 9, 5, 9, 0, sec));

function row(id: string, sec: number, type: ContextItemType, extra: Partial<HistoryItemRow> = {}): HistoryItemRow {
  return {
    id,
    type,
    source: ContextItemSource.USER,
    encounterSeq: 1,
    segmentSeq: null,
    speaker: null,
    t0Ms: null,
    t1Ms: null,
    occurredAt: t(sec),
    currentVersionNumber: 1,
    mediaId: null,
    createdBy: 'doctor-1',
    createdAt: t(sec),
    ...extra,
  };
}

function seg(id: string, sec: number, seq: number, encounterSeq = 1, extra: Partial<HistoryItemRow> = {}): HistoryItemRow {
  return row(id, sec, ContextItemType.TRANSCRIPT_SEGMENT, {
    source: ContextItemSource.TRANSCRIPTION,
    encounterSeq,
    segmentSeq: seq,
    speaker: seq % 2 ? 'doctor' : 'patient',
    t0Ms: seq * 1000,
    t1Ms: seq * 1000 + 900,
    ...extra,
  });
}

/** A keyset-honouring fake of the read repository's page query. */
function pageFake(input: {
  after: { at: Date; id: string } | null;
  take: number;
  types?: ContextItemType[];
  encounterSeq?: number;
}): HistoryItemRow[] {
  const sorted = [...rows].sort((a, b) => a.occurredAt.getTime() - b.occurredAt.getTime() || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return sorted
    .filter((r) => !input.types || input.types.includes(r.type))
    .filter((r) => input.encounterSeq === undefined || r.encounterSeq === input.encounterSeq)
    .filter((r) => {
      if (!input.after) return true;
      const d = r.occurredAt.getTime() - input.after.at.getTime();
      return d > 0 || (d === 0 && r.id > input.after.id);
    })
    .slice(0, input.take);
}

function makeService(opts: { feedback?: boolean; runs?: boolean } = {}): ConsultationHistoryService {
  return new ConsultationHistoryService(
    consultations as never,
    encounters as never,
    approvals as never,
    contextItems as never,
    versions as never,
    reads as never,
    events as never,
    cls as never,
    roleAssignments as never,
    opts.feedback === false ? undefined : (feedback as never),
    opts.runs === false ? undefined : (runs as never),
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  for (const key of Object.keys(clsStore)) delete clsStore[key];
  clsStore.tenantId = TENANT;
  clsStore.user = SUPER_ADMIN;
  rows = [];
  metas = [];
  consultations.findByIdOrNull.mockResolvedValue({
    id: CID,
    tenantId: TENANT,
    status: 'STOPPED',
    processing: 'IDLE',
    processingReason: null,
    closedAt: null,
  });
  encounters.findByConsultation.mockResolvedValue([]);
  approvals.findByConsultation.mockResolvedValue([]);
  reads.pageItems.mockImplementation(async (input: Parameters<typeof pageFake>[0]) => pageFake(input));
  reads.listVersionMeta.mockImplementation(async (_tenant: string, ids: string[]) => metas.filter((m) => ids.includes(m.contextItemId)));
  reads.readContents.mockImplementation(async (_tenant: string, ids: string[]) => new Map(ids.map((id) => [id, `text of ${id}`])));
  reads.countEditedItems.mockResolvedValue(0);
  feedback.listForActivity.mockResolvedValue({ items: [], nextCursor: null });
  runs.findProducerOf.mockResolvedValue(null);
  runs.listForConsultation.mockResolvedValue([]);
});

describe('ConsultationHistoryService — gate and existence', () => {
  it('admin: a doctor is 403 CONSULTATION_HISTORY_FORBIDDEN before any row is read', async () => {
    clsStore.user = DOCTOR;
    const error = await makeService()
      .getActivity(CID, {}, { admin: true })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ForbiddenException);
    expect((error as ForbiddenException).getResponse()).toMatchObject({ code: 'CONSULTATION_HISTORY_FORBIDDEN' });
    expect(consultations.findByIdOrNull).not.toHaveBeenCalled();
    expect(reads.pageItems).not.toHaveBeenCalled();
  });

  it('admin: a service account passes the gate', async () => {
    clsStore.user = undefined;
    clsStore.serviceAccount = { id: 'svc-1' };
    await expect(makeService().getActivity(CID, {}, { admin: true })).resolves.toMatchObject({ consultationId: CID });
  });

  it('a foreign or unknown consultation is 404 on both planes', async () => {
    consultations.findByIdOrNull.mockResolvedValue({ id: CID, tenantId: 'tenant-b', status: 'OPEN', processing: 'IDLE' });
    await expect(makeService().getActivity(CID, {}, { admin: true })).rejects.toBeInstanceOf(NotFoundException);
    clsStore.user = DOCTOR;
    await expect(makeService().getActivity(CID, {}, { admin: false })).rejects.toBeInstanceOf(NotFoundException);
    consultations.findByIdOrNull.mockResolvedValue(null);
    await expect(makeService().getActivity(CID, {}, { admin: false })).rejects.toBeInstanceOf(NotFoundException);
  });

  it('business: a doctor reads without the admin gate', async () => {
    clsStore.user = DOCTOR;
    await expect(makeService().getActivity(CID, {}, { admin: false })).resolves.toMatchObject({ consultationId: CID });
    expect(roleAssignments.findAll).not.toHaveBeenCalled();
  });

  it('a malformed cursor is 400', async () => {
    await expect(makeService().getActivity(CID, { cursor: '%%%' }, { admin: true })).rejects.toBeInstanceOf(BadRequestException);
  });

  it('an unknown kind is 400', async () => {
    await expect(makeService().getActivity(CID, { kinds: ['NOPE'] }, { admin: true })).rejects.toBeInstanceOf(BadRequestException);
  });
});

describe('ConsultationHistoryService — activity page', () => {
  it('is oldest-first on a keyset, and the cursor continues after the last entry', async () => {
    rows = [row('n-1', 1, ContextItemType.CASE_NOTE), row('n-2', 2, ContextItemType.CASE_NOTE), row('n-3', 3, ContextItemType.CASE_NOTE)];
    const service = makeService();
    const first = await service.getActivity(CID, { limit: 2 }, { admin: true });
    expect(first.items.map((e) => (e as ActivityItemEntry).id)).toEqual(['n-1', 'n-2']);
    expect(first.hasMore).toBe(true);
    expect(first.nextCursor).toBe(encodeCursor({ k: t(2).toISOString(), id: 'n-2' }));

    const second = await service.getActivity(CID, { limit: 2, cursor: first.nextCursor! }, { admin: true });
    expect(second.items.map((e) => (e as ActivityItemEntry).id)).toEqual(['n-3']);
    expect(second.hasMore).toBe(false);
    expect(second.nextCursor).toBeNull();
    expect(reads.pageItems).toHaveBeenLastCalledWith(expect.objectContaining({ tenantId: TENANT, consultationId: CID, after: { at: t(2), id: 'n-2' } }));
  });

  it('groups consecutive segments of one encounter into segment runs', async () => {
    rows = [
      seg('s-1', 1, 1),
      seg('s-2', 2, 2),
      row('note-1', 3, ContextItemType.RAW_SUMMARY, { source: ContextItemSource.AI }),
      seg('s-3', 4, 3),
      seg('s-4', 5, 4, 2),
    ];
    const page = await makeService().getActivity(CID, {}, { admin: true });
    const kinds = page.items.map((e) => e.entryType);
    expect(kinds).toEqual(['segment_run', 'item', 'segment_run', 'segment_run']);
    const run = page.items[0] as ActivitySegmentRunEntry;
    expect(run).toMatchObject({ runId: 's-1', encounterSeq: 1, firstSeq: 1, lastSeq: 2, count: 2, t0Ms: 1000, t1Ms: 2900, edited: false });
    expect(run.speakers.sort()).toEqual(['doctor', 'patient']);
    expect(run.occurredAt).toBe(t(1).toISOString());
    expect(run.preview).toContain('text of s-1');
    expect((page.items[3] as ActivitySegmentRunEntry).encounterSeq).toBe(2);
  });

  it('caps a segment run and continues the next run on the following entry', async () => {
    rows = Array.from({ length: HISTORY_SEGMENT_RUN_CAP + 5 }, (_, i) => seg(`s-${String(i).padStart(4, '0')}`, i, i + 1));
    const page = await makeService().getActivity(CID, {}, { admin: true });
    const runsOut = page.items as ActivitySegmentRunEntry[];
    expect(runsOut).toHaveLength(2);
    expect(runsOut[0].count).toBe(HISTORY_SEGMENT_RUN_CAP);
    expect(runsOut[1].firstSeq).toBe(HISTORY_SEGMENT_RUN_CAP + 1);
  });

  it('grouping=none returns segments as items with their segment detail and passes the seq range', async () => {
    rows = [seg('s-1', 1, 1), seg('s-2', 2, 2)];
    const page = await makeService().getActivity(
      CID,
      { grouping: 'none', kinds: ['TRANSCRIPT_SEGMENT'], encounterSeq: 1, segmentSeqFrom: 1, segmentSeqTo: 2 },
      { admin: true },
    );
    expect(page.items.map((e) => e.entryType)).toEqual(['item', 'item']);
    expect((page.items[0] as ActivityItemEntry).segment).toEqual({ seq: 1, speaker: 'doctor', t0Ms: 1000, t1Ms: 1900 });
    expect((page.items[0] as ActivityItemEntry).latestVersion.content).toBe('text of s-1');
    expect(reads.pageItems).toHaveBeenCalledWith(
      expect.objectContaining({ types: [ContextItemType.TRANSCRIPT_SEGMENT], encounterSeq: 1, segmentSeqFrom: 1, segmentSeqTo: 2 }),
    );
  });

  it('maps filters onto the read and drops synthetic entries when an item filter is set', async () => {
    encounters.findByConsultation.mockResolvedValue([{ seq: 1, visitType: 'NEW', externalRef: null, startedAt: t(0), endedAt: null }]);
    rows = [row('n-1', 1, ContextItemType.RAW_SUMMARY, { source: ContextItemSource.AI, currentVersionNumber: 2 })];
    const page = await makeService().getActivity(CID, { kinds: ['NOTE'], edited: true, aiRuns: true }, { admin: true });
    expect(reads.pageItems).toHaveBeenCalledWith(
      expect.objectContaining({
        types: [ContextItemType.RAW_SUMMARY, ContextItemType.MODIFIED_SUMMARY, ContextItemType.SIGNED_NOTE],
        editedOnly: true,
        sources: [ContextItemSource.AI, ContextItemSource.TRANSCRIPTION],
      }),
    );
    expect(page.items.map((e) => e.entryType)).toEqual(['item']);
  });

  it('returns encounters with the gap after each one and interleaves derived lifecycle entries', async () => {
    encounters.findByConsultation.mockResolvedValue([
      { seq: 1, visitType: 'NEW', externalRef: 'v-1', startedAt: t(0), endedAt: t(10), recordingStartMs: 0, recordingEndMs: 10000 },
      { seq: 2, visitType: 'FOLLOW_UP', externalRef: 'v-2', startedAt: t(40), endedAt: null, recordingStartMs: 10000, recordingEndMs: null },
    ]);
    approvals.findByConsultation.mockResolvedValue([{ id: 'appr-1', approvedAt: t(50), approvedBy: 'doctor-1' }]);
    rows = [row('n-1', 5, ContextItemType.CASE_NOTE)];
    const page = await makeService().getActivity(CID, {}, { admin: true });
    expect(page.encounters[0]).toMatchObject({ seq: 1, externalRef: 'v-1', gapAfter: { fromAt: t(10).toISOString(), toAt: t(40).toISOString(), durationMs: 30000 } });
    expect(page.encounters[1].gapAfter).toBeUndefined();
    const timeline = page.items.map((e) => (e.entryType === 'lifecycle' ? (e as ActivityLifecycleEntry).type : e.entryType));
    expect(timeline).toEqual(['opened', 'item', 'stopped', 'encounter_appended', 'approved']);
    expect((page.items[4] as ActivityLifecycleEntry).actor).toEqual({ userId: 'doctor-1' });
  });

  it('merges feedback entries and counts the latest ratings on their target item', async () => {
    rows = [row('note-1', 1, ContextItemType.RAW_SUMMARY, { source: ContextItemSource.AI })];
    feedback.listForActivity.mockResolvedValue({
      items: [
        {
          id: 'fb-1',
          consultationId: CID,
          createdAt: t(3).toISOString(),
          rating: 'down',
          reasonCodes: ['too_long'],
          comment: 'shorter please',
          attachmentIds: [],
          correction: null,
          isLatest: true,
          target: { kind: 'NOTE', contextItemId: 'note-1', versionNumber: 1 },
          provenance: null,
          actor: { userId: 'doctor-1', credentialClass: 'jwt' },
          client: { app: 'alaas', surface: 'review' },
        },
      ],
      nextCursor: null,
    });
    const page = await makeService().getActivity(CID, {}, { admin: true });
    expect(page.items.map((e) => e.entryType)).toEqual(['item', 'feedback']);
    expect((page.items[0] as ActivityItemEntry).feedback).toEqual({ up: 0, down: 1 });
    expect(page.items[1] as ActivityFeedbackEntry).toMatchObject({ rating: 'down', comment: 'shorter please', clientApp: 'alaas', surface: 'review' });
    expect(page.aggregates).toMatchObject({ feedbackUp: 0, feedbackDown: 1 });
  });

  it('lists an uploaded audio attachment\'s transcript (TRANSCRIPT item) as an ATTACHMENT entry', async () => {
    rows = [row('att-tx-1', 1, ContextItemType.TRANSCRIPT, { source: ContextItemSource.TRANSCRIPTION })];
    const page = await makeService().getActivity(CID, { kinds: ['ATTACHMENT'] }, { admin: true });
    expect(page.items).toHaveLength(1);
    expect((page.items[0] as ActivityItemEntry).kind).toBe('ATTACHMENT');
  });

  it('works without the optional feedback and run readers', async () => {
    rows = [row('note-1', 1, ContextItemType.RAW_SUMMARY, { source: ContextItemSource.AI })];
    const page = await makeService({ feedback: false, runs: false }).getActivity(CID, {}, { admin: true });
    expect(page.items).toHaveLength(1);
    expect((page.items[0] as ActivityItemEntry).run).toBeUndefined();
  });

  it('item entries carry the latest version, edit state and (with include=versions) the version list', async () => {
    rows = [row('note-1', 1, ContextItemType.MODIFIED_SUMMARY, { currentVersionNumber: 2 })];
    metas = [
      { contextItemId: 'note-1', versionNumber: 1, changeSource: 'ai', changedBy: 'system', changeReason: null, createdAt: t(1) },
      { contextItemId: 'note-1', versionNumber: 2, changeSource: 'manual', changedBy: 'doctor-1', changeReason: 'typo', createdAt: t(9) },
    ];
    const page = await makeService().getActivity(CID, { include: ['versions'] }, { admin: true });
    const entry = page.items[0] as ActivityItemEntry;
    expect(entry).toMatchObject({ kind: 'NOTE', versionCount: 2, edited: true, lastEditedAt: t(9).toISOString() });
    expect(entry.latestVersion).toMatchObject({ number: 2, changeSource: 'manual', changedBy: 'doctor-1', content: 'text of note-1' });
    expect(entry.versions?.map((v) => v.versionNumber)).toEqual([2, 1]);
  });

  it('decrypts at most the per-page cap, in bounded concurrent batches', async () => {
    const n = HISTORY_DECRYPT_CAP_PER_PAGE + 10;
    rows = Array.from({ length: n }, (_, i) => row(`n-${String(i).padStart(3, '0')}`, i, ContextItemType.CASE_NOTE));
    let inFlight = 0;
    let maxInFlight = 0;
    reads.readContents.mockImplementation(async (_tenant: string, ids: string[]) => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 5));
      inFlight -= 1;
      return new Map(ids.map((id) => [id, `text of ${id}`]));
    });
    const page = await makeService().getActivity(CID, { limit: 100 }, { admin: true });
    const decryptedIds = reads.readContents.mock.calls.flatMap((call) => call[1] as string[]);
    expect(decryptedIds).toHaveLength(HISTORY_DECRYPT_CAP_PER_PAGE);
    expect(maxInFlight).toBeLessThanOrEqual(2);
    expect(reads.readContents.mock.calls.length).toBeGreaterThan(1);
    const items = page.items as ActivityItemEntry[];
    expect(items[0].latestVersion.content).toBe(`text of ${items[0].id}`);
    expect(items[n - 1].latestVersion.content).toBeUndefined();
  });

  it('admin: attaches the producing run and first-page aggregates; business: neither', async () => {
    rows = [row('note-1', 1, ContextItemType.RAW_SUMMARY, { source: ContextItemSource.AI }), row('cn-1', 2, ContextItemType.CASE_NOTE)];
    reads.countEditedItems.mockResolvedValue(3);
    const producer = {
      activityRunId: 'run-1',
      activityKind: 'NOTE',
      encounterSeq: 1,
      workflowSlug: 'soap',
      workflowVersion: 4,
      workflowRunId: 'wf-1',
      nodeId: 'n1',
      agentSlug: 'soap-writer',
      agentVersion: 2,
      modelName: 'gemma',
      provider: 'lmstudio',
      deployment: null,
      promptTemplateId: null,
      promptVersion: null,
      startedAt: t(0),
      endedAt: t(1),
      contextUsed: 1000,
      contextWindow: 32768,
      outputCap: 2048,
      stopReason: 'stop',
      tokensIn: 900,
      tokensOut: 300,
      costMicros: 12n,
      costBasis: 'INTERNAL',
      durationMs: 1000,
    };
    runs.findProducerOf.mockImplementation(async (input: { contextItemId: string }) => (input.contextItemId === 'note-1' ? producer : null));
    runs.listForConsultation.mockResolvedValue([producer, { ...producer, activityRunId: 'run-2', tokensIn: 100, tokensOut: 50, costMicros: 3n, costBasis: 'BYOK_NOTIONAL' }]);

    const admin = await makeService().getActivity(CID, {}, { admin: true });
    const note = admin.items[0] as ActivityItemEntry;
    expect(note.run).toMatchObject({ runId: 'run-1', workflowSlug: 'soap', agentSlug: 'soap-writer', model: 'gemma', tokensIn: 900, costMicros: 12 });
    expect((admin.items[1] as ActivityItemEntry).run).toBeUndefined();
    expect(runs.findProducerOf).toHaveBeenCalledWith({ tenantId: TENANT, consultationId: CID, contextItemId: 'note-1', versionNumber: 1 });
    expect(admin.aggregates).toEqual({
      aiRunCount: 2,
      tokensIn: 1000,
      tokensOut: 350,
      costMicros: 15,
      costBasis: ['BYOK_NOTIONAL', 'INTERNAL'],
      editedItems: 3,
      feedbackUp: 0,
      feedbackDown: 0,
    });

    const next = await makeService().getActivity(CID, { cursor: encodeCursor({ k: t(0).toISOString(), id: 'a' }) }, { admin: true });
    expect(next.aggregates).toBeUndefined();

    runs.findProducerOf.mockClear();
    runs.listForConsultation.mockClear();
    clsStore.user = DOCTOR;
    const business = await makeService().getActivity(CID, {}, { admin: false });
    expect((business.items[0] as ActivityItemEntry).run).toBeUndefined();
    expect(business.aggregates).toBeUndefined();
    expect(runs.findProducerOf).not.toHaveBeenCalled();
    expect(runs.listForConsultation).not.toHaveBeenCalled();
  });

  it('returns the consultation status and audits the read with forceAuditLog and no content', async () => {
    rows = [row('note-1', 1, ContextItemType.CASE_NOTE)];
    const page = await makeService().getActivity(CID, {}, { admin: true });
    expect(page).toMatchObject({ consultationId: CID, status: 'STOPPED', processing: 'IDLE' });
    expect(events.emit).toHaveBeenCalledWith(
      SysEventType.ResourceViewed,
      expect.objectContaining({ resourceId: CID, forceAuditLog: true, data: expect.objectContaining({ consultationId: CID, plane: 'admin' }) }),
    );
    expect(JSON.stringify(events.emit.mock.calls)).not.toContain('text of');
  });
});

describe('ConsultationHistoryService — versions and recap', () => {
  beforeEach(() => {
    reads.findItem.mockResolvedValue({ id: 'note-1', consultationId: CID, type: ContextItemType.MODIFIED_SUMMARY, currentVersionNumber: 2 });
    metas = [
      { contextItemId: 'note-1', versionNumber: 1, changeSource: 'ai', changedBy: 'system', changeReason: null, createdAt: t(1) },
      { contextItemId: 'note-1', versionNumber: 2, changeSource: 'manual', changedBy: 'doctor-1', changeReason: 'typo', createdAt: t(9) },
    ];
    versions.getVersion.mockImplementation(async (_id: string, n: number) =>
      n > 2
        ? null
        : { id: `v-${n}`, contextItemId: 'note-1', versionNumber: n, content: `body v${n}`, changeSource: n === 1 ? 'ai' : 'manual', changedBy: 'doctor-1', changeReason: null, createdAt: t(n) },
    );
  });

  it('lists versions newest-first without content', async () => {
    const list = await makeService().listItemVersions(CID, 'note-1', { admin: true });
    expect(list.map((v) => v.versionNumber)).toEqual([2, 1]);
    expect(JSON.stringify(list)).not.toContain('body');
  });

  it('returns one decrypted version, 404 for a missing one', async () => {
    await expect(makeService().getItemVersion(CID, 'note-1', 2, { admin: true })).resolves.toMatchObject({ contextItemId: 'note-1', versionNumber: 2, content: 'body v2' });
    await expect(makeService().getItemVersion(CID, 'note-1', 7, { admin: true })).rejects.toBeInstanceOf(NotFoundException);
  });

  it('diffs a version against another', async () => {
    const diff = await makeService().diffItemVersions(CID, 'note-1', 2, 1, { admin: true });
    expect(diff.contextItemId).toBe('note-1');
    expect(diff.from.versionNumber).toBe(1);
    expect(diff.to.versionNumber).toBe(2);
  });

  it('an item of another consultation is 404, and the admin gate still runs first', async () => {
    reads.findItem.mockResolvedValue({ id: 'note-1', consultationId: 'cons-other', type: ContextItemType.RAW_SUMMARY, currentVersionNumber: 1 });
    await expect(makeService().listItemVersions(CID, 'note-1', { admin: true })).rejects.toBeInstanceOf(NotFoundException);
    clsStore.user = DOCTOR;
    await expect(makeService().listItemVersions(CID, 'note-1', { admin: true })).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('reads an encounter recap, 404 when there is none', async () => {
    contextItems.findEncounterArtifact.mockImplementation(async (_cid: string, type: ContextItemType, seq: number) =>
      seq === 1 && type === ContextItemType.ENCOUNTER_RECAP
        ? { id: 'recap-1', content: '## Complaint\nheadache', currentVersionNumber: 3, updatedAt: t(20), metaData: { ledgerItemId: 'ledger-1', ledgerVersion: 2 } }
        : null,
    );
    clsStore.user = DOCTOR;
    await expect(makeService().getRecap(CID, 1, { admin: false })).resolves.toEqual({
      encounterSeq: 1,
      contextItemId: 'recap-1',
      versionNumber: 3,
      text: '## Complaint\nheadache',
      generatedAt: t(20).toISOString(),
      ledgerContextItemId: 'ledger-1',
    });
    await expect(makeService().getRecap(CID, 2, { admin: false })).rejects.toBeInstanceOf(NotFoundException);
  });
});
