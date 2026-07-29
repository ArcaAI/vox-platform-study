/**
 * TASK-552 Lane C — CitationEvidencePanel: click-to-source evidence panel.
 * Pure component; segment metadata comes from `useSummaryProvenance`, the
 * transcript text from `useTranscriptions` — both stubbed here as props.
 */

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { axe } from 'vitest-axe';
import { citationSnippet, CitationEvidencePanel } from '../citation-evidence-panel';
import type { CitedSegment } from '../../../api';

const TRANSCRIPT = 'Patient reports chest pain. History of hypertension noted by the doctor.';

const SEGMENTS: CitedSegment[] = [
  { id: 'seg-1', idx: 0, t0Ms: 0, t1Ms: 3000, speaker: 'patient', charStart: 0, charEnd: 27 },
  { id: 'seg-2', idx: 1, t0Ms: 65000, t1Ms: 70000, speaker: 'doctor', charStart: 28, charEnd: 57 },
];

afterEach(cleanup);

describe('citationSnippet', () => {
  it('slices [charStart, charEnd) out of the transcript text', () => {
    expect(citationSnippet(SEGMENTS[0], TRANSCRIPT)).toBe('Patient reports chest pain.');
  });

  it('returns null when the transcript text is unavailable', () => {
    expect(citationSnippet(SEGMENTS[0], null)).toBeNull();
    expect(citationSnippet(SEGMENTS[0], undefined)).toBeNull();
  });

  it('returns null when the offsets are missing or out of range', () => {
    expect(citationSnippet({ ...SEGMENTS[0], charStart: null }, TRANSCRIPT)).toBeNull();
    expect(citationSnippet({ ...SEGMENTS[0], charEnd: 9999 }, TRANSCRIPT)).toBeNull();
    expect(citationSnippet({ ...SEGMENTS[0], charStart: 10, charEnd: 5 }, TRANSCRIPT)).toBeNull();
  });
});

describe('CitationEvidencePanel', () => {
  it('renders nothing when there are no cited segments', () => {
    const { container } = render(<CitationEvidencePanel citedSegments={[]} transcriptText={TRANSCRIPT} />);
    expect(container.firstChild).toBeNull();
  });

  it('lists each cited segment with its speaker, formatted t0–t1, and snippet', () => {
    render(<CitationEvidencePanel citedSegments={SEGMENTS} transcriptText={TRANSCRIPT} />);

    expect(screen.getByText('patient')).toBeTruthy();
    expect(screen.getByText('doctor')).toBeTruthy();
    expect(screen.getByText('00:00–00:03')).toBeTruthy();
    expect(screen.getByText('01:05–01:10')).toBeTruthy();
    expect(screen.getByText('Patient reports chest pain.')).toBeTruthy();
    expect(screen.getByText('History of hypertension noted')).toBeTruthy();
  });

  it('shows a fallback when the snippet cannot be resolved (transcript not loaded yet)', () => {
    render(<CitationEvidencePanel citedSegments={SEGMENTS} transcriptText={null} />);
    expect(screen.getAllByText('Transcript span unavailable')).toHaveLength(2);
  });

  it('reports the clicked citation via onSelectCitation', () => {
    const onSelectCitation = vi.fn();
    render(<CitationEvidencePanel citedSegments={SEGMENTS} transcriptText={TRANSCRIPT} onSelectCitation={onSelectCitation} />);

    fireEvent.click(screen.getByText('Patient reports chest pain.'));

    expect(onSelectCitation).toHaveBeenCalledWith(SEGMENTS[0]);
  });

  it('marks the selected citation pressed for assistive tech', () => {
    render(<CitationEvidencePanel citedSegments={SEGMENTS} transcriptText={TRANSCRIPT} selectedSegmentId="seg-2" />);

    const buttons = screen.getAllByRole('button');
    expect(buttons[0].getAttribute('aria-pressed')).toBe('false');
    expect(buttons[1].getAttribute('aria-pressed')).toBe('true');
  });

  it('has no axe violations', async () => {
    const { container } = render(<CitationEvidencePanel citedSegments={SEGMENTS} transcriptText={TRANSCRIPT} />);
    expect(await axe(container)).toHaveNoViolations();
  });

  it('has no axe violations in the dark theme', async () => {
    document.documentElement.classList.add('dark');
    try {
      const { container } = render(<CitationEvidencePanel citedSegments={SEGMENTS} transcriptText={TRANSCRIPT} selectedSegmentId="seg-1" />);
      expect(await axe(container)).toHaveNoViolations();
    } finally {
      document.documentElement.classList.remove('dark');
    }
  });
});
