/**
 * @arcaai/vox/compat — golden fixtures for the metadata-passthrough contract
 * (TASK-566, locking TASK-564 §5.2 / §4.3).
 *
 * Concrete INSTANCES of the frozen delivered-metadata shape — one canned
 * `{ seg, isFinal, callerMeta }` input per case with its EXACT expected
 * `composeDeliveredMetadata(...)` output. `metadata-passthrough.contract.test.ts`
 * runs each case through the real pure helpers, so any regression in the §5.2
 * precedence order (a caller key clobbered, chunk_id/detected_language no longer
 * overlaid last) or the §4.3 resolution chains fails CI here.
 *
 * Co-located inside the package (not repo-root tests/fixtures) so the vox
 * `vitest run` stays hermetic and self-contained — the golden must be importable
 * by the package's own test runner. Do NOT restate the schema here; these are
 * instances of TASK-564 §5, which is authoritative.
 */

import type { EnrichmentSeg } from '../../speechToTextMetadata';

export interface ComposeCase {
  name: string;
  seg: EnrichmentSeg;
  isFinal: boolean;
  callerMeta: Record<string, unknown> | undefined;
  /** Exact expected delivered-metadata object (§5.2). */
  expected: Record<string, unknown>;
}

export const COMPOSE_GOLDEN: readonly ComposeCase[] = [
  {
    name: 'enrichments only (no caller metadata) — final',
    seg: { speakerLabel: 'Doctor', confidence: 0.9, language: 'en', startTime: 1, endTime: 3 },
    isFinal: true,
    callerMeta: undefined,
    expected: {
      speaker_id: 'Doctor',
      confidence: 0.9,
      language: 'en',
      startTime: 1,
      endTime: 3,
      isFinal: true,
      // §4.3: detected_language falls back to seg.language even without caller metadata.
      detected_language: 'en',
    },
  },
  {
    name: 'caller keys OVERRIDE enrichments (F4); unset keys fill from seg',
    seg: { speakerLabel: 'Doctor', confidence: 0.9, language: 'en', startTime: 1, endTime: 2 },
    isFinal: true,
    callerMeta: { speaker_id: 'app-x', confidence: 0.1, language: 'ml', role: 'clinician', device_id: 'mic-1' },
    expected: {
      speaker_id: 'app-x', // caller wins over diarization
      confidence: 0.1, // caller wins over seg.confidence
      language: 'ml', // caller wins over seg.language
      startTime: 1, // enrichment fills unset key
      endTime: 2,
      isFinal: true,
      role: 'clinician',
      device_id: 'mic-1',
      // §4.3: detected_language resolves from detected_language → detectedLanguage
      // → seg.language ONLY. A caller `language` override does NOT feed it, so it
      // stays the segment language 'en' here (proves the chain, not the `language` key).
      detected_language: 'en',
    },
  },
  {
    name: 'chunk_id / detected_language overlaid LAST (highest precedence)',
    seg: { language: 'en', startTime: 4, endTime: 5 },
    isFinal: true,
    callerMeta: { chunk_id: 'c1', detected_language: 'ta', device_id: 'mic-2' },
    expected: {
      speaker_id: undefined,
      confidence: undefined,
      language: 'en',
      startTime: 4,
      endTime: 5,
      isFinal: true,
      device_id: 'mic-2',
      chunk_id: 'c1',
      detected_language: 'ta',
    },
  },
  {
    name: '§4.3 chunk_id resolves chunkId when chunk_id absent',
    seg: {},
    isFinal: true,
    callerMeta: { chunkId: 'c2' },
    expected: {
      speaker_id: undefined,
      confidence: undefined,
      language: undefined,
      startTime: undefined,
      endTime: undefined,
      isFinal: true,
      chunkId: 'c2',
      // resolved and overlaid as the canonical key:
      chunk_id: 'c2',
    },
  },
  {
    name: '§4.3 chunk_id resolves `other` when chunk_id/chunkId absent',
    seg: {},
    isFinal: true,
    callerMeta: { other: 'c3' },
    expected: {
      speaker_id: undefined,
      confidence: undefined,
      language: undefined,
      startTime: undefined,
      endTime: undefined,
      isFinal: true,
      other: 'c3',
      chunk_id: 'c3',
    },
  },
  {
    name: 'interim with no caller metadata — omits chunk_id/detected_language',
    seg: {},
    isFinal: false,
    callerMeta: undefined,
    expected: {
      speaker_id: undefined,
      confidence: undefined,
      language: undefined,
      startTime: undefined,
      endTime: undefined,
      isFinal: false,
    },
  },
  {
    // TASK-613 D4: seg.pipelineId (the v2-resolved per-utterance pipeline)
    // is overlaid as pipeline_id, same precedence tier as chunk_id/detected_language.
    name: 'pipeline_id resolves from seg.pipelineId when caller supplies none',
    seg: { language: 'en', startTime: 1, endTime: 2, pipelineId: 'pipeline-fallback-abc' },
    isFinal: true,
    callerMeta: undefined,
    expected: {
      speaker_id: undefined,
      confidence: undefined,
      language: 'en',
      startTime: 1,
      endTime: 2,
      isFinal: true,
      detected_language: 'en',
      pipeline_id: 'pipeline-fallback-abc',
    },
  },
  {
    // Backward compatibility (§3.4): an old backend never resolves a
    // pipeline id on the segment, and the caller never supplies one — the
    // key must be OMITTED, never written as literal undefined/null.
    name: 'omits pipeline_id when neither caller nor seg provide one (old-backend degrade)',
    seg: { startTime: 5, endTime: 6 },
    isFinal: true,
    callerMeta: undefined,
    expected: {
      speaker_id: undefined,
      confidence: undefined,
      language: undefined,
      startTime: 5,
      endTime: 6,
      isFinal: true,
    },
  },
];

/** §4.3 chunk_id resolution chain — priority `chunk_id → chunkId → other`. */
export const CHUNK_ID_GOLDEN: readonly { meta: Record<string, unknown> | undefined; expected: unknown }[] = [
  { meta: { chunk_id: 'a', chunkId: 'b', other: 'c' }, expected: 'a' },
  { meta: { chunkId: 'b', other: 'c' }, expected: 'b' },
  { meta: { other: 'c' }, expected: 'c' },
  { meta: {}, expected: undefined },
  { meta: undefined, expected: undefined },
];

/** §4.3 detected_language chain — `detected_language → detectedLanguage → seg.language`. */
export const DETECTED_LANGUAGE_GOLDEN: readonly {
  meta: Record<string, unknown> | undefined;
  seg: EnrichmentSeg;
  expected: unknown;
}[] = [
  { meta: { detected_language: 'ml', detectedLanguage: 'hi' }, seg: { language: 'en' }, expected: 'ml' },
  { meta: { detectedLanguage: 'hi' }, seg: { language: 'en' }, expected: 'hi' },
  { meta: {}, seg: { language: 'en' }, expected: 'en' },
  { meta: undefined, seg: {}, expected: undefined },
];

/**
 * TASK-613 §3.3 pipeline_id chain — `pipeline_id → pipelineId → seg.pipelineId`.
 * Mirrors the detected_language chain: caller-supplied wins, otherwise the
 * v2-resolved value from the segment; `undefined` when nothing provides it.
 */
export const PIPELINE_ID_GOLDEN: readonly {
  meta: Record<string, unknown> | undefined;
  seg: EnrichmentSeg;
  expected: unknown;
}[] = [
  { meta: { pipeline_id: 'p-snake', pipelineId: 'p-camel' }, seg: { pipelineId: 'p-seg' }, expected: 'p-snake' },
  { meta: { pipelineId: 'p-camel' }, seg: { pipelineId: 'p-seg' }, expected: 'p-camel' },
  { meta: {}, seg: { pipelineId: 'p-seg' }, expected: 'p-seg' },
  { meta: undefined, seg: {}, expected: undefined },
];
