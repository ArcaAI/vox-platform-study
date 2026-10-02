/**
 * TASK-1034 §4b "Capture" — every edit / sign-off of a generated summary becomes a DNA memory
 * sample for the consultation's clinician, encrypted, gated on the effective DNA decision, and
 * never able to fail the clinical action that triggered it.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DnaSampleSource } from '@arcaai/domains';
import { DnaMemoryCaptureService } from '../dna-memory-capture.service';
import { DnaMemoryStore } from '../dna-memory.store';

const TENANT = 'tenant-1';
const DOCTOR = 'doctor-1';
const PLAINTEXT = 'Patient reports chest pain, ECG normal.';

const sampleRepo = {
  findByContentHash: vi.fn(),
  create: vi.fn(async (e: unknown) => e),
  encryptText: vi.fn(async (_s: unknown, text: string) => ({ ciphertext: Buffer.from(`vault:v1:${Buffer.from(text).toString('base64')}`), keyVersion: 1 })),
};
const consultationRepo = { findById: vi.fn() };
const contextItemRepo = { findById: vi.fn() };
const versionRepo = { getVersionsByChangeReason: vi.fn() };
const configResolver = { resolveEffectiveDnaStyleEnabled: vi.fn() };
const secrets = { encrypt: vi.fn(), decrypt: vi.fn() };

function make(): DnaMemoryCaptureService {
  const store = new DnaMemoryStore(sampleRepo as never, secrets as never);
  return new DnaMemoryCaptureService(consultationRepo as never, contextItemRepo as never, versionRepo as never, store, configResolver as never);
}

beforeEach(() => {
  vi.clearAllMocks();
  sampleRepo.findByContentHash.mockResolvedValue(null);
  consultationRepo.findById.mockResolvedValue({ id: 'c-1', tenantId: TENANT, doctorId: DOCTOR });
  contextItemRepo.findById.mockResolvedValue({ id: 'ci-1', tenantId: TENANT, consultationId: 'c-1', content: PLAINTEXT });
  versionRepo.getVersionsByChangeReason.mockResolvedValue([{ content: 'AI draft text' }]);
  configResolver.resolveEffectiveDnaStyleEnabled.mockResolvedValue({ effective: true });
});

describe('DnaMemoryCaptureService.capture', () => {
  it('writes one sample for Consultation.doctorId holding ciphertext, never the plaintext', async () => {
    const outcome = await make().capture({ tenantId: TENANT, consultationId: 'c-1', contextItemId: 'ci-1', source: DnaSampleSource.SIGNOFF });

    expect(outcome).toBe('stored');
    expect(sampleRepo.create).toHaveBeenCalledTimes(1);
    const entity = sampleRepo.create.mock.calls[0]![0] as Record<string, unknown>;
    expect(entity.doctorId).toBe(DOCTOR);
    expect(entity.tenantId).toBe(TENANT);
    expect(entity.source).toBe(DnaSampleSource.SIGNOFF);
    expect(entity.consultationId).toBe('c-1');
    expect(entity.contextItemId).toBe('ci-1');
    const ct = (entity.textCiphertext as Buffer).toString('utf8');
    expect(ct.startsWith('vault:v1:')).toBe(true);
    expect(ct).not.toContain(PLAINTEXT);
    expect(entity.aiDraftCiphertext).toBeInstanceOf(Buffer);
    expect(JSON.stringify(entity)).not.toContain(PLAINTEXT);
    expect(entity.contentHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('respects the opt-out: nothing is written when the effective DNA decision is off', async () => {
    configResolver.resolveEffectiveDnaStyleEnabled.mockResolvedValue({ effective: false });
    const outcome = await make().capture({ tenantId: TENANT, consultationId: 'c-1', contextItemId: 'ci-1', source: DnaSampleSource.EDIT });
    expect(outcome).toBe('skipped');
    expect(sampleRepo.create).not.toHaveBeenCalled();
  });

  it('dedupes on the normalised-text hash', async () => {
    sampleRepo.findByContentHash.mockResolvedValue({ id: 'existing' });
    const outcome = await make().capture({ tenantId: TENANT, consultationId: 'c-1', contextItemId: 'ci-1', source: DnaSampleSource.EDIT });
    expect(outcome).toBe('duplicate');
    expect(sampleRepo.create).not.toHaveBeenCalled();
  });

  it('swallows its own errors — capture can never fail the clinical action', async () => {
    sampleRepo.create.mockRejectedValueOnce(new Error('db down'));
    await expect(make().capture({ tenantId: TENANT, consultationId: 'c-1', contextItemId: 'ci-1', source: DnaSampleSource.EDIT })).resolves.toBe('failed');
    configResolver.resolveEffectiveDnaStyleEnabled.mockRejectedValueOnce(new Error('resolver down'));
    await expect(make().capture({ tenantId: TENANT, consultationId: 'c-1', contextItemId: 'ci-1', source: DnaSampleSource.EDIT })).resolves.toBe('failed');
  });

  it('the event handler never throws', async () => {
    consultationRepo.findById.mockRejectedValue(new Error('boom'));
    await expect(make().onCaptureRequested({ tenantId: TENANT, consultationId: 'c-1', contextItemId: 'ci-1', source: DnaSampleSource.EDIT })).resolves.toBeUndefined();
  });
});
