/**
 * TASK-858 Lane D — the governing-workflow read-back line.
 *
 * The three states are the point: "we could not read it" must never render as "the platform
 * default engine governs", because dispatch is best-effort and those are genuinely different
 * facts about the consultation.
 */

import { cleanup, render, screen } from '@testing-library/react';
import { axe } from 'vitest-axe';
import { afterEach, describe, expect, it } from 'vitest';

import { GoverningWorkflowMeta, type GoverningWorkflow } from '../governing-workflow-meta';

const GOVERNED: GoverningWorkflow = {
  governed: true,
  workflowDefinitionSlug: 'arcaai_consultation_ner',
  name: 'Consultation with Medical NER',
  activeVersionNumber: 3,
};

afterEach(cleanup);

describe('GoverningWorkflowMeta', () => {
  it('renders nothing before a consultation is open', () => {
    const { container } = render(<GoverningWorkflowMeta workflow={null} hasConsultation={false} />);
    expect(container.textContent).toBe('');
  });

  it('names the governing workflow and its active version', () => {
    render(<GoverningWorkflowMeta workflow={GOVERNED} hasConsultation />);
    expect(screen.getByText(/Governed by Consultation with Medical NER/)).toBeTruthy();
    expect(screen.getByText(/v3/)).toBeTruthy();
  });

  it('falls back to the slug when the definition is no longer published (name null)', () => {
    render(<GoverningWorkflowMeta workflow={{ ...GOVERNED, name: null, activeVersionNumber: null }} hasConsultation />);
    expect(screen.getByText(/Governed by arcaai_consultation_ner/)).toBeTruthy();
    expect(screen.queryByText(/v\d/)).toBeNull();
  });

  it('says the default engine governs only when the server actually said so', () => {
    render(<GoverningWorkflowMeta workflow={{ ...GOVERNED, governed: false, workflowDefinitionSlug: null }} hasConsultation />);
    expect(screen.getByText('Default engine governs')).toBeTruthy();
  });

  it('reports an unresolved read as UNKNOWN, never as the default engine', () => {
    render(<GoverningWorkflowMeta workflow={null} hasConsultation />);
    expect(screen.getByText(/governing workflow unknown/i)).toBeTruthy();
    expect(screen.queryByText(/default engine governs/i)).toBeNull();
  });

  it('shows a skeleton while the first read is in flight', () => {
    const { container } = render(<GoverningWorkflowMeta workflow={null} isLoading hasConsultation />);
    expect(container.querySelector('[data-slot="skeleton"]')).not.toBeNull();
    expect(screen.queryByText(/governing workflow unknown/i)).toBeNull();
  });

  it('has no axe violations', async () => {
    const { container } = render(<GoverningWorkflowMeta workflow={GOVERNED} hasConsultation />);
    expect(await axe(container)).toHaveNoViolations();
  });
});
