/**
 * Five of the six playground routes had no `error.tsx`, so a render throw anywhere in
 * consultation / dna-writing-style / live-transcription / llm / voice-profiles took down the whole
 * console shell instead of degrading to that one segment (rule 13: segment-scoped `error.tsx`).
 *
 * The sixth was `workbench`, which supplied the pattern. It is gone as of TASK-893 — running a
 * definition moved into the Workflow Studio's Run tab and the route is now a bare `redirect()`,
 * which has no render of its own to fail. These five are the whole playground surface now.
 */

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { axe } from 'vitest-axe';
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
  { name: 'llm', Component: LlmError, title: /llm playground failed to load/i },
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

  it('0 axe violations', async () => {
    const error = Object.assign(new Error('boom'), { digest: 'dg-1' });
    const { container } = render(<Component error={error} reset={vi.fn()} />);
    expect(await axe(container)).toHaveNoViolations();
  });
});
