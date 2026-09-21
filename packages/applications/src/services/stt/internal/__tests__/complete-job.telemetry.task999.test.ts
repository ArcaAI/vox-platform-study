/**
 * TASK-999 — what a BATCH completion records about itself.
 *
 * Three things the completion callback threw away:
 *   - the transcript's word count, computed at the `TranscriptionCreated` emit
 *     and then discarded (and no char count at all), while the text itself
 *     became Vault-Transit ciphertext two lines later;
 *   - WHICH entry of the job's own `resolvedSpec` chain served — only the engine
 *     name reached the ledger, and an engine name cannot tell a primary from a
 *     fallback sharing its provider;
 *   - the ASR model, which the `transcribe.batch` usage row stamped as a
 *     hardcoded `null`.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SttInternalService } from '../sttInternal.service';

/* eslint-disable @typescript-eslint/no-explicit-any */
const spec = (): any => ({
  runtimeKey: 'agent-v1',
  agent: { slug: 'batch-consult', versionId: 'agent-version-1', versionNumber: 1, tenantId: 'tenant-1', source: 'tenant' },
  models: { asr: { role: 'asr', slug: 'whisper-large-v3', taskType: 'SPEECH_TO_TEXT', format: 'GGUF', provider: null, libraryName: 'faster-whisper' } },
  fallback: {
    kind: 'model',
    autoSwitch: true,
    switchAfterConsecutiveFailures: 3,
    chain: [
      {
        runtimeKey: 'agent-v1:fb',
        agent: { slug: 'cloud-fallback', versionId: 'agent-version-2', versionNumber: 1, tenantId: 'tenant-1', source: 'tenant' },
        models: { asr: { role: 'asr', slug: 'sarvam-saarika-v2', taskType: 'SPEECH_TO_TEXT', format: 'API', provider: 'sarvam' } },
      },
    ],
    spec: null,
  },
});

function makeJob(overrides: Record<string, any> = {}) {
  const job: Record<string, any> = {
    id: 'job-1',
    tenantId: 'tenant-1',
    consultationId: 'consult-1',
    agentVersionId: 'agent-version-1',
    resolvedSpec: spec(),
    status: 'PROCESSING',
    version: 3,
    completedAt: null,
    resultText: null,
    resultMetadata: null,
    resultWordCount: null,
    resultCharCount: null,
    servedBy: null,
    createdBy: 'user-1',
    ...overrides,
  };
  job.complete = vi.fn((text: string, meta?: unknown) => {
    job.resultText = text;
    job.resultMetadata = meta ?? null;
    job.status = 'COMPLETED';
    job.completedAt = new Date('2026-09-22T10:05:00Z');
  });
  return job;
}

function buildService() {
  const jobRepository = {
    findById: vi.fn(),
    update: vi.fn(async (_id: string, e: unknown) => e),
    updateWithVersion: vi.fn(async (_id: string, e: unknown) => e),
    encryptFieldsIntoEntity: vi.fn(async () => undefined),
  };
  const eventEmitter = { emit: vi.fn() };
  const clsService = { get: vi.fn((k: string) => (k === 'tenantId' ? 'tenant-1' : k === 'user' ? { id: 'user-1' } : null)) };
  // The ledger emission rides INSIDE the completing transaction, so the unit of
  // work has to actually run its callback for the usage row to be built at all.
  const unitOfWork = { runInTransaction: vi.fn(async (work: any) => work({} as never)) };
  const ledger = { recordUsage: vi.fn().mockResolvedValue({ outboxIds: ['o-1'], events: 1 }) };

  const service = new SttInternalService(
    jobRepository as never,
    {} as never,
    {} as never,
    {} as never,
    eventEmitter as never,
    clsService as never,
    undefined,
    undefined,
    undefined,
    unitOfWork as never,
    ledger as never,
  );
  return { service, jobRepository, ledger };
}

const completion = (overrides: Record<string, unknown> = {}) => ({
  resultText: 'the patient reports intermittent chest pain',
  durationSeconds: 42.5,
  engine: 'faster_whisper',
  deployment: 'SELF_HOSTED',
  ...overrides,
});

describe('TASK-999 — batch completion telemetry', () => {
  beforeEach(() => vi.clearAllMocks());

  it('persists BOTH the word and the character count, measured before the text is encrypted', async () => {
    // RED before the change: the word count existed only as a transient on the
    // pipeline event and there was no char count anywhere — and the plaintext is
    // gone (ciphertext) by the time any admin read could measure it.
    const { service, jobRepository } = buildService();
    const job = makeJob();
    jobRepository.findById.mockResolvedValue(job);

    await service.completeJob('job-1', completion() as never);

    expect(job.resultWordCount).toBe(6);
    expect(job.resultCharCount).toBe('the patient reports intermittent chest pain'.length);
    // Measured BEFORE the ciphertext write, not after.
    expect(jobRepository.encryptFieldsIntoEntity).toHaveBeenCalledTimes(1);
  });

  it('records 0 for a genuinely empty transcript — 0 and "never measured" are different facts', async () => {
    // RED before the change: no counter column existed, so there was no way to
    // tell an empty transcript from one nobody ever measured.
    const { service, jobRepository } = buildService();
    const job = makeJob();
    jobRepository.findById.mockResolvedValue(job);

    await service.completeJob('job-1', completion({ resultText: '' }) as never);

    expect(job.resultWordCount).toBe(0);
    expect(job.resultCharCount).toBe(0);
  });

  it('records the PRIMARY as having served when the worker reports the primary engine', async () => {
    // RED before the change: `servedBy` did not exist on the row.
    const { service, jobRepository } = buildService();
    const job = makeJob();
    jobRepository.findById.mockResolvedValue(job);

    await service.completeJob('job-1', completion({ engine: 'faster_whisper' }) as never);

    expect(job.servedBy).toMatchObject({ chainIndex: -1, source: 'primary', modelSlug: 'whisper-large-v3', agentSlug: 'batch-consult' });
  });

  it('records the FALLBACK and its chain index when a non-primary engine served', async () => {
    // RED before the change: the chain only ever said what COULD run. This is the
    // case D-6 exists for — nothing else distinguishes a failover from a normal run.
    const { service, jobRepository } = buildService();
    const job = makeJob();
    jobRepository.findById.mockResolvedValue(job);

    await service.completeJob('job-1', completion({ engine: 'sarvam', deployment: 'BYOK' }) as never);

    expect(job.servedBy).toMatchObject({ chainIndex: 0, source: 'fallback', modelSlug: 'sarvam-saarika-v2', provider: 'sarvam' });
  });

  it('stamps a NON-NULL model on the transcribe.batch usage row', async () => {
    // RED before the change: `model: null` was a literal on this row, so STT spend
    // could not be attributed to a model on any cost surface.
    const { service, jobRepository, ledger } = buildService();
    jobRepository.findById.mockResolvedValue(makeJob());

    await service.completeJob('job-1', completion() as never);

    expect(ledger.recordUsage).toHaveBeenCalled();
    const common = ledger.recordUsage.mock.calls[0][0].common;
    expect(common.model).toBe('whisper-large-v3');
    // Everything else on this billing-evidence row is untouched.
    expect(common.provider).toBe('faster_whisper');
    expect(common.operation).toBe('transcribe.batch');
  });

  it('leaves the model null rather than guessing when the engine matches no chain entry', async () => {
    const { service, jobRepository, ledger } = buildService();
    jobRepository.findById.mockResolvedValue(makeJob({ resolvedSpec: null }));

    await service.completeJob('job-1', completion() as never);

    expect(ledger.recordUsage.mock.calls[0][0].common.model).toBeNull();
  });
});
