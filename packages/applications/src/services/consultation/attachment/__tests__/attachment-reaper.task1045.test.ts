/**
 * Unfinished upload intents are reaped: INTENT → EXPIRED by a CONDITIONAL update, so a late
 * `complete` that already claimed the row is never undone, then a best-effort delete of whatever
 * the client may have PUT. Self-scheduled from `consultation.attachments.reapCron`; one replica at
 * a time through a Redis lock; every tenant's row is handled in that tenant's worker context.
 */
import 'reflect-metadata';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ConsultationAttachmentEntity, ConsultationAttachmentFactory } from '@arcaai/domains';
import { AttachmentReaperService } from '../attachment-reaper.service';
import { CONSULTATION, FakeAttachmentRepository, FakeBlobStorage, OTHER_TENANT, TENANT, makeCls, makeSettings } from './attachment-fakes.task1045';

function intent(tenantId: string, expiredMsAgo: number): ConsultationAttachmentEntity {
  return ConsultationAttachmentFactory.CreateConsultationAttachment({
    tenantId,
    consultationId: CONSULTATION,
    kind: 'DOCUMENT' as never,
    declaredMime: 'application/pdf',
    declaredSizeBytes: 10,
    declaredSha256: 'a'.repeat(64),
    bucketName: `${tenantId}-attachments`,
    objectKey: `consultations/2026/10/${CONSULTATION}/attachments/x/x.pdf`,
    uploadExpiresAt: new Date(Date.now() - expiredMsAgo - 1000),
    intentExpiresAt: new Date(Date.now() - expiredMsAgo),
  });
}

function setup() {
  const repo = new FakeAttachmentRepository();
  const blob = new FakeBlobStorage();
  const settings = makeSettings();
  const scheduler = { addCronJob: vi.fn(), getCronJob: vi.fn(() => undefined), deleteCronJob: vi.fn() };
  const redis = { eval: vi.fn(async () => 'OK'), del: vi.fn(async () => undefined) };
  const emitter = { emit: vi.fn() };
  const cls = makeCls(null, null);
  const reaper = new AttachmentReaperService(
    emitter as never,
    cls as never,
    settings as never,
    scheduler as never,
    repo as never,
    blob as never,
    redis as never,
  );
  return { repo, blob, settings, scheduler, redis, emitter, cls, reaper };
}

describe('AttachmentReaperService', () => {
  let s: ReturnType<typeof setup>;
  beforeEach(() => {
    s = setup();
  });

  it('expires every lapsed intent and deletes its object in the owning tenant’s context', async () => {
    const a = intent(TENANT, 60_000);
    const b = intent(OTHER_TENANT, 60_000);
    const fresh = intent(TENANT, -3_600_000);
    for (const row of [a, b, fresh]) s.repo.rows.set(row.id, row);
    s.blob.clientPut(a.bucketName, a.objectKey, Buffer.from('%PDF-'));

    const result = await s.reaper.reapExpired();

    expect(result).toEqual({ expired: 2, objectDeleteFailures: 0 });
    expect(a.status).toBe('EXPIRED');
    expect(b.status).toBe('EXPIRED');
    expect(fresh.status).toBe('INTENT');
    expect(s.blob.deleteObject).toHaveBeenCalledWith({ bucket: a.bucketName, key: a.objectKey });
    expect(s.blob.objects.size).toBe(0);
    expect(s.cls.set).toHaveBeenCalledWith('tenantId', TENANT);
    expect(s.cls.set).toHaveBeenCalledWith('tenantId', OTHER_TENANT);
    expect(s.emitter.emit).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ resourceId: a.id, data: expect.objectContaining({ status: 'EXPIRED' }) }),
    );
    expect(s.redis.del).toHaveBeenCalled();
  });

  it('never touches a row a late complete claimed first (conditional update lost)', async () => {
    const a = intent(TENANT, 60_000);
    s.repo.rows.set(a.id, a);
    s.repo.expireIntent.mockImplementationOnce(async () => {
      (a as unknown as { status: string }).status = 'UPLOADED';
      return false;
    });

    const result = await s.reaper.reapExpired();

    expect(result.expired).toBe(0);
    expect(a.status).toBe('UPLOADED');
    expect(s.blob.deleteObject).not.toHaveBeenCalled();
  });

  it('a failed object delete does not undo the expiry or stop the run', async () => {
    const a = intent(TENANT, 60_000);
    const b = intent(TENANT, 60_000);
    s.repo.rows.set(a.id, a);
    s.repo.rows.set(b.id, b);
    s.blob.deleteObject.mockRejectedValueOnce(new Error('store down'));

    const result = await s.reaper.reapExpired();
    expect(result.expired).toBe(2);
    expect(a.status).toBe('EXPIRED');
    expect(b.status).toBe('EXPIRED');
  });

  it('skips the run while another replica holds the lock', async () => {
    s.repo.rows.set('x', intent(TENANT, 60_000));
    s.redis.eval.mockResolvedValueOnce(null as never);
    const result = await s.reaper.reapExpired();
    expect(result).toMatchObject({ skipped: 'locked', expired: 0 });
    expect(s.repo.expireIntent).not.toHaveBeenCalled();
  });

  it('schedules itself from the reap cron setting', () => {
    s.reaper.onModuleInit();
    expect(s.settings.resolvePlatform).toHaveBeenCalledWith('consultation.attachments.reapCron');
    expect(s.scheduler.addCronJob).toHaveBeenCalledWith('consultation-attachment-reaper', expect.anything());
    s.reaper.onModuleDestroy();
  });
});
