/**
 * entities must survive the end of recording.
 *
 * While recording, entities ride the live-summary SSE snapshot. Once a persisted draft
 * exists the snapshot is gone and, before this, so was every entity: the console showed
 * nothing. `GET :id/named-entities` and its client hook `useNamedEntities` already
 * existed — with ZERO callers anywhere in the feature — so the aggregate the NLP service
 * had already computed and persisted was simply never read.
 *
 * `AggregateNerResponse` carries no offsets into the draft's content, so these render as
 * a grouped chip list, NOT inline marks. Marking them would require guessing offsets by
 * searching the text, which is exactly what `lib/entity-highlights.ts` refuses to do.
 */
import { cleanup, render, screen } from '@testing-library/react';
import { axe } from 'vitest-axe';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type React from 'react';
import { CaseNoteColumn } from '../case-note-column';
import type { NamedEntitiesAggregate, SummaryResult } from '../../../api';

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

afterEach(cleanup);

const DRAFT: SummaryResult = {
  id: 'ctx-9',
  consultationId: 'c-1',
  type: 'summary',
  content: 'S: Follow-up for hypertension. Improving.',
  version: 1,
};

const AGGREGATE: NamedEntitiesAggregate = {
  consultationId: 'c-1',
  scope: 'single',
  entities: {
    CONDITION: [{ text: 'hypertension', displayText: 'hypertension' }],
    MEDICATION: [{ text: 'lisinopril' }, { text: 'amlodipine' }],
  },
  totalCount: 3,
  countByClass: { CONDITION: 1, MEDICATION: 2 },
  sources: [],
};

function props(overrides: Partial<React.ComponentProps<typeof CaseNoteColumn>> = {}): React.ComponentProps<typeof CaseNoteColumn> {
  return {
    hasConsultation: true,
    isRecording: false,
    live: null,
    draft: DRAFT,
    draftLoading: false,
    progress: null,
    assurance: null,
    onGenerate: vi.fn(),
    generatePending: false,
    onApprove: vi.fn(),
    approvePending: false,
    approved: false,
    ...overrides,
  };
}

describe('CaseNoteColumn — persisted entities (W3)', () => {
  it('lists the persisted named entities alongside a draft', () => {
    render(<CaseNoteColumn {...props({ namedEntities: AGGREGATE })} />);
    expect(screen.getByText('hypertension')).toBeTruthy();
    expect(screen.getByText('lisinopril')).toBeTruthy();
    expect(screen.getByText('amlodipine')).toBeTruthy();
  });

  it('names the entity class for each group, so class is not carried by colour', () => {
    render(<CaseNoteColumn {...props({ namedEntities: AGGREGATE })} />);
    expect(screen.getByText(/CONDITION/)).toBeTruthy();
    expect(screen.getByText(/MEDICATION/)).toBeTruthy();
  });

  it('renders nothing when the aggregate is empty rather than an empty labelled box', () => {
    const { container } = render(<CaseNoteColumn {...props({ namedEntities: { ...AGGREGATE, entities: {}, totalCount: 0, countByClass: {} } })} />);
    expect(container.querySelector('[aria-label="Detected entities in this consultation"]')).toBeNull();
  });

  it('renders nothing when no aggregate was fetched', () => {
    const { container } = render(<CaseNoteColumn {...props()} />);
    expect(container.querySelector('[aria-label="Detected entities in this consultation"]')).toBeNull();
  });

  it('0 axe violations', async () => {
    const { container } = render(<CaseNoteColumn {...props({ namedEntities: AGGREGATE })} />);
    expect(await axe(container)).toHaveNoViolations();
  });
});
