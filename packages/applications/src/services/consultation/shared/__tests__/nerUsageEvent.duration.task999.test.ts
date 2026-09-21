/**
 * TASK-999 (D-2(c)) — NER duration is recorded ONCE, on the `ner.extract` ledger row.
 *
 * ============================================================================
 * WHY THE OBVIOUS PLACE IS THE WRONG PLACE
 * ============================================================================
 * `NamedEntity.processingTimeMs` looks like the duration column, and it is not one. It is
 * stamped IDENTICALLY on every entity a single call produced, so `SUM(processingTimeMs)` over a
 * consultation multiplies one call's duration by its entity count — a 400 ms extraction that
 * found twelve entities reads as 4.8 seconds. And the main clinical path
 * (`SummaryService.extractEntities`) never set it at all, so the number it double-counts did not
 * even exist there.
 *
 * The fix is to use the mechanism the ledger ALREADY has for timing rather than to add a second
 * duration anywhere: `appendComputeAndByteUnits` turns a measured reading into exactly one
 * `CPU_SECOND`/`GPU_SECOND` row on the same event. One call, one row, summable by definition.
 *
 * `NamedEntity.processingTimeMs` is deliberately left in place (back-compat for anything still
 * reading it) and is deliberately not written by these paths.
 */
import { describe, expect, it } from 'vitest';
import { AiUsageUnit } from '@arcaai/domains';

import { buildNerUsageEvent, nerDevice, nerInferenceMs } from '../nerUsageEvent';
import { namedEntityPropsFromNlp } from '../namedEntityFromNlp';

const base = { tenantId: 't1', requestId: 'req-999', charCount: 250, model: 'medical-ner' };
const computeRows = (event: ReturnType<typeof buildNerUsageEvent>) =>
  event.units.filter((line) => line.unit === AiUsageUnit.CPU_SECOND || line.unit === AiUsageUnit.GPU_SECOND);

describe('ner.extract — one duration per CALL (TASK-999)', () => {
  it('records the caller’s wall clock when apps/nlp reported no inference time of its own', () => {
    // RED before the change: `totalMs` did not exist on the params, so the clinical
    // `extractEntities` hop — which passes no timing at all today — could not put a duration on
    // its row however carefully it measured one.
    const event = buildNerUsageEvent({ ...base, totalMs: 812, device: 'cpu' });

    expect(computeRows(event)).toEqual([{ unit: AiUsageUnit.CPU_SECOND, quantity: '0.812', attributesJson: { device: 'cpu' } }]);
  });

  it('prefers the engine’s own reading over the caller’s wall clock', () => {
    // The wall clock includes the HTTP hop; `inference_ms` is the forward pass. One call is
    // timed once, by whoever timed it best.
    const event = buildNerUsageEvent({ ...base, inferenceMs: 420, totalMs: 812, device: 'cuda' });

    expect(computeRows(event)).toEqual([{ unit: AiUsageUnit.GPU_SECOND, quantity: '0.420', attributesJson: { device: 'cuda' } }]);
  });

  it('records EXACTLY ONE compute row per call — the duration is a property of the call, not of its entities', () => {
    // This is the anti-double-count assertion. However many entities a call produced, the row
    // count is one, so a SUM over the ledger is a sum of call durations.
    const event = buildNerUsageEvent({ ...base, totalMs: 500, device: 'cpu' });

    expect(computeRows(event)).toHaveLength(1);
  });

  it('writes NO per-entity processingTimeMs — the column stays for back-compat and is not the source', () => {
    // The shared NLP → NamedEntity mapping both clinical paths use must not reintroduce the
    // per-entity stamp that made `SUM(processingTimeMs)` wrong in the first place.
    const props = namedEntityPropsFromNlp(
      { text: 'aspirin', entity_type: 'MEDICATION', position: { start: 4, end: 11 } },
      { tenantId: 't1', contextItemId: 'ctx-1' },
    );

    expect(props).not.toHaveProperty('processingTimeMs');
  });

  it('reads the two NLP wire fields defensively — an unmeasured or misspelled value records nothing', () => {
    expect(nerInferenceMs(420)).toBe(420);
    expect(nerInferenceMs('420')).toBe(420);
    // Not measured, not "measured and free": a zero-second row would read as a real reading.
    expect(nerInferenceMs(0)).toBeNull();
    expect(nerInferenceMs(undefined)).toBeNull();
    expect(nerInferenceMs('soon')).toBeNull();

    expect(nerDevice('cuda')).toBe('cuda');
    expect(nerDevice('mps')).toBe('mps');
    // A near-miss must never be coerced: GPU seconds are priced an order of magnitude above CPU.
    expect(nerDevice('gpu')).toBeNull();
    expect(nerDevice(null)).toBeNull();
  });

  it('leaves a caller that passes neither reading exactly as it was', () => {
    // The two pre-existing call sites (agent NER route, playground bench) pass `inferenceMs`
    // only; a call site that passes nothing still records characters and no compute.
    expect(computeRows(buildNerUsageEvent(base))).toEqual([]);
    expect(computeRows(buildNerUsageEvent({ ...base, inferenceMs: 420 }))).toEqual([]);
  });
});
