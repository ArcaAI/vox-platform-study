/**
 * Segment-level transcription quality metrics.
 *
 * Computes SER, Task Success Rate, and Silence Hallucination Rate.
 * All require ground-truth segments with timestamps and hypothesis finals with audio-time boundaries.
 */

import type { ExpectedSegment } from './transcript-parser.js';
import { normalizeText } from './wer.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface TranscriptFinal {
  text: string;
  startTime: number;
  endTime: number;
}

export interface SegmentMatch {
  reference: ExpectedSegment;
  hypothesisTexts: string[];
  hypothesisCombined: string;
  segmentWer: number;
  hasError: boolean;
  covered: boolean;
}

export interface SerResult {
  ser: number;
  totalSegments: number;
  errorSegments: number;
  segmentDetails: SegmentMatch[];
}

export interface TaskSuccessResult {
  rate: number;
  totalSegments: number;
  coveredSegments: number;
  uncoveredSegments: ExpectedSegment[];
}

export interface HallucinationResult {
  rate: number;
  totalFinals: number;
  hallucinatedFinals: number;
  hallucinatedTexts: string[];
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function timeOverlap(aStart: number, aEnd: number, bStart: number, bEnd: number): number {
  const overlapStart = Math.max(aStart, bStart);
  const overlapEnd = Math.min(aEnd, bEnd);
  return Math.max(0, overlapEnd - overlapStart);
}

function simpleWordWer(reference: string, hypothesis: string): number {
  const refWords = normalizeText(reference).split(/\s+/).filter(Boolean);
  const hypWords = normalizeText(hypothesis).split(/\s+/).filter(Boolean);

  const n = refWords.length;
  const m = hypWords.length;

  if (n === 0 && m === 0) return 0;
  if (n === 0) return 1;

  let prev = Array.from({ length: m + 1 }, (_, j) => j);
  let curr = new Array(m + 1).fill(0);

  for (let i = 1; i <= n; i++) {
    curr[0] = i;
    for (let j = 1; j <= m; j++) {
      if (refWords[i - 1] === hypWords[j - 1]) {
        curr[j] = prev[j - 1];
      } else {
        curr[j] = Math.min(prev[j - 1] + 1, prev[j] + 1, curr[j - 1] + 1);
      }
    }
    [prev, curr] = [curr, prev];
  }

  return Math.min(prev[m] / n, 1);
}

// ---------------------------------------------------------------------------
// SER: Sentence Error Rate
// ---------------------------------------------------------------------------

/**
 * Compute Sentence Error Rate using time-overlap segment matching.
 *
 * For each ground truth segment, find hypothesis finals that overlap its time range,
 * concatenate their texts, and compute per-segment WER. SER = segments with WER > 0 / total.
 *
 * Requires ground truth segments to have startTime/endTime.
 */
export function computeSer(referenceSegments: ExpectedSegment[], hypothesisFinals: TranscriptFinal[], overlapToleranceSec = 0.5): SerResult {
  const segmentsWithTime = referenceSegments.filter((s) => s.startTime != null && s.endTime != null);

  if (segmentsWithTime.length === 0) {
    return { ser: 0, totalSegments: 0, errorSegments: 0, segmentDetails: [] };
  }

  const details: SegmentMatch[] = [];
  let errorCount = 0;

  for (const refSeg of segmentsWithTime) {
    const refStart = refSeg.startTime!;
    const refEnd = refSeg.endTime!;

    // Find overlapping hypothesis finals (with tolerance)
    const matched = hypothesisFinals.filter(
      (h) => timeOverlap(refStart - overlapToleranceSec, refEnd + overlapToleranceSec, h.startTime, h.endTime) > 0,
    );

    const combinedText = matched.map((h) => h.text).join(' ');
    const segWer = matched.length > 0 ? simpleWordWer(refSeg.text, combinedText) : 1;
    const hasError = segWer > 0;

    if (hasError) errorCount++;

    details.push({
      reference: refSeg,
      hypothesisTexts: matched.map((h) => h.text),
      hypothesisCombined: combinedText,
      segmentWer: segWer,
      hasError,
      covered: matched.length > 0,
    });
  }

  return {
    ser: errorCount / segmentsWithTime.length,
    totalSegments: segmentsWithTime.length,
    errorSegments: errorCount,
    segmentDetails: details,
  };
}

// ---------------------------------------------------------------------------
// Task Success Rate
// ---------------------------------------------------------------------------

/**
 * Compute Task Success Rate: fraction of ground truth segments that have at least
 * one overlapping hypothesis final with per-segment WER below 0.5.
 */
export function computeTaskSuccess(
  referenceSegments: ExpectedSegment[],
  hypothesisFinals: TranscriptFinal[],
  werCutoff = 0.5,
  overlapToleranceSec = 0.5,
): TaskSuccessResult {
  const segmentsWithTime = referenceSegments.filter((s) => s.startTime != null && s.endTime != null);

  if (segmentsWithTime.length === 0) {
    return { rate: 1, totalSegments: 0, coveredSegments: 0, uncoveredSegments: [] };
  }

  let covered = 0;
  const uncovered: ExpectedSegment[] = [];

  for (const refSeg of segmentsWithTime) {
    const refStart = refSeg.startTime!;
    const refEnd = refSeg.endTime!;

    const matched = hypothesisFinals.filter(
      (h) => timeOverlap(refStart - overlapToleranceSec, refEnd + overlapToleranceSec, h.startTime, h.endTime) > 0,
    );

    if (matched.length > 0) {
      const combinedText = matched.map((h) => h.text).join(' ');
      const segWer = simpleWordWer(refSeg.text, combinedText);
      if (segWer < werCutoff) {
        covered++;
        continue;
      }
    }

    uncovered.push(refSeg);
  }

  return {
    rate: covered / segmentsWithTime.length,
    totalSegments: segmentsWithTime.length,
    coveredSegments: covered,
    uncoveredSegments: uncovered,
  };
}

// ---------------------------------------------------------------------------
// Silence Hallucination Rate
// ---------------------------------------------------------------------------

/**
 * Compute Silence Hallucination Rate: fraction of hypothesis finals whose startTime
 * falls at or beyond the speech end boundary.
 *
 * @param speechEndTimeSec - The time in audio-seconds where speech ends (e.g., 27.3s).
 */
export function computeHallucinationRate(hypothesisFinals: TranscriptFinal[], speechEndTimeSec: number): HallucinationResult {
  if (hypothesisFinals.length === 0) {
    return { rate: 0, totalFinals: 0, hallucinatedFinals: 0, hallucinatedTexts: [] };
  }

  const hallucinated = hypothesisFinals.filter((h) => h.startTime >= speechEndTimeSec);

  return {
    rate: hallucinated.length / hypothesisFinals.length,
    totalFinals: hypothesisFinals.length,
    hallucinatedFinals: hallucinated.length,
    hallucinatedTexts: hallucinated.map((h) => h.text),
  };
}
