/**
 * TASK-814 — five of the six playground routes had no `error.tsx` (only `workbench` did),
 * so a render throw anywhere in consultation / dna-writing-style / live-transcription / llm /
 * voice-profiles took down the whole console shell instead of degrading to that one segment
 * (rule 13: segment-scoped `error.tsx`, same pattern `workbench/error.tsx` already ships).
 */

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import ConsultationError from '../consultation/error';
import DnaWritingStyleError from '../dna-writing-style/error';
import LiveTranscriptionError from '../live-transcription/error';
import LlmError from '../llm/error';
import VoiceProfilesError from '../voice-profiles/error';

afterEach(cleanup);

const CASES: Array<{ name: string; Component: typeof ConsultationError; title: RegExp }> = [
  { name: 'consultation', Component: ConsultationError, title: /consultation scribe failed to load/i },
  { name: 'dna-writing-style', Component: DnaWritingStyleError, title: /dna writing style failed to load/i },
  { name: 'live-transcription', Component: LiveTranscriptionError, title: /live transcription failed to load/i },
  { name: 'llm', Component: LlmError, title: /agent playground failed to load/i },
  { name: 'voice-profiles', Component: VoiceProfilesError, title: /voice enrollment.*failed to load/i },
];

describe.each(CASES)('playground/$name/error.tsx', ({ Component, title }) => {
  it('names the failed screen and offers Try again', () => {
    const error = Object.assign(new Error('boom'), { digest: 'dg-1' });
    render(<Component error={error} reset={vi.fn()} />);
    expect(screen.getByText(title)).toBeTruthy();
    expect(screen.getByRole('button', { name: /try again/i })).toBeTruthy();
  });

  it('calls reset() when "Try again" is clicked', () => {
    const reset = vi.fn();
    const error = Object.assign(new Error('boom'), { digest: 'dg-1' });
    render(<Component error={error} reset={reset} />);
    fireEvent.click(screen.getByRole('button', { name: /try again/i }));
    expect(reset).toHaveBeenCalledTimes(1);
  });
});
