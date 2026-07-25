/**
 * stt → apps/api transcript-segment CONSUMER contract (TASK-533 D-22).
 *
 * The producer half is asserted in
 * `apps/stt/tests/unit/test_transcript_segment_contract.py`. Both suites read
 * the SAME checked-in fixture, so a producer shape change that this consumer
 * cannot read fails one side or the other — the cross-boundary lock that did not
 * exist when D-22 shipped.
 *
 * Why the pre-existing tests missed it: `sttInternal.service.test.ts` hand-feeds
 * ideal camelCase-with-text payloads that NO producer ever emitted. Streaming sent
 * no segments at all, and batch sent a snake_case/seconds/text-less VAD shape that
 * `computeSegmentOffsets` silently coerced to all-null. Every test stayed green
 * while the evidence-grounding pillar had no data in production.
 *
 * These tests therefore assert the thing that actually matters: fed a REAL producer
 * payload, the consumer yields rows whose `t0Ms`/`t1Ms`/`speaker`/`charStart`/
 * `charEnd` are NON-NULL — because `resolveSegmentIdForOffset` skips null-offset
 * segments, so a null row grounds nothing.
 */
import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  computeSegmentOffsets,
  resolveSegmentIdForOffset,
  type UnusableSegmentReport,
} from '../../../packages/applications/src/services/consultation/lib/transcript-segments';

interface FixtureCase {
  transcriptText: string;
  segments: Record<string, unknown>[];
}

const fixture = JSON.parse(
  readFileSync(join(__dirname, 'transcript-segments.fixture.json'), 'utf-8'),
) as Record<string, FixtureCase>;

/** Every field the harness evidence chain needs must survive ingest. */
const expectFullyGrounded = (rows: ReturnType<typeof computeSegmentOffsets>) => {
  for (const row of rows) {
    expect(row.t0Ms, `t0Ms on segment ${row.idx}`).not.toBeNull();
    expect(row.t1Ms, `t1Ms on segment ${row.idx}`).not.toBeNull();
    expect(row.speaker, `speaker on segment ${row.idx}`).not.toBeNull();
    expect(row.charStart, `charStart on segment ${row.idx}`).not.toBeNull();
    expect(row.charEnd, `charEnd on segment ${row.idx}`).not.toBeNull();
  }
};

describe('STT transcript-segment contract — streaming producer', () => {
  const { transcriptText, segments } = fixture.streaming;

  it('resolves every segment to a fully-populated row', () => {
    const rows = computeSegmentOffsets(transcriptText, segments);

    expect(rows).toHaveLength(3);
    expectFullyGrounded(rows);
  });

  it('preserves the producer char offsets exactly (they slice the shipped text)', () => {
    const rows = computeSegmentOffsets(transcriptText, segments);

    rows.forEach((row, i) => {
      const source = segments[i] as { text: string; charStart: number; charEnd: number };
      expect(row.charStart).toBe(source.charStart);
      expect(row.charEnd).toBe(source.charEnd);
      expect(transcriptText.slice(row.charStart!, row.charEnd!)).toBe(source.text);
    });
  });

  it('grounds a transcript offset back to the right segment', () => {
    const rows = computeSegmentOffsets(transcriptText, segments);
    const refs = rows.map((r) => ({ id: `seg-${r.idx}`, charStart: r.charStart, charEnd: r.charEnd }));

    // "amlodipine" sits inside the third utterance.
    const offset = transcriptText.indexOf('amlodipine');
    expect(resolveSegmentIdForOffset(refs, offset)).toBe('seg-2');
  });

  it('reports nothing unusable', () => {
    const onUnusable = vi.fn();
    computeSegmentOffsets(transcriptText, segments, onUnusable);
    expect(onUnusable).not.toHaveBeenCalled();
  });
});

describe('STT transcript-segment contract — batch producer', () => {
  const { transcriptText, segments } = fixture.batch;

  it('resolves offsets by text search and yields fully-populated rows', () => {
    const rows = computeSegmentOffsets(transcriptText, segments);

    expect(rows).toHaveLength(3);
    // The batch producer deliberately sends no char offsets — the consumer's
    // text search must supply them.
    expect(segments.every((s) => s.charStart === undefined)).toBe(true);
    expectFullyGrounded(rows);
  });

  it('anchors each row to the correct span of the transcript', () => {
    const rows = computeSegmentOffsets(transcriptText, segments);

    rows.forEach((row, i) => {
      expect(transcriptText.slice(row.charStart!, row.charEnd!)).toBe(segments[i].text);
    });
  });

  it('carries the diarization speaker through', () => {
    const rows = computeSegmentOffsets(transcriptText, segments);
    expect(rows.map((r) => r.speaker)).toEqual(['doctor', 'patient', 'doctor']);
  });
});

describe('STT transcript-segment contract — legacy metadata shape (the defect itself)', () => {
  const { transcriptText, segments } = fixture.legacyBatchMetadata;

  it('normalizes snake_case/seconds instead of nulling every field', () => {
    const rows = computeSegmentOffsets(transcriptText, segments);

    // BEFORE D-22 this produced [{idx:0, t0Ms:null, t1Ms:null, speaker:null, ...}].
    expect(rows[0].t0Ms).toBe(0);
    expect(rows[0].t1Ms).toBe(1500);
    expect(rows[0].speaker).toBe('doctor');
    expect(rows[1].t0Ms).toBe(1500);
    expect(rows[1].speaker).toBe('patient');
  });

  it('still cannot resolve offsets — the legacy shape has no text — but stays usable', () => {
    const rows = computeSegmentOffsets(transcriptText, segments);

    // Timing + speaker are recoverable; char offsets are genuinely absent from
    // the source, so they stay null. The row is still useful for audio seek.
    expect(rows[0].charStart).toBeNull();
    expect(rows[0].charEnd).toBeNull();
  });

  it('does NOT report unusable — timing and speaker were recovered', () => {
    const onUnusable = vi.fn();
    computeSegmentOffsets(transcriptText, segments, onUnusable);
    expect(onUnusable).not.toHaveBeenCalled();
  });

  it('DOES report unusable for a payload with nothing recoverable at all', () => {
    const onUnusable = vi.fn();
    const rows = computeSegmentOffsets('some transcript', [{ is_speech: true, confidence: 0.9 } as never], onUnusable);

    expect(rows[0]).toMatchObject({ idx: 0, t0Ms: null, t1Ms: null, speaker: null, charStart: null, charEnd: null });
    expect(onUnusable).toHaveBeenCalledTimes(1);
    const report = onUnusable.mock.calls[0][0] as UnusableSegmentReport;
    expect(report.position).toBe(0);
    expect(report.keys).toEqual(['is_speech', 'confidence']);
  });
});
