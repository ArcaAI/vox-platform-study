/**
 * `attributesJson` allow-list enforcement (TASK-615 WS-B deliverable 5,
 * moved here from WS-G).
 *
 * The usage ledger is the ONE data plane in this platform that must stay
 * provably PHI-free: it is the only plane the billing pipeline reads, and D17
 * keeps that pipeline outside 45 CFR §164.312(b) precisely because no PHI can
 * reach it. `attributesJson` is the only free-shaped column on the row, so it
 * is the only place PHI could get in — and an allow-list is the only control
 * that fails CLOSED against a key nobody thought to forbid.
 */

import { describe, expect, it } from 'vitest';

import { USAGE_ATTRIBUTE_KEYS, validateUsageAttributes } from '../usage-attributes';

describe('validateUsageAttributes — the allow-list', () => {
  it('accepts the declared keys with enum-ish / id / scalar values', () => {
    expect(
      validateUsageAttributes({
        channelCount: 2,
        engine: 'whisper_cpp',
        pipelineId: '018f3c2a-1d3e-7b6a-9c4d-2f1e0a9b8c7d',
        languageMode: 'ml-en',
        serviceTier: 'batch',
        interrupted: true,
        streamKind: 'sse',
        cacheTtl: 'ephemeral_5m',
        endpointKind: 'anthropic.messages',
        contextBand: '128k+',
      }),
    ).toEqual([]);
  });

  it('accepts an absent / empty attribute bag', () => {
    expect(validateUsageAttributes(undefined)).toEqual([]);
    expect(validateUsageAttributes(null)).toEqual([]);
    expect(validateUsageAttributes({})).toEqual([]);
  });

  it('REJECTS a key that is not on the allow-list', () => {
    // The failing case that gives the allow-list its reason to exist: an
    // emitter reaches for a convenient extra field and PHI rides along.
    const violations = validateUsageAttributes({ chiefComplaint: 'chest pain radiating to left arm' });
    expect(violations).toHaveLength(1);
    expect(violations[0]).toMatch(/chiefComplaint/);
    expect(violations[0]).toMatch(/not allow-listed/i);
  });

  it('REJECTS free text even under an allow-listed key', () => {
    // A prose value is PHI-shaped regardless of which key carries it. Allowed
    // string values are enum members and opaque ids: no spaces, no punctuation
    // beyond `. _ -`, bounded length.
    const violations = validateUsageAttributes({ engine: 'patient reports chest pain' });
    expect(violations).toHaveLength(1);
    expect(violations[0]).toMatch(/engine/);
    expect(violations[0]).toMatch(/enum-ish|scalar|value/i);
  });

  it('REJECTS an over-long string even without spaces', () => {
    const violations = validateUsageAttributes({ pipelineId: 'a'.repeat(65) });
    expect(violations).toHaveLength(1);
    expect(violations[0]).toMatch(/pipelineId/);
  });

  it('REJECTS nested objects and arrays — a blob can hide anything', () => {
    expect(validateUsageAttributes({ engine: { name: 'whisper' } })).toHaveLength(1);
    expect(validateUsageAttributes({ engine: ['whisper'] })).toHaveLength(1);
  });

  it('REJECTS a non-finite or non-integer number', () => {
    expect(validateUsageAttributes({ channelCount: Number.NaN })).toHaveLength(1);
    expect(validateUsageAttributes({ channelCount: Number.POSITIVE_INFINITY })).toHaveLength(1);
    expect(validateUsageAttributes({ channelCount: 1.5 })).toHaveLength(1);
  });

  it('REJECTS a value whose type does not match the declared type of the key', () => {
    // `interrupted` is a flag; a string "true" would silently become truthy.
    expect(validateUsageAttributes({ interrupted: 'true' })).toHaveLength(1);
    expect(validateUsageAttributes({ channelCount: '2' })).toHaveLength(1);
  });

  it('REJECTS the attribute bag itself when it is not a plain object', () => {
    expect(validateUsageAttributes('engine=whisper')).toHaveLength(1);
    expect(validateUsageAttributes([{ engine: 'whisper' }])).toHaveLength(1);
  });

  it('reports EVERY violation, not just the first — an emitter fixes them in one pass', () => {
    expect(validateUsageAttributes({ noteText: 'x', channelCount: 'two' })).toHaveLength(2);
  });

  it('permits an explicit null value for an allow-listed key (absent, not free text)', () => {
    expect(validateUsageAttributes({ engine: null })).toEqual([]);
  });

  it('declares its allow-list as data so WS-G and the contract doc read the same list', () => {
    expect(Object.keys(USAGE_ATTRIBUTE_KEYS).sort()).toEqual(
      ['cacheTtl', 'channelCount', 'contextBand', 'endpointKind', 'engine', 'interrupted', 'languageMode', 'pipelineId', 'serviceTier', 'streamKind'].sort(),
    );
  });
});
