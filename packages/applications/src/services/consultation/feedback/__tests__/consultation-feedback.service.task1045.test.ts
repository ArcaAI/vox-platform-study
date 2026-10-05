/**
 * ConsultationFeedbackService — create / list / listForActivity / reasonCodes.
 *
 * Repositories, the lifecycle gate, the context service and the provenance
 * reader are stubs; the idempotency service is the real one over an in-memory
 * Redis stand-in so replay and key-reuse are exercised end to end.
 */

import {
  ConsultationAttachmentPurpose,
  ConsultationAttachmentStatus,
  ConsultationFeedbackEntity,
  FeedbackRating,
  FeedbackTargetKind,
  ResourceType,
  SysEventType,
} from '@arcaai/domains';
import { BadRequestException, ConflictException, NotFoundException, PayloadTooLargeException } from '@nestjs/common';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { JobIdempotencyService } from '../../jobs/job-idempotency.service';
import { ConsultationFeedbackService } from '../consultation-feedback.service';
import { FeedbackProvenanceResolver } from '../feedback-provenance';
import { CreateFeedbackRequest } from '../dto';

const TENANT = 'tenant-1';
const CONSULTATION = 'consultation-1';
const DOCTOR = 'doctor-1';
const USER = 'user-1';
const ITEM = 'item-note-1';
const TX = { __tx: true };

const human = { userId: USER, isMachine: false };
const serviceAccount = { serviceAccountId: 'sa-1', isMachine: true };

function makeConsultation(overrides: Record<string, unknown> = {}) {
  return { id: CONSULTATION, tenantId: TENANT, doctorId: DOCTOR, currentEncounterSeq: 2, ...overrides };
}

function makeItem(overrides: Record<string, unknown> = {}) {
  return { id: ITEM, tenantId: TENANT, consultationId: CONSULTATION, currentVersionNumber: 3, encounterSeq: 1, ...overrides };
}

/** An in-memory stand-in for the Redis calls JobIdempotencyService makes. */
function makeCache() {
  const store = new Map<string, string>();
  return {
    store,
    get: vi.fn(async (k: string) => store.get(k) ?? null),
    setex: vi.fn(async (k: string, _ttl: number, v: string) => {
      store.set(k, v);
    }),
    del: vi.fn(async (k: string) => {
      store.delete(k);
    }),
    eval: vi.fn(async (_script: string, _n: number, k: string, v: string) => {
      const prior = store.get(k);
      if (prior !== undefined) return prior;
      store.set(k, v);
      return null;
    }),
  };
}

let saved: Map<string, ConsultationFeedbackEntity>;

const feedbackRepository = {
  appendWithSupersede: vi.fn(),
  findById: vi.fn(),
  findAll: vi.fn(),
  listCursor: vi.fn(),
  encryptFieldsIntoEntity: vi.fn(),
  decryptFieldsFromEntity: vi.fn(),
};
const consultationRepository = { findById: vi.fn() };
const contextItemRepository = { findByIdOrNull: vi.fn() };
const namedEntityRepository = { findByIdOrNull: vi.fn() };
const attachmentRepository = { findByIdOrNull: vi.fn() };
const unitOfWork = { runInTransaction: vi.fn(async (work: (tx: unknown) => Promise<unknown>) => work(TX)) };
const gate = { assertContentWritable: vi.fn(), touchActivity: vi.fn() };
const contextService = { appendVersion: vi.fn(), getSummaryMeta: vi.fn() };
const runReader = { findProducerOf: vi.fn(), listForConsultation: vi.fn() };
const settings = { resolve: vi.fn() };
const miningQueue = { enqueue: vi.fn() };
const secrets = { encrypt: vi.fn() };
const eventEmitter = { emit: vi.fn() };
const cls = { get: vi.fn(), set: vi.fn() };

let cache: ReturnType<typeof makeCache>;
let tenantReasons: unknown;

function build(opts: { reader?: boolean } = {}): ConsultationFeedbackService {
  const provenance = new FeedbackProvenanceResolver(contextService as never, opts.reader === false ? undefined : (runReader as never));
  return new ConsultationFeedbackService(
    eventEmitter as never,
    cls as never,
    feedbackRepository as never,
    consultationRepository as never,
    contextItemRepository as never,
    namedEntityRepository as never,
    attachmentRepository as never,
    unitOfWork as never,
    gate as never,
    contextService as never,
    provenance,
    settings as never,
    new JobIdempotencyService(cache as never),
    miningQueue as never,
    secrets as never,
  );
}

function body(partial: Partial<CreateFeedbackRequest>): CreateFeedbackRequest {
  return partial as CreateFeedbackRequest;
}

function sysEvents(type: SysEventType) {
  return eventEmitter.emit.mock.calls.filter(([t]) => t === type);
}

beforeEach(() => {
  vi.clearAllMocks();
  gate.assertContentWritable.mockReset().mockResolvedValue(undefined);
  gate.touchActivity.mockReset().mockResolvedValue(undefined);
  miningQueue.enqueue.mockReset().mockResolvedValue(undefined);
  unitOfWork.runInTransaction.mockReset().mockImplementation(async (work: (tx: unknown) => Promise<unknown>) => work(TX));
  saved = new Map();
  cache = makeCache();
  tenantReasons = undefined;

  cls.get.mockImplementation((key: string) => {
    if (key === 'tenantId') return TENANT;
    if (key === 'user') return { id: USER };
    return undefined;
  });
  consultationRepository.findById.mockResolvedValue(makeConsultation());
  contextItemRepository.findByIdOrNull.mockResolvedValue(makeItem());
  settings.resolve.mockImplementation((key: string) => {
    if (key === 'consultation.feedback.reasonCodes') {
      return tenantReasons
        ? { key, value: tenantReasons, source: 'tenant' }
        : {
            key,
            value: [
              { code: 'missing_information', label: 'Missing information' },
              { code: 'too_long', label: 'Too long' },
            ],
            source: 'code-default',
          };
    }
    if (key === 'consultation.feedback.commentMaxChars') return { key, value: 20, source: 'system' };
    if (key === 'consultation.feedback.maxMediaPerFeedback') return { key, value: 2, source: 'code-default' };
    throw new Error(`unexpected key ${key}`);
  });
  feedbackRepository.appendWithSupersede.mockImplementation(async (entity: ConsultationFeedbackEntity) => {
    saved.set(entity.id, entity);
    return { saved: entity, superseded: null };
  });
  feedbackRepository.findById.mockImplementation(async (id: string) => saved.get(id));
  feedbackRepository.findAll.mockResolvedValue([]);
  feedbackRepository.encryptFieldsIntoEntity.mockImplementation(async (entity: ConsultationFeedbackEntity) => {
    if (entity.comment) {
      entity.encryptedComment = Buffer.from(`enc:${entity.comment}`);
      entity.keyVersion = 1;
    }
  });
  feedbackRepository.decryptFieldsFromEntity.mockImplementation(async (entity: ConsultationFeedbackEntity) => {
    const plain = entity.encryptedComment ? entity.encryptedComment.toString().replace(/^enc:/, '') : null;
    entity.comment = plain;
    return plain;
  });
  runReader.findProducerOf.mockResolvedValue({
    activityRunId: 'run-1',
    activityKind: 'SUMMARY',
    encounterSeq: 1,
    workflowSlug: 'soap',
    workflowVersion: 4,
    workflowRunId: 'wf-run-1',
    nodeId: 'node-summary',
    agentSlug: 'soap-writer',
    agentVersion: 7,
    modelName: 'gemma-3-27b',
    provider: 'lmstudio',
    deployment: null,
    promptTemplateId: 'pt-1',
    promptVersion: 5,
    startedAt: new Date('2026-10-05T10:00:00Z'),
    endedAt: new Date('2026-10-05T10:00:05Z'),
    costMicros: 12n,
  });
  contextService.getSummaryMeta.mockResolvedValue(null);
  contextService.appendVersion.mockResolvedValue({ versionNumber: 4 });
});

describe('ConsultationFeedbackService.create', () => {
  it('pins the current version, stamps provenance, appends with supersede in a transaction and broadcasts ResourceCreated', async () => {
    const res = await build().create(CONSULTATION, body({ target: { kind: 'NOTE', contextItemId: ITEM }, rating: 'up' }), undefined, human);

    expect(unitOfWork.runInTransaction).toHaveBeenCalledTimes(1);
    const [entity, tx] = feedbackRepository.appendWithSupersede.mock.calls[0];
    expect(tx).toBe(TX);
    expect(entity.targetVersionNumber).toBe(3);
    expect(entity.targetKey).toBe(`NOTE|${ITEM}|3||`);
    expect(entity.rating).toBe(FeedbackRating.UP);
    expect(entity.targetKind).toBe(FeedbackTargetKind.NOTE);
    expect(entity.actorUserId).toBe(USER);
    expect(entity.actorCredentialClass).toBe('jwt');
    expect(entity.encounterSeq).toBe(1);
    expect(entity.provAgentSlug).toBe('soap-writer');
    expect(entity.provAgentVersion).toBe(7);
    expect(entity.provModelName).toBe('gemma-3-27b');
    expect(entity.provPromptVersion).toBe('5');
    expect(entity.provWorkflowRunId).toBe('wf-run-1');
    expect(entity.provActivityRunId).toBe('run-1');
    expect(runReader.findProducerOf).toHaveBeenCalledWith({ tenantId: TENANT, consultationId: CONSULTATION, contextItemId: ITEM, versionNumber: 3 });

    expect(res.rating).toBe('up');
    expect(res.target).toMatchObject({ kind: 'NOTE', contextItemId: ITEM, versionNumber: 3 });
    expect(res.provenance).toMatchObject({ agentSlug: 'soap-writer', activityRunId: 'run-1' });
    expect(res.actor).toEqual({ userId: USER, credentialClass: 'jwt' });
    expect(res.isLatest).toBe(true);

    const created = sysEvents(SysEventType.ResourceCreated);
    expect(created).toHaveLength(1);
    expect(created[0][1]).toMatchObject({ resourceType: ResourceType.ConsultationFeedback, resourceId: res.id });
    expect(JSON.stringify(created[0][1].data)).not.toContain('comment');

    expect(gate.touchActivity).toHaveBeenCalledWith(CONSULTATION);
    expect(gate.assertContentWritable).not.toHaveBeenCalled();
    expect(miningQueue.enqueue).not.toHaveBeenCalled();
  });

  it('allows a rating on a locked (approved) consultation — only corrections hit the lifecycle gate', async () => {
    gate.assertContentWritable.mockRejectedValue(new ConflictException({ code: 'CONSULTATION_APPROVED' }));
    await expect(
      build().create(CONSULTATION, body({ target: { kind: 'SECTION', contextItemId: ITEM, sectionKey: 'plan' }, rating: 'down' }), undefined, human),
    ).resolves.toBeDefined();
    expect(gate.assertContentWritable).not.toHaveBeenCalled();
  });

  it('refuses a reason code outside the effective (tenant) list with 400 FEEDBACK_REASON_UNKNOWN', async () => {
    tenantReasons = [{ code: 'wrong_dose', label: 'Wrong dose' }];
    const err = await build()
      .create(CONSULTATION, body({ target: { kind: 'NOTE', contextItemId: ITEM }, rating: 'down', reasonCodes: ['too_long'] }), undefined, human)
      .catch((e) => e);
    expect(err).toBeInstanceOf(BadRequestException);
    expect(err.getResponse()).toMatchObject({ code: 'FEEDBACK_REASON_UNKNOWN', allowed: ['wrong_dose'] });
    expect(feedbackRepository.appendWithSupersede).not.toHaveBeenCalled();
  });

  it('maps an over-long comment to 413 and an empty body to 400 FEEDBACK_EMPTY', async () => {
    await expect(build().create(CONSULTATION, body({ comment: 'x'.repeat(21) }), undefined, human)).rejects.toBeInstanceOf(PayloadTooLargeException);
    const err = await build()
      .create(CONSULTATION, body({}), undefined, human)
      .catch((e) => e);
    expect(err.getResponse()).toMatchObject({ code: 'FEEDBACK_EMPTY' });
  });

  it('answers 404 for a consultation in another tenant', async () => {
    consultationRepository.findById.mockResolvedValue(makeConsultation({ tenantId: 'tenant-2' }));
    await expect(build().create(CONSULTATION, body({ comment: 'hi' }), undefined, human)).rejects.toBeInstanceOf(NotFoundException);
  });

  it('answers 404 when the target item belongs to another consultation or the version does not exist', async () => {
    contextItemRepository.findByIdOrNull.mockResolvedValueOnce(makeItem({ consultationId: 'other' }));
    await expect(
      build().create(CONSULTATION, body({ target: { kind: 'NOTE', contextItemId: ITEM }, rating: 'up' }), undefined, human),
    ).rejects.toBeInstanceOf(NotFoundException);
    await expect(
      build().create(CONSULTATION, body({ target: { kind: 'NOTE', contextItemId: ITEM, versionNumber: 9 }, rating: 'up' }), undefined, human),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('validates an entity target against its item and stamps the entity label', async () => {
    namedEntityRepository.findByIdOrNull.mockResolvedValueOnce({ id: 'ne-1', tenantId: TENANT, contextItemId: 'elsewhere', className: 'MEDICATION' });
    await expect(
      build().create(CONSULTATION, body({ target: { kind: 'ENTITY', contextItemId: ITEM, entityRef: 'ne-1' }, rating: 'down' }), undefined, human),
    ).rejects.toBeInstanceOf(NotFoundException);

    namedEntityRepository.findByIdOrNull.mockResolvedValueOnce({ id: 'ne-1', tenantId: TENANT, contextItemId: ITEM, className: 'MEDICATION' });
    await build().create(CONSULTATION, body({ target: { kind: 'ENTITY', contextItemId: ITEM, entityRef: 'ne-1' }, rating: 'up' }), undefined, human);
    const [entity] = feedbackRepository.appendWithSupersede.mock.calls[0];
    expect(entity.entityLabel).toBe('MEDICATION');
    expect(entity.targetKey).toBe(`ENTITY|${ITEM}|3||ne-1`);

    const err = await build()
      .create(CONSULTATION, body({ target: { kind: 'ENTITY', contextItemId: ITEM }, rating: 'up' }), undefined, human)
      .catch((e) => e);
    expect(err.getResponse()).toMatchObject({ code: 'FEEDBACK_TARGET_REQUIRED' });
  });

  it('writes a correction as a new item version in the same transaction, linked both ways, and queues it for mining', async () => {
    unitOfWork.runInTransaction.mockImplementationOnce(async (work: (tx: unknown) => Promise<unknown>) => {
      const out = await work(TX);
      expect(contextService.appendVersion).toHaveBeenCalled();
      expect(feedbackRepository.appendWithSupersede).toHaveBeenCalled();
      return out;
    });
    const res = await build().create(
      CONSULTATION,
      body({
        target: { kind: 'SECTION', contextItemId: ITEM, sectionKey: 'plan' },
        correction: { content: 'Amoxicillin 500 mg', expectedVersion: 3 },
      }),
      'key-1',
      human,
    );

    expect(gate.assertContentWritable).toHaveBeenCalledWith(CONSULTATION);
    const [entity] = feedbackRepository.appendWithSupersede.mock.calls[0];
    expect(contextService.appendVersion).toHaveBeenCalledWith({
      contextItemId: ITEM,
      content: 'Amoxicillin 500 mg',
      expectedVersion: 3,
      changeSource: 'feedback',
      changeReason: 'feedback',
      changedBy: USER,
      metaData: { feedbackId: entity.id },
    });
    expect(entity.correctionContextItemId).toBe(ITEM);
    expect(entity.correctionVersionNumber).toBe(4);
    expect(res.correction).toEqual({ contextItemId: ITEM, versionNumber: 4 });
    expect(miningQueue.enqueue).toHaveBeenCalledWith(
      expect.objectContaining({ tenantId: TENANT, consultationId: CONSULTATION, contextItemId: ITEM, source: 'feedback', feedbackId: entity.id }),
    );
  });

  it('refuses a correction once the consultation is approved (409 from the gate) and writes nothing', async () => {
    gate.assertContentWritable.mockRejectedValue(new ConflictException({ code: 'CONSULTATION_APPROVED' }));
    await expect(
      build().create(CONSULTATION, body({ target: { kind: 'NOTE', contextItemId: ITEM }, correction: { content: 'x' } }), undefined, human),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(contextService.appendVersion).not.toHaveBeenCalled();
    expect(feedbackRepository.appendWithSupersede).not.toHaveBeenCalled();
  });

  it('encrypts the comment and answers it decrypted', async () => {
    const res = await build().create(CONSULTATION, body({ comment: 'too wordy' }), undefined, human);
    const [entity] = feedbackRepository.appendWithSupersede.mock.calls[0];
    expect(feedbackRepository.encryptFieldsIntoEntity).toHaveBeenCalledWith(entity, secrets);
    expect(entity.encryptedComment?.toString()).toBe('enc:too wordy');
    expect(entity.targetKey).toBeNull();
    expect(res.comment).toBe('too wordy');
    expect(res.target).toBeNull();
  });

  it('attributes a machine caller to the consultation doctor and records its principal', async () => {
    const res = await build().create(CONSULTATION, body({ target: { kind: 'NOTE', contextItemId: ITEM }, rating: 'up' }), undefined, serviceAccount);
    const [entity] = feedbackRepository.appendWithSupersede.mock.calls[0];
    expect(entity.actorUserId).toBe(DOCTOR);
    expect(entity.actorPrincipalId).toBe('sa-1');
    expect(entity.actorCredentialClass).toBe('service-account');
    expect(res.actor).toEqual({ userId: DOCTOR, credentialClass: 'service-account' });
  });

  it('accepts only READY purpose=feedback attachments of this consultation and stores their media ids', async () => {
    const ready = {
      id: 'att-1',
      tenantId: TENANT,
      consultationId: CONSULTATION,
      purpose: ConsultationAttachmentPurpose.FEEDBACK,
      status: ConsultationAttachmentStatus.READY,
      mediaId: 'media-1',
    };
    attachmentRepository.findByIdOrNull.mockResolvedValueOnce(ready);
    const res = await build().create(CONSULTATION, body({ comment: 'see photo', attachmentIds: ['att-1'] }), undefined, human);
    expect(feedbackRepository.appendWithSupersede.mock.calls[0][0].mediaIds).toEqual(['media-1']);
    expect(res.attachmentIds).toEqual(['media-1']);

    for (const bad of [
      { ...ready, status: ConsultationAttachmentStatus.PROCESSING },
      { ...ready, purpose: ConsultationAttachmentPurpose.ATTACHMENT },
      { ...ready, consultationId: 'other' },
      null,
    ]) {
      attachmentRepository.findByIdOrNull.mockResolvedValueOnce(bad);
      const err = await build()
        .create(CONSULTATION, body({ comment: 'x', attachmentIds: ['att-1'] }), undefined, human)
        .catch((e) => e);
      expect(err).toBeInstanceOf(BadRequestException);
      expect(err.getResponse()).toMatchObject({ code: 'FEEDBACK_ATTACHMENT_INVALID' });
    }
  });

  it('falls back to SummaryMeta provenance when the run reader is absent or has no producer', async () => {
    contextService.getSummaryMeta.mockResolvedValue({
      id: 'sm-1',
      aiModelId: 'model-id-1',
      aiModelVersion: 'gemma-3-27b',
      promptVersion: 'v3',
      hasAnyContext: true,
    });
    await build({ reader: false }).create(CONSULTATION, body({ target: { kind: 'NOTE', contextItemId: ITEM }, rating: 'up' }), undefined, human);
    let [entity] = feedbackRepository.appendWithSupersede.mock.calls[0];
    expect(entity.provModelName).toBe('gemma-3-27b');
    expect(entity.provPromptVersion).toBe('v3');
    expect(entity.provActivityRunId).toBeNull();
    expect(entity.provenance).toMatchObject({ source: 'summary_meta' });

    runReader.findProducerOf.mockRejectedValueOnce(new Error('reader down'));
    await build().create(CONSULTATION, body({ target: { kind: 'NOTE', contextItemId: ITEM }, rating: 'up' }), undefined, human);
    [entity] = feedbackRepository.appendWithSupersede.mock.calls[1];
    expect(entity.provModelName).toBe('gemma-3-27b');
  });

  it('queues a thumbs-down for mining, and a failing queue never fails the write', async () => {
    miningQueue.enqueue.mockRejectedValue(new Error('redis down'));
    await expect(
      build().create(CONSULTATION, body({ target: { kind: 'NOTE', contextItemId: ITEM }, rating: 'down' }), undefined, human),
    ).resolves.toBeDefined();
    expect(miningQueue.enqueue).toHaveBeenCalledTimes(1);
  });

  it('replays the same row for the same key and body, and answers 409 IDEMPOTENCY_KEY_REUSED for a different body', async () => {
    const service = build();
    const first = await service.create(CONSULTATION, body({ target: { kind: 'NOTE', contextItemId: ITEM }, rating: 'up' }), 'idem-1', human);
    const replay = await service.create(CONSULTATION, body({ target: { kind: 'NOTE', contextItemId: ITEM }, rating: 'up' }), 'idem-1', human);
    expect(replay.id).toBe(first.id);
    expect(feedbackRepository.appendWithSupersede).toHaveBeenCalledTimes(1);
    expect(sysEvents(SysEventType.ResourceCreated)).toHaveLength(1);

    const err = await service
      .create(CONSULTATION, body({ target: { kind: 'NOTE', contextItemId: ITEM }, rating: 'down' }), 'idem-1', human)
      .catch((e) => e);
    expect(err).toBeInstanceOf(ConflictException);
    expect(err.getResponse()).toMatchObject({ code: 'IDEMPOTENCY_KEY_REUSED' });
  });

  it('replays a stored row with the same key when the idempotency cache is unavailable', async () => {
    const service = build();
    const first = await service.create(CONSULTATION, body({ comment: 'hello' }), 'idem-2', human);
    cache.eval.mockRejectedValue(new Error('redis down'));
    feedbackRepository.findAll.mockResolvedValueOnce([saved.get(first.id)]);
    const replay = await service.create(CONSULTATION, body({ comment: 'hello' }), 'idem-2', human);
    expect(replay.id).toBe(first.id);
    expect(feedbackRepository.appendWithSupersede).toHaveBeenCalledTimes(1);
    expect(feedbackRepository.findAll).toHaveBeenLastCalledWith({
      where: { consultationId: CONSULTATION, idempotencyKey: 'idem-2', actorUserId: USER },
      limit: 1,
    });
  });
});

describe('ConsultationFeedbackService.list / listForActivity', () => {
  async function seedOne(): Promise<ConsultationFeedbackEntity> {
    const service = build();
    const res = await service.create(
      CONSULTATION,
      body({ target: { kind: 'NOTE', contextItemId: ITEM }, rating: 'down', comment: 'wrong' }),
      undefined,
      human,
    );
    return saved.get(res.id)!;
  }

  it('lists latest-only by default with decrypted comments and an opaque cursor that round-trips', async () => {
    const row = await seedOne();
    feedbackRepository.listCursor.mockResolvedValueOnce({ items: [row], next: { createdAt: row.createdAt, id: row.id } });
    const page = await build().list(CONSULTATION, { targetKind: 'NOTE', contextItemId: ITEM, limit: 5 });
    expect(feedbackRepository.listCursor).toHaveBeenCalledWith(CONSULTATION, {
      limit: 5,
      targetKind: FeedbackTargetKind.NOTE,
      contextItemId: ITEM,
      includeHistory: false,
      after: undefined,
    });
    expect(page.items[0]).toMatchObject({ id: row.id, comment: 'wrong', rating: 'down' });
    expect(typeof page.nextCursor).toBe('string');

    feedbackRepository.listCursor.mockResolvedValueOnce({ items: [], next: null });
    const next = await build().list(CONSULTATION, { cursor: page.nextCursor!, includeHistory: true });
    expect(feedbackRepository.listCursor).toHaveBeenLastCalledWith(CONSULTATION, {
      limit: 20,
      targetKind: undefined,
      contextItemId: undefined,
      includeHistory: true,
      after: { createdAt: row.createdAt, id: row.id },
    });
    expect(next.nextCursor).toBeNull();
  });

  it('rejects a malformed cursor with 400 and an out-of-tenant consultation with 404', async () => {
    await expect(build().list(CONSULTATION, { cursor: '%%%' })).rejects.toBeInstanceOf(BadRequestException);
    consultationRepository.findById.mockResolvedValue(makeConsultation({ tenantId: 'tenant-2' }));
    await expect(build().list(CONSULTATION, {})).rejects.toBeInstanceOf(NotFoundException);
  });

  it('listForActivity includes history and decrypted comments', async () => {
    const row = await seedOne();
    feedbackRepository.listCursor.mockResolvedValueOnce({ items: [row], next: null });
    const page = await build().listForActivity(CONSULTATION, { limit: 50 });
    expect(feedbackRepository.listCursor).toHaveBeenLastCalledWith(CONSULTATION, expect.objectContaining({ includeHistory: true, limit: 50 }));
    expect(page.items[0].comment).toBe('wrong');
  });
});

describe('ConsultationFeedbackService.reasonCodes', () => {
  it('answers the tenant list with source tenant, else the platform list with source system', async () => {
    tenantReasons = [{ code: 'wrong_dose', label: 'Wrong dose', appliesTo: ['NOTE'] }];
    await expect(build().reasonCodes(TENANT)).resolves.toEqual({
      items: [{ code: 'wrong_dose', label: 'Wrong dose', appliesTo: ['NOTE'] }],
      source: 'tenant',
    });
    expect(settings.resolve).toHaveBeenCalledWith('consultation.feedback.reasonCodes', TENANT);

    tenantReasons = undefined;
    const platform = await build().reasonCodes();
    expect(platform.source).toBe('system');
    expect(platform.items.map((r) => r.code)).toEqual(['missing_information', 'too_long']);
  });
});
