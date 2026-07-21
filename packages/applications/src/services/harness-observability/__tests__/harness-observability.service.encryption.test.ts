/**
 * HarnessObservabilityService — WORM encrypted-payload read paths.
 *
 *  - the integrity verdict over a chain of ENCRYPTED events is valid, because
 *    `verifyChainEntities` maps via `toHarnessAuditChainRecord` and hashes over
 *    the ciphertext (the same representation the writer hashed) — NOT the
 *    persisted redaction sentinel.
 *  - `listAuditEvents` decrypts `sensorScores`/`citations` for display when a
 *    SecretsService is wired, surfacing the real payload instead of the sentinel.
 *  - decrypt is best-effort: a failure (or no SecretsService) falls back to the
 *    persisted (sentinel) value and the verdict is unaffected.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { GENESIS_PREV_HASH, HarnessAuditAction, HarnessAuditEventFactory } from '@arcaai/domains';
import { HarnessObservabilityService } from '../harness-observability.service';

const TENANT = 'tenant-1';
const VAULT_PREFIX = 'vault:v1:';

const encJson = (value: unknown): Buffer | null =>
  value === null || value === undefined ? null : Buffer.from(VAULT_PREFIX + Buffer.from(JSON.stringify(value), 'utf8').toString('base64'), 'utf8');

const decJson = (buf: Buffer | Uint8Array | null | undefined): unknown => {
  if (!buf || buf.length === 0) return null;
  const s = Buffer.from(buf).toString('utf8');
  return JSON.parse(Buffer.from(s.slice(VAULT_PREFIX.length), 'base64').toString('utf8'));
};

const auditRepository = { getChainForTenant: vi.fn(), decryptPayloadsFromEntity: vi.fn() };
const evalRunRepository = { count: vi.fn(), findAll: vi.fn() };
const evalScoreRepository = { getByEvalRun: vi.fn() };
const consultationRepository = { findPendingReviewForTenant: vi.fn() };
const policyRepository = { findActiveForTenant: vi.fn() };
const secretsService = { encrypt: vi.fn(), decrypt: vi.fn() } as any;

/** A SecretsService-backed instance (decrypt-on-read enabled). */
function makeServiceWithSecrets(): HarnessObservabilityService {
  return new HarnessObservabilityService(
    auditRepository as never,
    evalRunRepository as never,
    evalScoreRepository as never,
    consultationRepository as never,
    policyRepository as never,
    secretsService,
  );
}

/** No-secrets instance (display shows the persisted sentinel). */
function makeServiceNoSecrets(): HarnessObservabilityService {
  return new HarnessObservabilityService(
    auditRepository as never,
    evalRunRepository as never,
    evalScoreRepository as never,
    consultationRepository as never,
    policyRepository as never,
  );
}

const SCORES = { faithfulness: 0.92 };
const CITES = [{ id: 'pmid:1', span: [0, 4] }];

/** A NEW (encrypted) event: ciphertext set; plaintext columns hold the sentinel. */
function encEvent(consultationId: string, prevHash: string) {
  return HarnessAuditEventFactory.CreateHarnessAuditEvent({
    tenantId: TENANT,
    consultationId,
    action: HarnessAuditAction.GENERATE,
    modelName: 'gpt',
    modelVersion: '1',
    sensorScores: SCORES,
    citations: CITES,
    encryptedSensorScores: encJson(SCORES),
    encryptedCitations: encJson(CITES),
    keyVersion: 1,
    prevHash,
  });
}

function buildEncryptedChain() {
  const e1 = encEvent('c1', GENESIS_PREV_HASH);
  const e2 = encEvent('c2', e1.hash);
  const e3 = encEvent('c3', e2.hash);
  return [e1, e2, e3];
}

describe('HarnessObservabilityService — encrypted WORM payloads', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    auditRepository.decryptPayloadsFromEntity.mockImplementation(async (e: any) => ({
      sensorScores: decJson(e.encryptedSensorScores) ?? e.sensorScores ?? null,
      citations: decJson(e.encryptedCitations) ?? e.citations ?? null,
    }));
  });

  it('reports a VALID verdict over a fully-encrypted chain (hashes over ciphertext)', async () => {
    const chain = buildEncryptedChain();
    auditRepository.getChainForTenant.mockResolvedValue(chain);

    const result = await makeServiceNoSecrets().listAuditEvents(TENANT);

    expect(result.verification.valid).toBe(true);
    expect(result.verification.brokenAtIndex).toBeNull();
    expect(result.total).toBe(3);
  });

  it('verifyChain is valid for an encrypted chain', async () => {
    auditRepository.getChainForTenant.mockResolvedValue(buildEncryptedChain());
    const verdict = await makeServiceWithSecrets().verifyChain(TENANT);
    expect(verdict.valid).toBe(true);
  });

  it('decrypts sensorScores/citations for display when a SecretsService is wired', async () => {
    const chain = buildEncryptedChain();
    auditRepository.getChainForTenant.mockResolvedValue(chain);

    const result = await makeServiceWithSecrets().listAuditEvents(TENANT, { consultationId: 'c1' });

    expect(result.items).toHaveLength(1);
    // Display surfaces the REAL payload, not the persisted `{ _encrypted: true }`.
    expect(result.items[0].sensorScores).toEqual(SCORES);
    expect(result.items[0].citations).toEqual(CITES);
    expect(auditRepository.decryptPayloadsFromEntity).toHaveBeenCalledTimes(1);
  });

  it('shows the redaction sentinel when no SecretsService is available', async () => {
    auditRepository.getChainForTenant.mockResolvedValue([encEvent('c1', GENESIS_PREV_HASH)]);

    const result = await makeServiceNoSecrets().listAuditEvents(TENANT);

    expect(result.items[0].sensorScores).toEqual({ _encrypted: true });
    expect(auditRepository.decryptPayloadsFromEntity).not.toHaveBeenCalled();
  });

  it('falls back to the sentinel (best-effort) when decryption fails, verdict unaffected', async () => {
    auditRepository.getChainForTenant.mockResolvedValue([encEvent('c1', GENESIS_PREV_HASH)]);
    auditRepository.decryptPayloadsFromEntity.mockRejectedValueOnce(new Error('vault down'));

    const result = await makeServiceWithSecrets().listAuditEvents(TENANT);

    expect(result.items[0].sensorScores).toEqual({ _encrypted: true });
    expect(result.verification.valid).toBe(true);
  });
});
