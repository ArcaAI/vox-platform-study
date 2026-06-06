/**
 * TranscriptPane (TASK-330 Phase 1, Lane J)
 *
 * Pure presentational test: given pre-computed highlight segments, the pane
 * marks highlighted spans, surfaces the no-provenance warning for claims
 * without evidence, and prompts to select a claim when nothing is chosen.
 *
 * `@arcaai/vox` is only imported as a (compile-time) type here, so no SDK mock
 * is needed; the ui-playground vitest config stubs `@arcaai/ui/*`, so the card
 * + scroll-area primitives are mocked.
 *
 * @vitest-environment jsdom
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';

vi.mock('@arcaai/ui/card', () => ({
  Card: ({ children, ...p }: any) => <div {...p}>{children}</div>,
  CardContent: ({ children, ...p }: any) => <div {...p}>{children}</div>,
  CardHeader: ({ children, ...p }: any) => <div {...p}>{children}</div>,
  CardTitle: ({ children, ...p }: any) => <div {...p}>{children}</div>,
}));
vi.mock('@arcaai/ui/scroll-area', () => ({
  ScrollArea: ({ children, ...p }: any) => <div {...p}>{children}</div>,
}));

import { TranscriptPane, type TranscriptHighlightPane } from '../transcript-pane';
import type { CitationClaim } from '@arcaai/vox';

function claim(overrides: Partial<CitationClaim> = {}): CitationClaim {
  return {
    id: 'c1',
    text: 'a claim',
    section: 'S',
    status: 'verified',
    confidence: 0.9,
    evidence: [{ transcriptContextItemId: 't1', startOffset: 0, endOffset: 5, quote: 'chest' }],
    entityRefs: [],
    knowledgeChunkIds: [],
    ...overrides,
  };
}

const highlightedPane: TranscriptHighlightPane = {
  contextItemId: 't1',
  label: 'Live transcription',
  segments: [
    { text: 'The patient has ', highlighted: false },
    { text: 'chest pain', highlighted: true },
    { text: ' today.', highlighted: false },
  ],
  hasHighlight: true,
};

describe('TranscriptPane', () => {
  it('marks highlighted evidence spans and keeps surrounding text plain', () => {
    render(<TranscriptPane panes={[highlightedPane]} selectedClaim={claim()} />);

    const marks = document.querySelectorAll('[data-highlight="true"]');
    expect(marks).toHaveLength(1);
    expect(marks[0].textContent).toBe('chest pain');
    // full text is still present (round-trips around the highlight)
    expect(screen.getByText(/The patient has/)).toBeInTheDocument();
    expect(screen.getByText(/today\./)).toBeInTheDocument();
  });

  it('warns when the selected claim has no linked evidence', () => {
    const noEvidencePane: TranscriptHighlightPane = {
      contextItemId: 't1',
      segments: [{ text: 'full transcript text', highlighted: false }],
      hasHighlight: false,
    };
    render(<TranscriptPane panes={[noEvidencePane]} selectedClaim={claim({ status: 'unverified', evidence: [] })} />);

    expect(screen.getByText(/no linked transcript evidence/i)).toBeInTheDocument();
    expect(screen.getByText(/no provenance/i)).toBeInTheDocument();
    expect(document.querySelectorAll('[data-highlight="true"]')).toHaveLength(0);
  });

  it('prompts to select a claim when nothing is selected', () => {
    const plainPane: TranscriptHighlightPane = {
      contextItemId: 't1',
      segments: [{ text: 'full transcript text', highlighted: false }],
      hasHighlight: false,
    };
    render(<TranscriptPane panes={[plainPane]} selectedClaim={null} />);

    expect(screen.getByText(/select a claim to highlight/i)).toBeInTheDocument();
    expect(screen.getByText('full transcript text')).toBeInTheDocument();
  });
});
