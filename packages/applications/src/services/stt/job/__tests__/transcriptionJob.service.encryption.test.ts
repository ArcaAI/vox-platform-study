/**
 * TranscriptionJobService.completeJob encryption wiring.
 *
 * `completeJob` is a genuine TS write path for the STT result fields
 * (resultText / resultMetadata) — the Python stt worker posts the result
 * back through the apps/api gateway, which calls this service. This test
 * verifies the completed job is encrypted BEFORE persist, that encryption is
 * best-effort (a Vault outage still persists the plaintext result), that no
 * SecretsService skips encryption, and that the response DTO never carries the
 * ciphertext columns.
 *
 * Repository + SecretsService + CLS + emitter are mocked — no DB / Vault.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { TranscriptionJobService } from '../transcriptionJob.service';

function makeJob() {
  const job: Record<string, unknown> = {
    id: 'job-1',
    tenantId: 'tenant-1',
    status: 'PROCESSING',
    resultText: null,
    resultMetadata: null,
    createdBy: 'user-1',
  };
  job.complete = vi.fn((text: string, meta?: unknown) => {
    job.resultText = text;
    job.resultMetadata = meta ?? null;
    job.status = 'COMPLETED';
  });
  return job;
}

function buildService(withSecrets: boolean) {
  const jobRepository = {
    findById: vi.fn(),
    update: vi.fn(async (_id: string, e: unknown) => e),
    encryptFieldsIntoEntity: vi.fn(async () => undefined),
  };
  const pipelineRepository = {};
  const eventEmitter = { emit: vi.fn() };
  const clsService = { get: vi.fn((k: string) => (k === 'tenantId' ? 'tenant-1' : k === 'user' ? { id: 'user-1' } : null)) };
  const secretsService = { encrypt: vi.fn(), decrypt: vi.fn() };

  const service = new TranscriptionJobService(
    jobRepository as never,
    pipelineRepository as never,
    eventEmitter as never,
    clsService as never,
    withSecrets ? (secretsService as never) : undefined,
  );
  return { service, jobRepository, secretsService };
}

describe('TranscriptionJobService.completeJob — field encryption', () => {
  beforeEach(() => vi.clearAllMocks());

  it('encrypts the completed job BEFORE persisting, with no ciphertext in the DTO', async () => {
    const { service, jobRepository, secretsService } = buildService(true);
    const job = makeJob();
    jobRepository.findById.mockResolvedValue(job);

    const res = await service.completeJob('job-1', 'transcript text', { confidence: 0.9 });

    expect(jobRepository.encryptFieldsIntoEntity).toHaveBeenCalledTimes(1);
    expect(jobRepository.encryptFieldsIntoEntity).toHaveBeenCalledWith(job, secretsService);
    // result set on the entity, then encrypt, then persist
    expect((job.complete as ReturnType<typeof vi.fn>).mock.invocationCallOrder[0]).toBeLessThan(
      jobRepository.encryptFieldsIntoEntity.mock.invocationCallOrder[0],
    );
    expect(jobRepository.encryptFieldsIntoEntity.mock.invocationCallOrder[0]).toBeLessThan(
      jobRepository.update.mock.invocationCallOrder[0],
    );
    expect(res).not.toHaveProperty('encryptedResultText');
    expect(res).not.toHaveProperty('encryptedResultMetadata');
    expect(res).not.toHaveProperty('keyVersion');
  });

  it('still persists the completed job when encryption fails (dual-write soak)', async () => {
    const { service, jobRepository } = buildService(true);
    jobRepository.findById.mockResolvedValue(makeJob());
    jobRepository.encryptFieldsIntoEntity.mockRejectedValueOnce(new Error('vault down'));

    const res = await service.completeJob('job-1', 'transcript text');

    expect(res.id).toBe('job-1');
    expect(jobRepository.update).toHaveBeenCalledTimes(1);
  });

  it('does NOT encrypt when no SecretsService is wired', async () => {
    const { service, jobRepository } = buildService(false);
    jobRepository.findById.mockResolvedValue(makeJob());

    await service.completeJob('job-1', 'transcript text');

    expect(jobRepository.encryptFieldsIntoEntity).not.toHaveBeenCalled();
    expect(jobRepository.update).toHaveBeenCalledTimes(1);
  });
});
