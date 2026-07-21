import { describe, expect, it } from 'vitest';
import {
  GENESIS_PREV_HASH,
  computeHarnessAuditHash,
  verifyHarnessAuditChain,
  toHarnessAuditChainRecord,
  type HarnessAuditChainRecord,
  type HarnessAuditEventLike,
  type HarnessAuditHashInput,
} from './harnessAuditHash';

const baseInput = (): HarnessAuditHashInput => ({
  tenantId: 'tenant-1',
  consultationId: 'consult-1',
  contextItemVersionId: null,
  action: 'GENERATE',
  modelName: 'gpt-x',
  modelVersion: 'v1',
  promptTemplateId: null,
  promptVersion: null,
  sensorScores: { faithfulness: 0.9 },
  citations: [{ id: 'c1' }],
  gateDecision: null,
  clinicianId: null,
  attestationHash: null,
  createdAt: new Date('2026-06-06T00:00:00.000Z'),
  prevHash: GENESIS_PREV_HASH,
});

/** Build a stored chain record (input + its computed hash). */
const record = (input: HarnessAuditHashInput): HarnessAuditChainRecord => ({
  ...input,
  hash: computeHarnessAuditHash(input),
});

describe('computeHarnessAuditHash', () => {
  it('produces a 64-char hex SHA-256 digest', () => {
    const hash = computeHarnessAuditHash(baseInput());
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('is deterministic for identical input', () => {
    expect(computeHarnessAuditHash(baseInput())).toBe(computeHarnessAuditHash(baseInput()));
  });

  it('is stable regardless of JSON key ordering in sensorScores', () => {
    const a = { ...baseInput(), sensorScores: { a: 1, b: 2 } };
    const b = { ...baseInput(), sensorScores: { b: 2, a: 1 } };
    expect(computeHarnessAuditHash(a)).toBe(computeHarnessAuditHash(b));
  });

  it('changes when any canonical field changes', () => {
    const original = computeHarnessAuditHash(baseInput());
    expect(computeHarnessAuditHash({ ...baseInput(), modelName: 'gpt-y' })).not.toBe(original);
    expect(computeHarnessAuditHash({ ...baseInput(), action: 'ATTEST' })).not.toBe(original);
    expect(computeHarnessAuditHash({ ...baseInput(), sensorScores: { faithfulness: 0.1 } })).not.toBe(original);
  });

  it('changes when prevHash changes (chain linkage is part of the digest)', () => {
    const original = computeHarnessAuditHash(baseInput());
    expect(computeHarnessAuditHash({ ...baseInput(), prevHash: 'a'.repeat(64) })).not.toBe(original);
  });
});

describe('verifyHarnessAuditChain', () => {
  it('accepts a correctly linked chain', () => {
    const e1 = record(baseInput());
    const e2 = record({ ...baseInput(), consultationId: 'consult-2', prevHash: e1.hash });
    const result = verifyHarnessAuditChain([e1, e2]);
    expect(result.valid).toBe(true);
    expect(result.brokenAtIndex).toBeNull();
  });

  it('accepts an empty chain', () => {
    expect(verifyHarnessAuditChain([]).valid).toBe(true);
  });

  it('detects a tampered field (stored hash no longer matches recomputed hash)', () => {
    const e1 = record(baseInput());
    const e2 = record({ ...baseInput(), prevHash: e1.hash });
    // Attacker edits the persisted modelName but cannot recompute the hash
    // (the table is append-only / hash is part of the WORM record).
    const tampered: HarnessAuditChainRecord = { ...e2, modelName: 'malicious-model' };
    const result = verifyHarnessAuditChain([e1, tampered]);
    expect(result.valid).toBe(false);
    expect(result.brokenAtIndex).toBe(1);
  });

  it('detects a broken link (prevHash does not match previous hash)', () => {
    const e1 = record(baseInput());
    // e2 links to the wrong previous hash → recompute is self-consistent but
    // the chain linkage is broken (e.g. an event was deleted/spliced out).
    const e2 = record({ ...baseInput(), prevHash: 'f'.repeat(64) });
    const result = verifyHarnessAuditChain([e1, e2]);
    expect(result.valid).toBe(false);
    expect(result.brokenAtIndex).toBe(1);
  });

  it('requires the first event to anchor to the genesis prevHash', () => {
    const e1 = record({ ...baseInput(), prevHash: 'b'.repeat(64) });
    const result = verifyHarnessAuditChain([e1]);
    expect(result.valid).toBe(false);
    expect(result.brokenAtIndex).toBe(0);
  });
});

// =============================================================================
// ENCRYPT-BEFORE-HASH (WORM hash chain over ciphertext)
// =============================================================================

const ct = (s: string): Buffer => Buffer.from(s, 'utf8');

/** A NEW (encrypted) event: ciphertext columns set; plaintext is the sentinel. */
const encInput = (over: Partial<HarnessAuditHashInput> = {}): HarnessAuditHashInput => ({
  ...baseInput(),
  sensorScores: { _encrypted: true },
  citations: { _encrypted: true },
  encryptedSensorScores: ct('vault:v1:scores-ciphertext'),
  encryptedCitations: ct('vault:v1:citations-ciphertext'),
  ...over,
});

describe('computeHarnessAuditHash — encrypt-before-hash', () => {
  it('hashes over the ciphertext, not the plaintext slot, when encrypted* is set', () => {
    // Same ciphertext, DIFFERENT plaintext sentinel → identical hash (proves the
    // digest binds to ciphertext, so the persisted sentinel is irrelevant).
    const a = computeHarnessAuditHash(encInput({ sensorScores: { _encrypted: true } }));
    const b = computeHarnessAuditHash(encInput({ sensorScores: { anything: 'else' }, citations: 'x' }));
    expect(a).toBe(b);
  });

  it('differs from the plaintext-only digest of the same payload', () => {
    const plaintextOnly = computeHarnessAuditHash(baseInput());
    const encrypted = computeHarnessAuditHash(encInput());
    expect(encrypted).not.toBe(plaintextOnly);
  });

  it('changes when the ciphertext changes (tamper-evident over ciphertext)', () => {
    const original = computeHarnessAuditHash(encInput());
    const tampered = computeHarnessAuditHash(encInput({ encryptedSensorScores: ct('vault:v1:TAMPERED') }));
    expect(tampered).not.toBe(original);
  });

  it('is backward-compatible: omitting encrypted* yields the exact pre-3D digest', () => {
    // A legacy/plaintext row (no encrypted* fields) must hash identically to the
    // original algorithm so historical chains keep verifying after the upgrade.
    const legacy = { ...baseInput() };
    delete (legacy as Partial<HarnessAuditHashInput>).encryptedSensorScores;
    delete (legacy as Partial<HarnessAuditHashInput>).encryptedCitations;
    expect(computeHarnessAuditHash(legacy)).toBe(computeHarnessAuditHash(baseInput()));
  });

  it('treats empty/zero-length ciphertext as absent (falls back to plaintext)', () => {
    const withEmpty = computeHarnessAuditHash({
      ...baseInput(),
      encryptedSensorScores: Buffer.alloc(0),
      encryptedCitations: ct(''),
    });
    expect(withEmpty).toBe(computeHarnessAuditHash(baseInput()));
  });
});

describe('verifyHarnessAuditChain — encrypted chains', () => {
  it('(a) verifies a chain of encrypted-payload events end-to-end', () => {
    const e1 = record(encInput());
    const e2 = record(encInput({ consultationId: 'consult-2', prevHash: e1.hash }));
    const e3 = record(encInput({ consultationId: 'consult-3', prevHash: e2.hash }));
    const result = verifyHarnessAuditChain([e1, e2, e3]);
    expect(result.valid).toBe(true);
    expect(result.brokenAtIndex).toBeNull();
  });

  it('verifies a MIXED chain (legacy plaintext rows followed by encrypted rows)', () => {
    const legacy = record(baseInput());
    const encrypted = record(encInput({ consultationId: 'consult-2', prevHash: legacy.hash }));
    expect(verifyHarnessAuditChain([legacy, encrypted]).valid).toBe(true);
  });

  it('(b1) detects tampering with the ciphertext of an encrypted row', () => {
    const e1 = record(encInput());
    const e2 = record(encInput({ consultationId: 'consult-2', prevHash: e1.hash }));
    // Attacker swaps the ciphertext but cannot recompute the WORM hash.
    const tampered: HarnessAuditChainRecord = { ...e2, encryptedSensorScores: ct('vault:v1:EVIL') };
    const result = verifyHarnessAuditChain([e1, tampered]);
    expect(result.valid).toBe(false);
    expect(result.brokenAtIndex).toBe(1);
  });

  it('(b2) detects tampering with the stored hash of an encrypted row', () => {
    const e1 = record(encInput());
    const e2 = record(encInput({ consultationId: 'consult-2', prevHash: e1.hash }));
    const tampered: HarnessAuditChainRecord = { ...e2, hash: 'd'.repeat(64) };
    // e2's hash is also e3.prevHash would-be anchor; a lone bad hash breaks at its own index.
    const result = verifyHarnessAuditChain([e1, tampered]);
    expect(result.valid).toBe(false);
    expect(result.brokenAtIndex).toBe(1);
  });
});

describe('toHarnessAuditChainRecord', () => {
  it('maps a persisted (entity-shaped) encrypted row to a verifiable chain record', () => {
    const input = encInput();
    const stored: HarnessAuditEventLike = { ...input, hash: computeHarnessAuditHash(input) };
    const rec = toHarnessAuditChainRecord(stored);
    // The mapped record carries the ciphertext, so it re-verifies over ciphertext.
    expect(verifyHarnessAuditChain([rec]).valid).toBe(true);
    expect(rec.encryptedSensorScores).toBe(input.encryptedSensorScores);
  });

  it('round-trips a legacy plaintext row (encrypted* default to null)', () => {
    const input = baseInput();
    const stored: HarnessAuditEventLike = { ...input, hash: computeHarnessAuditHash(input) };
    const rec = toHarnessAuditChainRecord(stored);
    expect(rec.encryptedSensorScores).toBeNull();
    expect(verifyHarnessAuditChain([rec]).valid).toBe(true);
  });
});
