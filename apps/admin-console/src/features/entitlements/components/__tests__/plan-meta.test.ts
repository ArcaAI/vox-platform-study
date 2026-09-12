/**
 * The plan form's section split. `LIMIT_GROUPS` is derived from
 * `LIMIT_FIELDS`, so what is worth pinning is the partition itself and the
 * membership the gateway dictates — not the rendering, which the screen test
 * covers.
 */

import { describe, expect, it } from 'vitest';
import { LIMIT_FIELDS, LIMIT_GROUPS } from '../plan-meta';

/**
 * `MeterCapabilityKey` in
 * `packages/applications/src/services/entitlements/enforcement.ts`. The console
 * cannot import it (that package is server-side), so it is restated here and
 * this test is what keeps the copy honest.
 */
const METER_CAPABILITY_KEYS = [
  'monthlyConsultations',
  'monthlyTranscriptionMinutes',
  'monthlySummaries',
  'monthlyWorkflowInvocations',
  'monthlySttSessionSeconds',
  'monthlyLlmTokens',
  'monthlyTtsCharacters',
  'monthlyNlpTextUnits',
  'monthlyEmbeddingTokens',
];

describe('LIMIT_GROUPS', () => {
  it('partitions every limit exactly once, so the form can never drop one', () => {
    const grouped = LIMIT_GROUPS.flatMap((group) => group.fields.map((field) => field.key));

    expect([...grouped].sort()).toEqual(LIMIT_FIELDS.map((field) => field.key).sort());
    expect(new Set(grouped).size).toBe(grouped.length);
  });

  it('puts exactly the gateway meter capabilities under Monthly meters', () => {
    const meters = LIMIT_GROUPS.find((group) => group.id === 'meter');

    expect(meters?.title).toBe('Monthly meters');
    expect(meters?.fields.map((field) => field.key).sort()).toEqual([...METER_CAPABILITY_KEYS].sort());
  });

  it('keeps every remaining limit — storage and the max* ceilings — as a quantity', () => {
    const quantities = LIMIT_GROUPS.find((group) => group.id === 'quantity');

    expect(quantities?.title).toBe('Quantity ceilings');
    expect(quantities?.fields.map((field) => field.key)).toContain('storageQuotaBytes');
    expect(quantities?.fields.every((field) => !METER_CAPABILITY_KEYS.includes(field.key))).toBe(true);
  });
});
