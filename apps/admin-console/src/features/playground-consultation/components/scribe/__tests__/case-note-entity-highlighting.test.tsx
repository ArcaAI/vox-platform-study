/**
 * the case note must MARK detected entities in the running summary,
 * not merely list them as chips underneath it.
 */
import { cleanup, render } from '@testing-library/react';
import { axe } from 'vitest-axe';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type React from 'react';
import { CaseNoteColumn } from '../case-note-column';
import type { LiveSummarySnapshot } from '../../../api';

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

afterEach(cleanup);

const RUNNING = 'Patient reports chest pain. Started metformin 500mg twice daily.';

function live(overrides: Partial<LiveSummarySnapshot> = {}): LiveSummarySnapshot {
  return {
    consultationId: 'c-1',
    runningSummary: RUNNING,
    sections: [],
    entities: [
      { text: 'chest pain', type: 'CONDITION', start: 16, end: 26, icd10: 'R07.9' },
      { text: 'metformin', type: 'MEDICATION', start: 36, end: 45 },
    ],
    updatedAt: '2026-08-23T10:00:00.000Z',
    ...overrides,
  };
}

function props(overrides: Partial<React.ComponentProps<typeof CaseNoteColumn>> = {}): React.ComponentProps<typeof CaseNoteColumn> {
  return {
    hasConsultation: true,
    isRecording: true,
    live: live(),
    draft: null,
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

describe('CaseNoteColumn — entity highlighting (W3)', () => {
  it('marks detected entities inside the live running summary', () => {
    const { container } = render(<CaseNoteColumn {...props()} />);
    expect([...container.querySelectorAll('mark')].map((mark) => mark.textContent)).toEqual(['chest pain', 'metformin']);
  });

  it('names the entity class on each mark rather than relying on the tint', () => {
    const { container } = render(<CaseNoteColumn {...props()} />);
    expect((container.querySelector('mark') as HTMLElement).getAttribute('title')).toMatch(/CONDITION/);
  });

  it('leaves the text unmarked when the offsets do not verify against it', () => {
    const { container } = render(<CaseNoteColumn {...props({ live: live({ entities: [{ text: 'chest pain', type: 'CONDITION', start: 0, end: 5 }] }) })} />);
    expect(container.querySelectorAll('mark')).toHaveLength(0);
  });

  it('does NOT mark SOAP sections — the offsets index runningSummary, not a section', () => {
    const { container } = render(
      <CaseNoteColumn {...props({ live: live({ sections: [{ title: 'Subjective', content: 'Patient reports chest pain.' }] }) })} />,
    );
    expect(container.querySelectorAll('mark')).toHaveLength(0);
  });

  it('0 axe violations with entities marked', async () => {
    const { container } = render(<CaseNoteColumn {...props()} />);
    expect(await axe(container)).toHaveNoViolations();
  });
});
