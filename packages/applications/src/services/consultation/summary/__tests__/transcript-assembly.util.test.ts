/**
 * Transcript-assembly util unit tests (TASK-998).
 *
 * `assembleTranscriptFragments` groups adjacent transcript fragments (one
 * `ContextItem` per STT utterance) into real paragraphs before they reach the
 * LLM or a `ChainSectionDto`. `joinTranscriptFragmentText` is the seam rule on
 * its own — locked separately so the "no doubled punctuation" behavior is
 * provable without going through the grouping pass.
 */

import { describe, it, expect } from 'vitest';
import {
  assembleTranscriptFragments,
  assembleTranscriptText,
  joinTranscriptFragmentText,
  readSpeakerId,
  DEFAULT_TRANSCRIPT_PARAGRAPH_GAP_SECONDS,
  type AssemblableTranscriptFragment,
} from '../transcript-assembly.util';

const T0 = new Date('2026-02-17T09:00:00.000Z');
const seconds = (n: number) => new Date(T0.getTime() + n * 1000);

function fragment(content: string, offsetSeconds: number, speakerId?: string): AssemblableTranscriptFragment {
  return { content, createdAt: seconds(offsetSeconds), speakerId };
}

describe('joinTranscriptFragmentText (seam rule)', () => {
  it('joins two fragments with a single space', () => {
    expect(joinTranscriptFragmentText('Hello there', 'how are you')).toBe('Hello there how are you');
  });

  it('does not double a terminal period at the seam', () => {
    // The seam case named directly in the acceptance criteria: the first
    // fragment already ends in a full stop.
    expect(joinTranscriptFragmentText('Is that right?', '. Yes, exactly.')).toBe('Is that right? Yes, exactly.');
    expect(joinTranscriptFragmentText('Hello there.', 'How are you?')).toBe('Hello there. How are you?');
  });

  it('collapses surrounding whitespace at the seam', () => {
    expect(joinTranscriptFragmentText('Hello there.   ', '   How are you?')).toBe('Hello there. How are you?');
  });

  it('returns the non-empty side when the other is empty', () => {
    expect(joinTranscriptFragmentText('', 'Hello.')).toBe('Hello.');
    expect(joinTranscriptFragmentText('Hello.', '')).toBe('Hello.');
  });
});

describe('readSpeakerId', () => {
  it('reads a string speakerId from metaData', () => {
    expect(readSpeakerId({ metaData: { speakerId: 'spk_1' } })).toBe('spk_1');
  });

  it('returns undefined when metaData is absent, empty, or non-string', () => {
    expect(readSpeakerId({})).toBeUndefined();
    expect(readSpeakerId({ metaData: {} })).toBeUndefined();
    expect(readSpeakerId({ metaData: { speakerId: 42 } })).toBeUndefined();
    expect(readSpeakerId({ metaData: null })).toBeUndefined();
  });
});

describe('assembleTranscriptFragments', () => {
  it('single fragment: one paragraph, unchanged text', () => {
    const result = assembleTranscriptFragments([fragment('Patient presents with headache.', 0)]);
    expect(result).toHaveLength(1);
    expect(result[0].content).toBe('Patient presents with headache.');
    expect(result[0].createdAt).toEqual(T0);
  });

  it('two adjacent same-speaker fragments (small gap): merged into one paragraph', () => {
    const result = assembleTranscriptFragments([fragment('Tell me about your symptoms.', 0, 'spk_doctor'), fragment('It started yesterday.', 2, 'spk_doctor')]);
    expect(result).toHaveLength(1);
    expect(result[0].content).toBe('Tell me about your symptoms. It started yesterday.');
    // The paragraph's timestamp is the LEAD (first) member's, mirroring the
    // UI-side grouping convention.
    expect(result[0].createdAt).toEqual(T0);
  });

  it('a speaker change is a real boundary even with no time gap', () => {
    const result = assembleTranscriptFragments([fragment('How have you been feeling?', 0, 'spk_doctor'), fragment('Pretty tired lately.', 1, 'spk_patient')]);
    expect(result).toHaveLength(2);
    expect(result[0].content).toBe('How have you been feeling?');
    expect(result[1].content).toBe('Pretty tired lately.');
  });

  it('no speaker info on either side never forces a break by itself', () => {
    const result = assembleTranscriptFragments([fragment('First part.', 0), fragment('second part.', 1)]);
    expect(result).toHaveLength(1);
    expect(result[0].content).toBe('First part. second part.');
  });

  it('a large gap starts a new paragraph even for the same speaker', () => {
    const result = assembleTranscriptFragments([
      fragment('Opening remarks.', 0, 'spk_doctor'),
      fragment('Follow-up after a long pause.', DEFAULT_TRANSCRIPT_PARAGRAPH_GAP_SECONDS + 60, 'spk_doctor'),
    ]);
    expect(result).toHaveLength(2);
    expect(result[0].content).toBe('Opening remarks.');
    expect(result[1].content).toBe('Follow-up after a long pause.');
  });

  it('a gap right at the threshold still merges; just over it splits', () => {
    const atThreshold = assembleTranscriptFragments([fragment('A.', 0), fragment('B.', DEFAULT_TRANSCRIPT_PARAGRAPH_GAP_SECONDS)]);
    expect(atThreshold).toHaveLength(1);

    const overThreshold = assembleTranscriptFragments([fragment('A.', 0), fragment('B.', DEFAULT_TRANSCRIPT_PARAGRAPH_GAP_SECONDS + 1)]);
    expect(overThreshold).toHaveLength(2);
  });

  it('a custom gapSeconds option overrides the default threshold', () => {
    const result = assembleTranscriptFragments([fragment('A.', 0), fragment('B.', 3)], { gapSeconds: 1 });
    expect(result).toHaveLength(2);
  });

  it('a seam where the preceding fragment already ends in a full stop joins cleanly', () => {
    const result = assembleTranscriptFragments([fragment('Is that right?', 0, 'spk_doctor'), fragment('. Yes, exactly.', 1, 'spk_doctor')]);
    expect(result).toHaveLength(1);
    expect(result[0].content).toBe('Is that right? Yes, exactly.');
  });

  it('drops empty/whitespace-only fragments without losing any real text', () => {
    const result = assembleTranscriptFragments([fragment('First.', 0), fragment('   ', 1), fragment(null as unknown as string, 2), fragment('Last.', 3)]);
    expect(result).toHaveLength(1);
    expect(result[0].content).toBe('First. Last.');
  });

  it('keeps an out-of-order run together rather than guessing at a boundary', () => {
    const result = assembleTranscriptFragments([fragment('Second in time, first in list.', 10), fragment('Earlier utterance, arrived late.', 0)]);
    expect(result).toHaveLength(1);
  });

  it('is lossless: every non-empty fragment word appears somewhere in the output', () => {
    const fragments = [fragment('Alpha.', 0, 'a'), fragment('Beta.', 200, 'a'), fragment('Gamma.', 201, 'b')];
    const result = assembleTranscriptFragments(fragments);
    const combined = result.map((p) => p.content).join(' ');
    expect(combined).toContain('Alpha.');
    expect(combined).toContain('Beta.');
    expect(combined).toContain('Gamma.');
  });
});

describe('assembleTranscriptText', () => {
  it('joins assembled paragraphs with a blank line, matching the old join(\'\\n\\n\') shape', () => {
    const text = assembleTranscriptText([
      fragment('Opening remarks.', 0, 'spk_doctor'),
      fragment('Follow-up after a long pause.', DEFAULT_TRANSCRIPT_PARAGRAPH_GAP_SECONDS + 60, 'spk_doctor'),
    ]);
    expect(text).toBe('Opening remarks.\n\nFollow-up after a long pause.');
  });

  it('returns an empty string for no fragments', () => {
    expect(assembleTranscriptText([])).toBe('');
  });
});
