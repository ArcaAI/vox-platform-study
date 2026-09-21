import { describe, it, expect } from 'vitest';
import { renderHook } from '@testing-library/react';

import { groupTranscriptSegments, joinTranscriptFragments, seamAdjustment, DEFAULT_PARAGRAPH_GAP_SECONDS } from '../paragraph-grouping';
import { useLiveTranscript } from '../use-live-transcript';
import type { LiveTranscriptSegment } from '../types';

function seg(partial: Partial<LiveTranscriptSegment> & { id: string }): LiveTranscriptSegment {
  return { text: 'text', isFinal: true, ...partial };
}

describe('joinTranscriptFragments (seam rule)', () => {
  it('joins with a single space', () => {
    expect(joinTranscriptFragments('Hello there', 'how are you')).toBe('Hello there how are you');
  });

  it('never doubles a terminal punctuation mark at the seam', () => {
    // The seam named directly in the acceptance criteria: the preceding
    // fragment already ends in a full stop.
    expect(joinTranscriptFragments('Is that right?', '. Yes, exactly.')).toBe('Is that right? Yes, exactly.');
    expect(joinTranscriptFragments('Hello there.', 'How are you?')).toBe('Hello there. How are you?');
  });
});

describe('seamAdjustment', () => {
  it('reports the leading characters of `next` to skip when they duplicate a terminator', () => {
    expect(seamAdjustment('Is that right?', '. Yes')).toEqual({ separator: ' ', skip: 2 });
    expect(seamAdjustment('Hello there.', 'How are you?')).toEqual({ separator: ' ', skip: 0 });
  });
});

describe('groupTranscriptSegments', () => {
  it('single segment: one paragraph with that one member', () => {
    const segments = [seg({ id: 's1', text: 'Patient presents with headache.' })];
    const result = groupTranscriptSegments(segments);
    expect(result).toHaveLength(1);
    expect(result[0].segments).toEqual(segments);
    expect(result[0].id).toBe('s1');
  });

  it('two adjacent same-speaker segments within the gap merge into one paragraph', () => {
    const segments = [
      seg({ id: 's1', text: 'Tell me about your symptoms.', startTime: 0, endTime: 2, speakerLabel: 'Doctor' }),
      seg({ id: 's2', text: 'It started yesterday.', startTime: 2.5, endTime: 4, speakerLabel: 'Doctor' }),
    ];
    const result = groupTranscriptSegments(segments);
    expect(result).toHaveLength(1);
    expect(result[0].segments).toHaveLength(2);
    expect(result[0].text).toBe('Tell me about your symptoms. It started yesterday.');
  });

  it('a speaker change starts a new paragraph even with no time gap', () => {
    const segments = [
      seg({ id: 's1', text: 'How have you been feeling?', startTime: 0, endTime: 1, speakerLabel: 'Doctor' }),
      seg({ id: 's2', text: 'Pretty tired lately.', startTime: 1, endTime: 2, speakerLabel: 'Patient' }),
    ];
    const result = groupTranscriptSegments(segments);
    expect(result).toHaveLength(2);
    expect(result[0].segments).toHaveLength(1);
    expect(result[1].segments).toHaveLength(1);
  });

  it('a large gap starts a new paragraph for the same speaker', () => {
    const segments = [
      seg({ id: 's1', text: 'Opening remarks.', startTime: 0, endTime: 1, speakerLabel: 'Doctor' }),
      seg({ id: 's2', text: 'Follow-up after a long pause.', startTime: 1 + DEFAULT_PARAGRAPH_GAP_SECONDS + 30, endTime: 2, speakerLabel: 'Doctor' }),
    ];
    const result = groupTranscriptSegments(segments);
    expect(result).toHaveLength(2);
  });

  it('a seam where the preceding segment already ends in a full stop joins cleanly', () => {
    const segments = [
      seg({ id: 's1', text: 'Is that right?', startTime: 0, endTime: 1, speakerLabel: 'Doctor' }),
      seg({ id: 's2', text: '. Yes, exactly.', startTime: 1.2, endTime: 2, speakerLabel: 'Doctor' }),
    ];
    const result = groupTranscriptSegments(segments);
    expect(result).toHaveLength(1);
    expect(result[0].text).toBe('Is that right? Yes, exactly.');
  });

  it('segments missing timestamps never merge — no evidence of adjacency', () => {
    const segments = [seg({ id: 's1', text: 'First segment' }), seg({ id: 's2', text: 'Second segment' })];
    const result = groupTranscriptSegments(segments);
    expect(result).toHaveLength(2);
  });

  it('enabled: false keeps every segment as its own single-member paragraph', () => {
    const segments = [
      seg({ id: 's1', text: 'a.', startTime: 0, endTime: 1, speakerLabel: 'Doctor' }),
      seg({ id: 's2', text: 'b.', startTime: 1.1, endTime: 2, speakerLabel: 'Doctor' }),
    ];
    const result = groupTranscriptSegments(segments, { enabled: false });
    expect(result).toHaveLength(2);
    expect(result.every((p) => p.segments.length === 1)).toBe(true);
  });

  it('a non-final tail never gets a further segment appended', () => {
    const segments = [
      seg({ id: 's1', text: 'partial', startTime: 0, endTime: 1, isFinal: false, speakerLabel: 'Doctor' }),
      seg({ id: 's2', text: 'more', startTime: 1.1, endTime: 2, speakerLabel: 'Doctor' }),
    ];
    const result = groupTranscriptSegments(segments);
    expect(result).toHaveLength(2);
  });
});

describe('useLiveTranscript — paragraphs', () => {
  it('exposes grouped paragraphs alongside the flat segment list', () => {
    const segments = [
      seg({ id: 's1', text: 'Tell me about your symptoms.', startTime: 0, endTime: 2, speakerLabel: 'Doctor' }),
      seg({ id: 's2', text: 'It started yesterday.', startTime: 2.5, endTime: 4, speakerLabel: 'Doctor' }),
    ];
    const { result } = renderHook(() => useLiveTranscript({ segments }));
    expect(result.current.segments).toHaveLength(2);
    expect(result.current.paragraphs).toHaveLength(1);
    expect(result.current.paragraphs[0].segments).toHaveLength(2);
  });

  it('disables grouping while editable, so every paragraph stays single-member', () => {
    const segments = [
      seg({ id: 's1', text: 'a.', startTime: 0, endTime: 1, speakerLabel: 'Doctor' }),
      seg({ id: 's2', text: 'b.', startTime: 1.1, endTime: 2, speakerLabel: 'Doctor' }),
    ];
    const { result } = renderHook(() => useLiveTranscript({ segments, editable: true }));
    expect(result.current.paragraphs).toHaveLength(2);
  });

  it('a custom paragraphGapSeconds overrides the default threshold', () => {
    const segments = [
      seg({ id: 's1', text: 'a.', startTime: 0, endTime: 0, speakerLabel: 'Doctor' }),
      seg({ id: 's2', text: 'b.', startTime: 3, endTime: 3, speakerLabel: 'Doctor' }),
    ];
    const merged = renderHook(() => useLiveTranscript({ segments, paragraphGapSeconds: 5 }));
    expect(merged.result.current.paragraphs).toHaveLength(1);
    const split = renderHook(() => useLiveTranscript({ segments, paragraphGapSeconds: 1 }));
    expect(split.result.current.paragraphs).toHaveLength(2);
  });
});
