import { describe, expect, it } from 'vitest';
import { deriveSpeakerLabel } from '../speaker-label';

/**
 * The SINGLE canonical `speaker_id` → display-label
 * derivation. Lives server-side in the applications layer and is called ONCE
 * by the streaming bridge; every downstream consumer reads the resulting
 * `speakerLabel` off the wire instead of re-deriving its own.
 *
 * Label semantics: the streaming diarizer emits only anonymous ids
 * (`"Speaker 0"`, `"Speaker 1"`) and the `"unknown"` sentinel — NEVER a raw
 * clinician/patient name (name preseed is PHI-gated and off here). The
 * mapping therefore only ever produces anonymous / neutral labels.
 */
describe('deriveSpeakerLabel (canonical mapping)', () => {
  it('returns undefined for a missing / empty / whitespace id (no speaker → no label)', () => {
    expect(deriveSpeakerLabel(undefined)).toBeUndefined();
    expect(deriveSpeakerLabel(null)).toBeUndefined();
    expect(deriveSpeakerLabel('')).toBeUndefined();
    expect(deriveSpeakerLabel('   ')).toBeUndefined();
  });

  it('maps the stt-v2 "unknown" sentinel to a neutral placeholder (never the raw magic string)', () => {
    // inference.py stamps speaker_id="unknown" when diarization ran but found
    // no confident match; the clinician must not see the raw sentinel.
    expect(deriveSpeakerLabel('unknown')).toBe('Unknown speaker');
    expect(deriveSpeakerLabel('UNKNOWN')).toBe('Unknown speaker');
    expect(deriveSpeakerLabel('  unknown  ')).toBe('Unknown speaker');
  });

  it('passes anonymous diarizer ids through verbatim ("Speaker N" is already human-readable)', () => {
    // speaker_tracker.py assigns f"Speaker {N}" — surface it as-is; role
    // labels and preseeded names enrich this seam later.
    expect(deriveSpeakerLabel('Speaker 0')).toBe('Speaker 0');
    expect(deriveSpeakerLabel('Speaker 1')).toBe('Speaker 1');
    expect(deriveSpeakerLabel('  Speaker 2  ')).toBe('Speaker 2');
  });
});
