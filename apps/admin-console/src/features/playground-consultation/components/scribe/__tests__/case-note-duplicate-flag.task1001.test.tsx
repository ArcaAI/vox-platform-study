/**
 * TASK-1001 — the cross-section `duplicate` annotation in the console's live documents view.
 *
 * HOPE flags a run of sentences in one section that ANOTHER section of the same document already
 * carries: `{ kind: 'duplicate', start, end, duplicateOf, duplicateOfTitle }`. Owner decision
 * 2026-09-23: FLAG, NEVER DROP — so the console must say "Also in <title>" and leave the text whole.
 * Before this, the console's own kind list stopped at `flagged` (missing `finding` too) and nothing
 * in the view read section annotations at all.
 */

import { cleanup, render, screen } from '@testing-library/react';
import { axe } from 'vitest-axe';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { CaseNoteColumn } from '../case-note-column';
import {
  SECTION_ANNOTATION_KINDS,
  type DocumentSectionRecord,
  type DocumentSectionView,
  type SectionAnnotation,
} from '../../../api/document-sections';
import { foldHydratedDocumentSections } from '../../../api/hooks';

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

afterEach(cleanup);

const REPEATED = 'Many of the symptoms run in the family. Her mother had the same.';
const DIAGNOSIS_CONTENT = `Likely migraine without aura. ${REPEATED}`;

const DUPLICATE: SectionAnnotation = {
  kind: 'duplicate',
  start: DIAGNOSIS_CONTENT.indexOf(REPEATED),
  end: DIAGNOSIS_CONTENT.length,
  duplicateOf: 'family_history',
  duplicateOfTitle: 'Family History',
};

function section(overrides: Partial<DocumentSectionView>): DocumentSectionView {
  return { sectionKey: 'x', title: 'X', idx: 0, revision: 1, state: 'provisional', content: 'Text.', annotations: [], ...overrides };
}

function renderSections(sections: DocumentSectionView[]) {
  return render(
    <CaseNoteColumn
      hasConsultation
      isRecording
      live={null}
      draft={null}
      draftLoading={false}
      progress={null}
      assurance={null}
      onGenerate={vi.fn()}
      generatePending={false}
      onApprove={vi.fn()}
      approvePending={false}
      approved={false}
      documentSections={[{ documentKey: 'soap_note', sections }]}
    />,
  );
}

describe('TASK-1001 — section annotation kinds', () => {
  it('accepts every kind the gateway emits, `finding` and `duplicate` included', () => {
    expect(SECTION_ANNOTATION_KINDS).toEqual(['entity', 'groundedness', 'flagged', 'finding', 'duplicate']);
  });

  it('keeps a `duplicate` annotation, with what it repeats, through the durable-read fold', () => {
    const record: DocumentSectionRecord = {
      id: 'ds-1',
      consultationId: 'c-1',
      documentKey: 'soap_note',
      sectionKey: 'diagnosis',
      title: 'Diagnosis',
      idx: 1,
      state: 'provisional',
      revision: 3,
      version: 3,
      content: DIAGNOSIS_CONTENT,
      annotations: [DUPLICATE],
      createdAt: 't',
      updatedAt: 't',
    };
    const next = foldHydratedDocumentSections({}, [record]);
    expect(next['soap_note::diagnosis']?.annotations).toEqual([DUPLICATE]);
  });
});

describe('TASK-1001 — the duplicate flag in the live documents view', () => {
  it('flags the section as "Also in <title>" and leaves the repeated text in place', () => {
    renderSections([
      section({ sectionKey: 'family_history', title: 'Family History', idx: 0, content: REPEATED }),
      section({ sectionKey: 'diagnosis', title: 'Diagnosis', idx: 1, content: DIAGNOSIS_CONTENT, annotations: [DUPLICATE] }),
    ]);

    expect(screen.getByText(/also in family history/i)).toBeTruthy();
    // Flag, never drop: the diagnosis still carries the whole paragraph.
    expect(screen.getByText(DIAGNOSIS_CONTENT)).toBeTruthy();
  });

  it('is never colour alone — the flag carries words a screen reader can read', () => {
    renderSections([section({ sectionKey: 'diagnosis', title: 'Diagnosis', content: DIAGNOSIS_CONTENT, annotations: [DUPLICATE] })]);
    const flag = screen.getByText(/also in family history/i);
    expect(flag.textContent).toMatch(/repeat/i);
  });

  it('names the section by the HELD title when HOPE sent no `duplicateOfTitle`', () => {
    const { duplicateOfTitle: _omitted, ...untitled } = DUPLICATE;
    renderSections([
      section({ sectionKey: 'family_history', title: 'Family History', idx: 0, content: REPEATED }),
      section({ sectionKey: 'diagnosis', title: 'Diagnosis', idx: 1, content: DIAGNOSIS_CONTENT, annotations: [untitled] }),
    ]);
    expect(screen.getByText(/also in family history/i)).toBeTruthy();
  });

  it('still flags the span when the wire names no section at all', () => {
    renderSections([
      section({ sectionKey: 'diagnosis', title: 'Diagnosis', content: DIAGNOSIS_CONTENT, annotations: [{ kind: 'duplicate', start: 0, end: 5 }] }),
    ]);
    expect(screen.getByText(/also in another section/i)).toBeTruthy();
  });

  it('renders ONE flag per repeated section, however many spans point at it', () => {
    renderSections([
      section({
        sectionKey: 'diagnosis',
        title: 'Diagnosis',
        content: DIAGNOSIS_CONTENT,
        annotations: [DUPLICATE, { ...DUPLICATE, start: 0, end: 10 }],
      }),
    ]);
    expect(screen.getAllByText(/also in family history/i)).toHaveLength(1);
  });

  it('draws no duplicate flag for the other kinds', () => {
    renderSections([
      section({
        sectionKey: 'diagnosis',
        title: 'Diagnosis',
        content: DIAGNOSIS_CONTENT,
        annotations: [
          { kind: 'entity', start: 0, end: 8, type: 'CONDITION' },
          { kind: 'finding', start: 0, end: 8, type: 'important' },
        ],
      }),
    ]);
    expect(screen.queryByText(/also in/i)).toBeNull();
  });

  it('has no axe violations with a flag rendered', async () => {
    const { container } = renderSections([
      section({ sectionKey: 'family_history', title: 'Family History', idx: 0, content: REPEATED }),
      section({ sectionKey: 'diagnosis', title: 'Diagnosis', idx: 1, content: DIAGNOSIS_CONTENT, annotations: [DUPLICATE] }),
    ]);
    expect(await axe(container)).toHaveNoViolations();
  });
});
