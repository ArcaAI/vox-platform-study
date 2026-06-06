import { describe, expect, it } from 'vitest';
import {
  GENESIS_PREV_HASH,
  computeHarnessAuditHash,
  verifyHarnessAuditChain,
  type HarnessAuditChainRecord,
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
