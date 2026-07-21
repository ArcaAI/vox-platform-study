/**
 * HarnessAuditService — ENCRYPT-BEFORE-HASH wiring.
 *
 * Proves the service-level wiring of the WORM hash chain over ciphertext:
 *  - `append` encrypts `sensorScores`/`citations` via the repo's `encryptPayloads`
 *    BEFORE building the event, so the factory derives `hash` over the CIPHERTEXT
 *    and stores a redaction sentinel in the plaintext JSONB.
 *  - a chain of encrypted-payload events verifies end-to-end through the service
 *    (the verifier maps via `toHarnessAuditChainRecord`, hashing the SAME bytes).
 *  - tampering with the ciphertext or the stored hash is detected.
 *  - the append is best-effort: a Vault failure (or no SecretsService) falls back
 *    to a plaintext row (hash over plaintext) and never fails the clinical write.
 *
 * The repository is mocked; its `encryptPayloads` mirrors the real sibling
 * (ciphertext = utf8 bytes of `vault:v1:<base64(json)>`), so the real domain
 * factory + hash helper run against realistic ciphertext.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { GENESIS_PREV_HASH, HarnessAuditAction, computeHarnessAuditHash, toHarnessAuditChainRecord } from '@arcaai/domains';
import { HarnessAuditService } from '../harness-audit.service';

const VAULT_PREFIX = 'vault:v1:';

/** Fake Vault-Transit encode: a reversible `vault:v1:<base64(json)>` Buffer. */
const encJson = (value: unknown): Buffer | null =>
  value === null || value === undefined ? null : Buffer.from(VAULT_PREFIX + Buffer.from(JSON.stringify(value), 'utf8').toString('base64'), 'utf8');

/** Reverse {@link encJson} for the decrypt-on-read path. */
const decJson = (buf: Buffer | Uint8Array | null | undefined): unknown => {
  if (!buf || buf.length === 0) return null;
  const s = Buffer.from(buf).toString('utf8');
  return JSON.parse(Buffer.from(s.slice(VAULT_PREFIX.length), 'base64').toString('utf8'));
};

const mockRepository = {
  create: vi.fn(async (entity) => entity),
  getLatestForTenant: vi.fn(),
  getChainForTenant: vi.fn(),
  encryptPayloads: vi.fn(async (_secrets: unknown, sensorScores: unknown, citations: unknown) => ({
    encryptedSensorScores: encJson(sensorScores),
    encryptedCitations: encJson(citations),
    keyVersion: 1,
  })),
  decryptPayloadsFromEntity: vi.fn(async (entity: any, _secrets: unknown) => ({
    sensorScores: decJson(entity.encryptedSensorScores) ?? entity.sensorScores ?? null,
    citations: decJson(entity.encryptedCitations) ?? entity.citations ?? null,
  })),
};

// A SecretsService stand-in; encryptPayloads is mocked above so its methods are
// never actually invoked, but identity is asserted on the encrypt call.
const fakeSecrets = { encrypt: vi.fn(), decrypt: vi.fn() } as any;

const baseInput = () => ({
  tenantId: 'tenant-1',
  consultationId: 'consult-1',
  action: HarnessAuditAction.GENERATE,
  modelName: 'gpt-x',
  modelVersion: 'v1',
  sensorScores: { faithfulness: 0.9 },
  citations: [{ id: 'c1' }],
});

describe('HarnessAuditService — encrypt-before-hash', () => {
  let service: HarnessAuditService;

  beforeEach(() => {
    vi.clearAllMocks();
    service = new HarnessAuditService(mockRepository as any, fakeSecrets);
  });

  describe('append (SecretsService wired)', () => {
    it('encrypts the payloads and binds the hash to the ciphertext', async () => {
      mockRepository.getLatestForTenant.mockResolvedValue(null);

      const event = await service.append(baseInput());

      expect(mockRepository.encryptPayloads).toHaveBeenCalledWith(fakeSecrets, baseInput().sensorScores, baseInput().citations);
      // Ciphertext persisted to the additive Bytes columns…
      expect(Buffer.isBuffer(event.encryptedSensorScores)).toBe(true);
      expect(Buffer.isBuffer(event.encryptedCitations)).toBe(true);
      expect(event.keyVersion).toBe(1);
      // …and the plaintext JSONB holds only the non-PHI redaction sentinel.
      expect(event.sensorScores).toEqual({ _encrypted: true });
      expect(event.citations).toEqual({ _encrypted: true });
      // The stored hash is the hash OVER CIPHERTEXT (recompute via the shared map).
      expect(computeHarnessAuditHash(toHarnessAuditChainRecord(event as any))).toBe(event.hash);
    });

    it('verifies a 3-event encrypted chain end-to-end through the service', async () => {
      mockRepository.getLatestForTenant.mockResolvedValueOnce(null);
      const e1 = await service.append(baseInput());
      mockRepository.getLatestForTenant.mockResolvedValueOnce(e1);
      const e2 = await service.append({ ...baseInput(), consultationId: 'consult-2', action: HarnessAuditAction.ATTEST });
      mockRepository.getLatestForTenant.mockResolvedValueOnce(e2);
      const e3 = await service.append({ ...baseInput(), consultationId: 'consult-3' });

      expect(e2.prevHash).toBe(e1.hash);
      expect(e3.prevHash).toBe(e2.hash);

      mockRepository.getChainForTenant.mockResolvedValue([e1, e2, e3]);
      const result = await service.verifyChain('tenant-1');

      expect(result.valid).toBe(true);
      expect(result.brokenAtIndex).toBeNull();
    });

    it('detects tampering with the ciphertext of an encrypted row', async () => {
      mockRepository.getLatestForTenant.mockResolvedValueOnce(null);
      const e1 = await service.append(baseInput());
      mockRepository.getLatestForTenant.mockResolvedValueOnce(e1);
      const e2 = await service.append({ ...baseInput(), consultationId: 'consult-2' });

      // Persisted ciphertext swapped, but the WORM hash cannot be recomputed.
      const tampered = { ...toHarnessAuditChainRecord(e2 as any), encryptedSensorScores: encJson({ evil: true }) };
      mockRepository.getChainForTenant.mockResolvedValue([e1, tampered]);

      const result = await service.verifyChain('tenant-1');

      expect(result.valid).toBe(false);
      expect(result.brokenAtIndex).toBe(1);
    });

    it('detects tampering with the stored hash of an encrypted row', async () => {
      mockRepository.getLatestForTenant.mockResolvedValueOnce(null);
      const e1 = await service.append(baseInput());
      mockRepository.getLatestForTenant.mockResolvedValueOnce(e1);
      const e2 = await service.append({ ...baseInput(), consultationId: 'consult-2' });

      const tampered = { ...toHarnessAuditChainRecord(e2 as any), hash: 'd'.repeat(64) };
      mockRepository.getChainForTenant.mockResolvedValue([e1, tampered]);

      const result = await service.verifyChain('tenant-1');

      expect(result.valid).toBe(false);
      expect(result.brokenAtIndex).toBe(1);
    });
  });

  describe('append (best-effort fallback)', () => {
    it('falls back to a plaintext row (hash over plaintext) when encryption throws', async () => {
      mockRepository.getLatestForTenant.mockResolvedValue(null);
      mockRepository.encryptPayloads.mockRejectedValueOnce(new Error('vault unreachable'));

      const event = await service.append(baseInput());

      // The clinical append must NOT fail closed.
      expect(mockRepository.create).toHaveBeenCalledTimes(1);
      // No ciphertext; the real PHI stays in the plaintext column (legacy shape).
      expect(event.encryptedSensorScores ?? null).toBeNull();
      expect(event.keyVersion ?? null).toBeNull();
      expect(event.sensorScores).toEqual(baseInput().sensorScores);
      // The hash is over the plaintext and still self-consistent.
      mockRepository.getChainForTenant.mockResolvedValue([event]);
      expect((await service.verifyChain('tenant-1')).valid).toBe(true);
    });

    it('writes plaintext when no SecretsService is injected', async () => {
      const plaintextService = new HarnessAuditService(mockRepository as any);
      mockRepository.getLatestForTenant.mockResolvedValue(null);

      const event = await plaintextService.append(baseInput());

      expect(mockRepository.encryptPayloads).not.toHaveBeenCalled();
      expect(event.encryptedSensorScores ?? null).toBeNull();
      expect(event.sensorScores).toEqual(baseInput().sensorScores);
      expect(event.prevHash).toBe(GENESIS_PREV_HASH);
    });
  });
});
