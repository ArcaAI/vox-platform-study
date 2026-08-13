/**
 * @vitest-environment jsdom
 *
 * Metadata-passthrough contract lock for `@arcaai/vox/compat`.
 *
 * Locks the FROZEN round-trip contract so a future v2
 * change that would silently break what a migrated v1 app receives fails CI here.
 * This is the DRIFT GUARD companion to `contract.test.ts` (which locks the hook
 * return SHAPES): this file locks the delivered-metadata VALUES + precedence.
 *
 * Three locks, each with a golden fixture:
 * 1. precedence — enrichments LOWEST, caller OVERRIDES, chunk_id
 *     detected_language overlaid LAST. Regressing the composition order (a caller
 *     key clobbered again — defect F4) fails here.
 * 2. resolution chains — chunk_id (`chunk_id → chunkId → other`) and
 *     detected_language (`detected_language → detectedLanguage → seg.language`).
 *  3. default `transcriptTemplate` = `"{timestamp} {speaker_id}: {text}"`.
 *
 * Pure-helper level (no React) so the contract is asserted at its crux; the
 * hook-level behavior is covered in `useArcaSpeechToText.test.ts`.
 */

import { describe, it, expect } from 'vitest';
import {
  composeDeliveredMetadata,
  resolveChunkId,
  resolveDetectedLanguage,
  resolvePipelineId,
  applyTemplate,
  DEFAULT_TRANSCRIPT_TEMPLATE,
} from '../speechToTextMetadata';
import { COMPOSE_GOLDEN, CHUNK_ID_GOLDEN, DETECTED_LANGUAGE_GOLDEN, PIPELINE_ID_GOLDEN } from './fixtures/metadata-passthrough.golden';

// ===========================================================================
// Lock 1 — delivered-metadata precedence (golden shape match).
// ===========================================================================
describe('delivered-metadata golden shapes', () => {
  it.each(COMPOSE_GOLDEN)('composeDeliveredMetadata: $name', ({ seg, isFinal, callerMeta, expected }) => {
    expect(composeDeliveredMetadata({ seg, isFinal, callerMeta })).toEqual(expected);
  });
});

// ===========================================================================
// Lock 1 (drift guard) — a caller key is NEVER clobbered by hook enrichments.
// If precedence ever reverts to enrichments-last (F4 regression), these fail.
// ===========================================================================
describe('precedence drift guard — caller keys survive enrichments (F4)', () => {
  const seg = { speakerLabel: 'Doctor', confidence: 0.9, language: 'en', startTime: 1, endTime: 2 };

  it('caller speaker_id / confidence / language / isFinal all OVERRIDE the segment', () => {
    const out = composeDeliveredMetadata({
      seg,
      isFinal: true,
      callerMeta: { speaker_id: 'app-x', confidence: 0.1, language: 'ml', isFinal: 'sentinel' },
    });
    expect(out.speaker_id).toBe('app-x');
    expect(out.confidence).toBe(0.1);
    expect(out.language).toBe('ml'); // closes the prior coverage gap on caller-language override
    expect(out.isFinal).toBe('sentinel');
  });

  it('enrichments only FILL keys the caller did not set', () => {
    const out = composeDeliveredMetadata({ seg, isFinal: true, callerMeta: { role: 'clinician' } });
    expect(out.role).toBe('clinician');
    expect(out.speaker_id).toBe('Doctor'); // unset by caller → filled from diarization
    expect(out.startTime).toBe(1);
  });

  it('chunk_id / detected_language are the LAST overlay (highest precedence)', () => {
    const out = composeDeliveredMetadata({
      seg,
      isFinal: true,
      // caller supplies a conflicting `detected_language`; the overlay must be the one delivered.
      callerMeta: { chunk_id: 'c1', detected_language: 'ta' },
    });
    const keys = Object.keys(out);
    // Overlay-last: both canonical keys must be present and positioned after the enrichment block.
    expect(out.chunk_id).toBe('c1');
    expect(out.detected_language).toBe('ta');
    expect(keys.indexOf('chunk_id')).toBeGreaterThan(keys.indexOf('speaker_id'));
    expect(keys.indexOf('detected_language')).toBeGreaterThan(keys.indexOf('speaker_id'));
  });

  it('omits chunk_id / detected_language when nothing (caller or seg) provides them', () => {
    const out = composeDeliveredMetadata({ seg: {}, isFinal: false, callerMeta: undefined });
    expect('chunk_id' in out).toBe(false);
    expect('detected_language' in out).toBe(false);
  });

  // Pipeline_id joins chunk_id/detected_language as a -style
  // overlay: caller-supplied wins, otherwise the v2-resolved seg.pipelineId.
  // The caller here supplies the CAMEL-cased `pipelineId` (not the canonical
  // `pipeline_id`), so this only passes once the overlay normalizes it —
  // spreading callerMeta alone would leave `out.pipeline_id` unset.
  it('pipeline_id is overlaid LAST and a caller value overrides seg.pipelineId', () => {
    const withPipeline = { ...seg, pipelineId: 'pipeline-from-seg' };
    const out = composeDeliveredMetadata({
      seg: withPipeline,
      isFinal: true,
      callerMeta: { pipelineId: 'pipeline-from-caller' },
    });
    expect(out.pipeline_id).toBe('pipeline-from-caller');
    const keys = Object.keys(out);
    expect(keys.indexOf('pipeline_id')).toBeGreaterThan(keys.indexOf('speaker_id'));
  });

  it('pipeline_id resolves from seg.pipelineId when the caller supplies none', () => {
    const withPipeline = { ...seg, pipelineId: 'pipeline-from-seg' };
    const out = composeDeliveredMetadata({ seg: withPipeline, isFinal: true, callerMeta: undefined });
    expect(out.pipeline_id).toBe('pipeline-from-seg');
  });

  // Backward compatibility: an old backend never resolves a per-utterance
  // pipeline id, so seg.pipelineId is absent and the caller never supplied one —
  // the key must be OMITTED, never the literal "undefined".
  it('omits pipeline_id when nothing (caller or seg) provides one (old-backend degrade)', () => {
    const out = composeDeliveredMetadata({ seg, isFinal: true, callerMeta: undefined });
    expect('pipeline_id' in out).toBe(false);
    expect(JSON.stringify(out)).not.toContain('undefined');
  });
});

// ===========================================================================
// Lock 2 — resolution chains (golden).
// ===========================================================================
describe('chunk_id resolution chain', () => {
  it.each(CHUNK_ID_GOLDEN)('resolveChunkId(%o) → expected', ({ meta, expected }) => {
    expect(resolveChunkId(meta)).toBe(expected);
  });
});

describe('detected_language resolution chain', () => {
  it.each(DETECTED_LANGUAGE_GOLDEN)('resolveDetectedLanguage(%o, seg) → expected', ({ meta, seg, expected }) => {
    expect(resolveDetectedLanguage(meta, seg)).toBe(expected);
  });
});

// Pipeline_id resolution chain, same style as detected_language.
describe('pipeline_id resolution chain', () => {
  it.each(PIPELINE_ID_GOLDEN)('resolvePipelineId(%o, seg) → expected', ({ meta, seg, expected }) => {
    expect(resolvePipelineId(meta, seg)).toBe(expected);
  });
});

// ===========================================================================
// Lock 3 — default transcriptTemplate (v1 parity).
// ===========================================================================
describe('default transcriptTemplate', () => {
  it('defaults to "{timestamp} {speaker_id}: {text}"', () => {
    expect(DEFAULT_TRANSCRIPT_TEMPLATE).toBe('{timestamp} {speaker_id}: {text}');
  });

  it('applies the default when no template is passed (final formatting)', () => {
    expect(applyTemplate(undefined, { text: 'chest pain', speakerId: 'Doctor', timestamp: '1' })).toBe('1 Doctor: chest pain');
  });

  it('renders an empty slot (never the literal "undefined") for a missing speaker', () => {
    const out = applyTemplate(undefined, { text: 'hello', timestamp: '0' });
    expect(out).toBe('0 : hello');
    expect(out).not.toContain('undefined');
  });

  it('honors an explicit template over the default', () => {
    expect(applyTemplate('{speaker_id}: {text}', { text: 'hello', speakerId: 'Nurse' })).toBe('Nurse: hello');
  });
});
