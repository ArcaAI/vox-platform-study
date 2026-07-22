/**
 * TranscriptionPipeline.getRawInputTrack (dual-capture X8)
 *
 * The dual-capture flow records the RAW input track alongside the processed
 * output (`getProcessedTrack`). This verifies the new accessor returns the
 * unprocessed source track regardless of enabled stages.
 *
 * @vitest-environment jsdom
 */

import { describe, it, expect } from 'vitest';
import { TranscriptionPipeline } from '../TranscriptionPipeline';

describe('TranscriptionPipeline.getRawInputTrack', () => {
  it('returns null before any input is attached', () => {
    const pipeline = new TranscriptionPipeline();
    expect(pipeline.getRawInputTrack()).toBeNull();
  });

  it('returns the raw input track once attached, independent of processing stages', () => {
    const pipeline = new TranscriptionPipeline();
    const rawTrack = { id: 'raw', kind: 'audio' } as unknown as MediaStreamTrack;
    // White-box: set the current input the same way the pipeline does on process().
    (pipeline as any).currentInput = { track: rawTrack };
    expect(pipeline.getRawInputTrack()).toBe(rawTrack);
  });
});
