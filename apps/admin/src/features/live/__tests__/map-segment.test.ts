import { describe, expect, it } from 'vitest';
import { mapTranscriptSegment, type StoreTranscriptSegment } from '../map-segment';

const base: StoreTranscriptSegment = {
  text: 'hello world',
  startTime: 1.2,
  endTime: 2.4,
  isFinal: true,
  speakerLabel: 'spk_1',
  confidence: 0.92,
  language: 'en',
};

describe('mapTranscriptSegment', () => {
  it('maps a store segment to a LiveTranscriptSegment with a stable id', () => {
    const seg = mapTranscriptSegment(base, 3);
    expect(seg.id).toBe('seg-3');
    expect(seg.text).toBe('hello world');
    expect(seg.isFinal).toBe(true);
    expect(seg.startTime).toBe(1.2);
    expect(seg.speakerLabel).toBe('spk_1');
  });

  it('passes word-level timings through wordTimestamps (D9 superset)', () => {
    const seg = mapTranscriptSegment(
      {
        ...base,
        words: [
          { word: 'hello', start: 1.2, end: 1.6 },
          { word: 'world', start: 1.7, end: 2.4, confidence: 0.8 },
        ],
      },
      0,
    );
    expect(seg.wordTimestamps).toHaveLength(2);
    expect(seg.wordTimestamps?.[0]).toEqual({ word: 'hello', start: 1.2, end: 1.6, confidence: null });
    expect(seg.wordTimestamps?.[1]?.confidence).toBe(0.8);
  });

  it('omits wordTimestamps when no words are present', () => {
    expect(mapTranscriptSegment(base, 0).wordTimestamps).toBeUndefined();
  });

  it('applies an inline edit override to the segment text', () => {
    const seg = mapTranscriptSegment(base, 1, 'edited text');
    expect(seg.text).toBe('edited text');
  });
});
