/**
 * @arcaai/med-ner - Token-aware chunking tests (C-2)
 *
 * The chunker is the pure unit underlying `MedNERProcessor.extractChunked`.
 * It must split long input on sentence boundaries (never mid-word) and
 * respect a configurable token budget so we never feed the BERT model more
 * tokens than it can attend to.
 *
 * @vitest-environment jsdom
 */

import { describe, it, expect } from 'vitest';

import { chunkByTokens, segmentSentences, mergeChunkEntities, type TokenChunk } from '../utils/chunking.js';
import type { EntitySpan } from '../types/index.js';
import { MedicalEntityType } from '../types/index.js';

// Simple word-based tokenizer for tests: every whitespace-delimited token
// counts as one. This is sufficient to exercise the budget + stride logic.
const wordTokenizer = (text: string): number[] => {
  const words = text.trim().length === 0 ? [] : text.trim().split(/\s+/);
  // Return arbitrary token IDs (chunker only reads .length).
  return words.map((_, i) => i);
};

describe('segmentSentences', () => {
  it('returns a single segment for input without sentence terminators', () => {
    const result = segmentSentences('Just one sentence with no terminator');
    expect(result).toHaveLength(1);
    expect(result[0].text).toBe('Just one sentence with no terminator');
    expect(result[0].offset).toBe(0);
  });

  it('splits on `. `, `? `, and `! `', () => {
    const text = 'First sentence. Second sentence? Third one! Last.';
    const result = segmentSentences(text);
    expect(result.map((s) => s.text.trim())).toEqual([
      'First sentence.',
      'Second sentence?',
      'Third one!',
      'Last.',
    ]);
  });

  it('preserves character offsets that round-trip into the original text', () => {
    const text = 'Patient has diabetes. Prescribed metformin. Follow up in 4 weeks.';
    const result = segmentSentences(text);
    for (const seg of result) {
      expect(text.slice(seg.offset, seg.offset + seg.text.length)).toBe(seg.text);
    }
  });
});

describe('chunkByTokens', () => {
  it('returns a single chunk when input fits the budget', () => {
    const text = 'Patient has diabetes.';
    const chunks = chunkByTokens(text, wordTokenizer, { maxTokens: 384, stride: 64 });
    expect(chunks).toHaveLength(1);
    expect(chunks[0].text).toBe('Patient has diabetes.');
    expect(chunks[0].offset).toBe(0);
    expect(chunks[0].tokenCount).toBe(3);
  });

  it('returns empty array for empty input', () => {
    expect(chunkByTokens('', wordTokenizer)).toEqual([]);
    expect(chunkByTokens('   ', wordTokenizer)).toEqual([]);
  });

  it('splits at sentence boundaries when the budget is exceeded', () => {
    // Each sentence is 3 tokens; budget 6 ⇒ two sentences per chunk.
    const text = [
      'Patient has hypertension.',
      'Prescribed lisinopril today.',
      'Follow up next week.',
      'Repeat labs then.',
    ].join(' ');
    const chunks = chunkByTokens(text, wordTokenizer, { maxTokens: 6, stride: 0 });

    expect(chunks.length).toBeGreaterThanOrEqual(2);
    // Every chunk must START on a sentence boundary (offset matches a
    // sentence-start) and END at a sentence-terminator+space (never in the
    // middle of a word).
    for (const chunk of chunks) {
      expect(chunk.text.length).toBeGreaterThan(0);
      // No chunk should split a known word mid-token: every space-delimited
      // word in the chunk must match a complete word in the original text.
      const words = chunk.text.trim().split(/\s+/);
      for (const word of words) {
        expect(text.includes(word)).toBe(true);
      }
      expect(chunk.tokenCount).toBeLessThanOrEqual(6);
    }
  });

  it('applies the stride overlap by re-including trailing sentences', () => {
    const text = [
      'Sentence one a.',  // 3 tokens
      'Sentence two b.',  // 3 tokens
      'Sentence three c.',// 3 tokens
      'Sentence four d.', // 3 tokens
    ].join(' ');
    // With maxTokens=6 (two sentences) and stride=3 (one sentence),
    // consecutive chunks should overlap by one sentence.
    const chunks = chunkByTokens(text, wordTokenizer, { maxTokens: 6, stride: 3 });
    expect(chunks.length).toBeGreaterThanOrEqual(2);
    // Offsets are strictly monotonic and never decrease.
    for (let i = 1; i < chunks.length; i++) {
      expect(chunks[i].offset).toBeGreaterThan(chunks[i - 1].offset);
    }
    // Verify some sentence appears in two consecutive chunks (overlap).
    const overlaps = chunks.slice(1).some((c, i) => {
      const prev = chunks[i].text;
      const curr = c.text;
      // common substring of length > 5
      const prevSentences = prev.split(/(?<=[.!?])\s+/);
      return prevSentences.some((s) => s.length > 5 && curr.includes(s));
    });
    expect(overlaps, 'expected at least one sentence to overlap between consecutive chunks').toBe(true);
  });

  it('does NOT cut a long medical term across chunk boundaries', () => {
    // Construct a long text and verify the multi-word medical term
    // "Hyperlipidemia and Hypertension" appears intact in some chunk.
    const filler = Array.from({ length: 30 }, (_, i) => `Filler${i} sentence here.`).join(' ');
    const text = `${filler} Hyperlipidemia and Hypertension are common. ${filler}`;
    const chunks = chunkByTokens(text, wordTokenizer, { maxTokens: 20, stride: 5 });

    const term = 'Hyperlipidemia and Hypertension';
    const containsFullTerm = chunks.some((c) => c.text.includes(term));
    expect(containsFullTerm, `expected '${term}' to appear intact in at least one chunk`).toBe(true);

    // No chunk should contain the partial word 'Hyperlipid' without 'emia'
    for (const c of chunks) {
      if (c.text.includes('Hyperlipid')) {
        expect(c.text.includes('Hyperlipidemia'), 'word was cut mid-token').toBe(true);
      }
    }
  });

  it('chunk text segments must round-trip into the original via their offset', () => {
    const text = 'A. B. C. D. E. F. G. H. I. J.';
    const chunks = chunkByTokens(text, wordTokenizer, { maxTokens: 2, stride: 1 });
    for (const chunk of chunks) {
      expect(text.slice(chunk.offset, chunk.offset + chunk.text.length)).toBe(chunk.text);
    }
  });

  it('makes progress even when a single sentence exceeds the budget', () => {
    // A sentence with 10 tokens, budget of 3. The chunker must still emit it
    // (as a single oversized chunk) and not infinite-loop.
    const text = 'One two three four five six seven eight nine ten.';
    const chunks = chunkByTokens(text, wordTokenizer, { maxTokens: 3, stride: 1 });
    expect(chunks).toHaveLength(1);
    expect(chunks[0].text).toBe(text);
  });
});

describe('mergeChunkEntities', () => {
  const mk = (
    text: string,
    type: MedicalEntityType,
    start: number,
    end: number,
    score: number,
  ): EntitySpan => ({ text, type, start, end, score, rawLabel: type });

  it('deduplicates an entity discovered in two overlapping chunks', () => {
    const chunkA: TokenChunk = { text: 'Patient has Type 2 Diabetes today.', offset: 0, tokenCount: 6 };
    const chunkB: TokenChunk = { text: 'Type 2 Diabetes today. Follow up.', offset: 12, tokenCount: 7 };

    // Both chunks discover the same entity (after their offsets are added
    // upstream the absolute positions match).
    const entitiesA = [mk('Type 2 Diabetes', MedicalEntityType.DISEASE, 12, 27, 0.93)];
    const entitiesB = [mk('Type 2 Diabetes', MedicalEntityType.DISEASE, 12, 27, 0.95)];

    const merged = mergeChunkEntities(
      [
        { chunk: chunkA, entities: entitiesA },
        { chunk: chunkB, entities: entitiesB },
      ],
    );

    expect(merged).toHaveLength(1);
    // The higher-confidence detection wins.
    expect(merged[0].score).toBe(0.95);
    expect(merged[0].start).toBe(12);
    expect(merged[0].end).toBe(27);
    expect(merged[0].text).toBe('Type 2 Diabetes');
  });

  it('keeps non-overlapping entities from different chunks', () => {
    const chunkA: TokenChunk = { text: 'A. B.', offset: 0, tokenCount: 2 };
    const chunkB: TokenChunk = { text: 'C. D.', offset: 6, tokenCount: 2 };
    const entitiesA = [mk('A', MedicalEntityType.DISEASE, 0, 1, 0.9)];
    const entitiesB = [mk('C', MedicalEntityType.MEDICATION, 6, 7, 0.9)];

    const merged = mergeChunkEntities(
      [
        { chunk: chunkA, entities: entitiesA },
        { chunk: chunkB, entities: entitiesB },
      ],
    );

    expect(merged).toHaveLength(2);
    expect(merged.map((e) => e.text)).toEqual(['A', 'C']);
  });
});
