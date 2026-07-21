/**
 * @arcaai/med-ner - Token-aware chunking
 *
 * BERT-base NER has a hard 512 WordPiece-token attention window. Splitting
 * input on raw character windows (as the original implementation did) breaks
 * the tokenizer in two pathological ways:
 *
 *   1. A character slice can land mid-word, leaving the tokenizer to produce
 *      garbage subwords that the model will mis-classify ("Metformin" →
 *      "Metfor" + "min" gives `OTHER + OTHER` instead of `MEDICATION`).
 *   2. Character budgets do not correspond to token budgets — clinical text
 *      averages ~1.3 chars/token, so a 512-char chunk is only ~395 tokens
 *      while a 512-char chunk of dense compounds can blow past 700 tokens.
 *
 * This module instead:
 *   - Segments input at sentence boundaries (`.`, `!`, `?` followed by
 *     whitespace), never inside a word.
 *   - Asks the model's tokenizer how many tokens each sentence is worth.
 *   - Groups sentences into chunks whose total token count stays below
 *     `maxTokens` (default 384, leaving headroom for `[CLS]` / `[SEP]`).
 *   - Slides chunks by a configurable `stride` (default 64 tokens) so that
 *     entities discovered near a chunk boundary are corroborated in the
 *     adjacent chunk and can be deduplicated by {@link mergeChunkEntities}.
 */

import type { EntitySpan } from '../types/index.js';
import { mergeOverlappingEntities } from './entityUtils.js';

/**
 * A function that returns the token count for a piece of text by tokenising
 * it with the active model's tokenizer.
 *
 * The chunker only needs the **length** of the returned array, so any of the
 * common shapes (`number[]`, `string[]`, BERT's `BatchEncoding.input_ids`)
 * can be adapted with a thin wrapper.
 */
export type Tokenizer = (text: string) => ArrayLike<unknown>;

export interface ChunkByTokensOptions {
  /** Maximum tokens per chunk. Default: 384 (leaves headroom for special tokens in a 512-cap model). */
  maxTokens?: number;
  /** Token-count overlap between consecutive chunks. Default: 64. */
  stride?: number;
}

export interface TokenChunk {
  /** The chunk's substring of the original input. */
  text: string;
  /** Character offset of `text` inside the original input. */
  offset: number;
  /** Tokens this chunk costs against the model's attention window. */
  tokenCount: number;
}

export interface ChunkEntities {
  chunk: TokenChunk;
  entities: EntitySpan[];
}

/**
 * Default chunking budget (max=384, stride=64).
 */
export const DEFAULT_MAX_TOKENS = 384;
export const DEFAULT_STRIDE = 64;

interface Sentence {
  text: string;
  offset: number;
  tokens: number;
}

/**
 * Split text into sentence segments without losing any characters. The
 * regex matches a sentence-terminator (`.`, `!`, `?`, possibly repeated)
 * followed by one-or-more whitespace characters — every character in the
 * input ends up in exactly one segment.
 */
export function segmentSentences(text: string): Array<{ text: string; offset: number }> {
  if (!text) return [];
  const segments: Array<{ text: string; offset: number }> = [];
  const re = /[.!?]+\s+/g;
  let cursor = 0;
  let match: RegExpExecArray | null;
  while ((match = re.exec(text)) !== null) {
    const endOfSegment = match.index + match[0].length;
    segments.push({ text: text.slice(cursor, endOfSegment), offset: cursor });
    cursor = endOfSegment;
  }
  if (cursor < text.length) {
    segments.push({ text: text.slice(cursor), offset: cursor });
  }
  return segments;
}

/**
 * Split text into overlapping chunks under a token budget.
 *
 * Always emits at least one chunk per non-empty input. Sentences that are
 * individually larger than `maxTokens` are emitted as a single oversized
 * chunk rather than mid-word splits.
 */
export function chunkByTokens(text: string, tokenizer: Tokenizer, options: ChunkByTokensOptions = {}): TokenChunk[] {
  const maxTokens = options.maxTokens ?? DEFAULT_MAX_TOKENS;
  const stride = options.stride ?? DEFAULT_STRIDE;

  if (!text || text.trim().length === 0) return [];
  if (maxTokens <= 0) {
    throw new Error('chunkByTokens: maxTokens must be > 0');
  }

  const rawSegments = segmentSentences(text);
  const sentences: Sentence[] = rawSegments.map((seg) => ({
    ...seg,
    tokens: tokenizer(seg.text).length,
  }));

  const chunks: TokenChunk[] = [];
  let i = 0;
  while (i < sentences.length) {
    // Always include at least one sentence so we make progress even when
    // a single sentence exceeds the budget.
    let j = i + 1;
    let total = sentences[i].tokens;
    while (j < sentences.length && total + sentences[j].tokens <= maxTokens) {
      total += sentences[j].tokens;
      j++;
    }

    const first = sentences[i];
    const last = sentences[j - 1];
    const chunkStart = first.offset;
    const chunkEnd = last.offset + last.text.length;
    chunks.push({
      text: text.slice(chunkStart, chunkEnd),
      offset: chunkStart,
      tokenCount: total,
    });

    if (j >= sentences.length) break;

    // Slide backwards by `stride` tokens (in whole-sentence units) for
    // overlap. `next` must always advance at least one sentence past `i`
    // to guarantee termination.
    let k = j;
    let strideTokens = 0;
    while (k - 1 > i && strideTokens < stride) {
      strideTokens += sentences[k - 1].tokens;
      k--;
    }
    i = Math.max(i + 1, k);
  }

  return chunks;
}

/**
 * Merge entities discovered across overlapping chunks. The chunk offsets
 * are assumed to have already been baked into each `EntitySpan.start/end`
 * (i.e. positions are absolute in the original document).
 *
 * Overlapping detections (which happen at every chunk boundary thanks to
 * the stride) are resolved by `mergeOverlappingEntities` — the highest
 * scoring detection wins, preserving the canonical span boundaries.
 */
export function mergeChunkEntities(chunkResults: ChunkEntities[]): EntitySpan[] {
  const all: EntitySpan[] = [];
  for (const { entities } of chunkResults) {
    all.push(...entities);
  }
  return mergeOverlappingEntities(all);
}
