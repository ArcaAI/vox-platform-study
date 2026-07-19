import { describe, it, expect } from 'vitest';
import {
  attachSegmentEvidence,
  computeSegmentOffsets,
  resolveSegmentIdForOffset,
} from '../transcript-segments';

describe('TASK-519 transcript-segments (pure helpers)', () => {
  describe('computeSegmentOffsets', () => {
    it('resolves char offsets by locating each segment text in order', () => {
      const transcript = 'Patient reports chest pain. No shortness of breath.';
      const segments = [
        { speaker: 'doctor', text: 'Patient reports chest pain.', t0Ms: 0, t1Ms: 1500 },
        { speaker: 'doctor', text: 'No shortness of breath.', t0Ms: 1500, t1Ms: 3000 },
      ];

      const resolved = computeSegmentOffsets(transcript, segments);

      expect(resolved).toHaveLength(2);
      expect(resolved[0]).toMatchObject({ idx: 0, charStart: 0, charEnd: 27, speaker: 'doctor', t0Ms: 0, t1Ms: 1500 });
      // Second segment begins right after the space following the first.
      expect(resolved[1].idx).toBe(1);
      expect(transcript.slice(resolved[1].charStart!, resolved[1].charEnd!)).toBe('No shortness of breath.');
    });

    it('resolves a repeated phrase to its in-order occurrence via the running cursor', () => {
      const transcript = 'pain here. pain there.';
      const segments = [{ text: 'pain' }, { text: 'pain' }];
      const resolved = computeSegmentOffsets(transcript, segments);
      expect(resolved[0].charStart).toBe(0);
      expect(resolved[1].charStart).toBe(11); // the SECOND "pain", not the first
    });

    it('honors explicit offsets over a text search', () => {
      const resolved = computeSegmentOffsets('anything', [
        { text: 'x', charStart: 3, charEnd: 8, speaker: 'p' },
      ]);
      expect(resolved[0]).toMatchObject({ charStart: 3, charEnd: 8 });
    });

    it('leaves offsets null (but keeps ordinal/timings) when text is absent or unmatched', () => {
      const resolved = computeSegmentOffsets('abc', [
        { t0Ms: 10, t1Ms: 20 },
        { text: 'zzz', t0Ms: 20, t1Ms: 30 },
      ]);
      expect(resolved[0]).toMatchObject({ idx: 0, charStart: null, charEnd: null, t0Ms: 10 });
      expect(resolved[1]).toMatchObject({ idx: 1, charStart: null, charEnd: null, t0Ms: 20 });
    });
  });

  describe('resolveSegmentIdForOffset', () => {
    const segments = [
      { id: 'seg-a', charStart: 0, charEnd: 10 },
      { id: 'seg-b', charStart: 10, charEnd: 25 },
      { id: 'seg-c', charStart: null, charEnd: null },
    ];

    it('maps an offset to the segment whose half-open span contains it', () => {
      expect(resolveSegmentIdForOffset(segments, 0)).toBe('seg-a');
      expect(resolveSegmentIdForOffset(segments, 9)).toBe('seg-a');
      expect(resolveSegmentIdForOffset(segments, 10)).toBe('seg-b'); // boundary is exclusive on the left neighbour
      expect(resolveSegmentIdForOffset(segments, 24)).toBe('seg-b');
    });

    it('returns null for an offset in no segment / non-finite / null-offset segments', () => {
      expect(resolveSegmentIdForOffset(segments, 25)).toBeNull();
      expect(resolveSegmentIdForOffset(segments, -1)).toBeNull();
      expect(resolveSegmentIdForOffset(segments, null)).toBeNull();
      expect(resolveSegmentIdForOffset(segments, undefined)).toBeNull();
    });
  });

  describe('attachSegmentEvidence', () => {
    it('annotates each evidence span with the containing segment id', () => {
      const citationsMap = {
        claims: [
          {
            id: 'claim-1',
            text: 'chest pain',
            evidence: [{ transcriptContextItemId: 't1', startOffset: 16, endOffset: 26, quote: 'chest pain' }],
          },
          { id: 'claim-2', text: 'ungrounded', evidence: [] },
        ],
      };
      const segments = [
        { id: 'seg-0', charStart: 0, charEnd: 15 },
        { id: 'seg-1', charStart: 15, charEnd: 40 },
      ];

      const out = attachSegmentEvidence(citationsMap, segments) as typeof citationsMap;

      expect((out.claims[0].evidence[0] as { segmentId?: string }).segmentId).toBe('seg-1');
      expect(out.claims[1].evidence).toEqual([]);
      // Non-destructive: the input map is untouched.
      expect((citationsMap.claims[0].evidence[0] as { segmentId?: string }).segmentId).toBeUndefined();
    });

    it('leaves an evidence span unannotated when its offset falls in no segment', () => {
      const citationsMap = { claims: [{ id: 'c', evidence: [{ startOffset: 999 }] }] };
      const out = attachSegmentEvidence(citationsMap, [{ id: 'seg-0', charStart: 0, charEnd: 10 }]) as typeof citationsMap;
      expect((out.claims[0].evidence[0] as { segmentId?: string }).segmentId).toBeUndefined();
    });

    it('is a no-op for a null map or empty segments', () => {
      expect(attachSegmentEvidence(null, [{ id: 's', charStart: 0, charEnd: 1 }])).toBeNull();
      const map = { claims: [{ id: 'c', evidence: [{ startOffset: 0 }] }] };
      expect(attachSegmentEvidence(map, [])).toBe(map);
    });
  });
});
