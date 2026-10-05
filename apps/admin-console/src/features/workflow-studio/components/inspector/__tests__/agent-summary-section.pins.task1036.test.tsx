/**
 * TASK-1036 W3 / OD-7 — the `core.agent` summary names what the node is PINNED to, and the
 * agent-level extras that used to live on the node: the document template and the DNA switch.
 */
import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

vi.mock('@/shared/catalog', () => ({ useModelCatalogue: () => ({ data: { models: [] }, isPending: false, isError: false }) }));

import { AgentSummarySection } from '../agent-summary-section';
import type { AgentOption } from '../../../api/types';

const AGENT: AgentOption = {
  slug: 'clinic-summary',
  name: 'Clinic summary',
  task: 'TEXT_GENERATION',
  versionNumber: 4,
  status: 'PUBLISHED',
  modelSlug: 'gemma-3',
  instruction: { promptTemplateId: 'tpl-1', promptVersionNumber: 3, documentTemplate: { slug: 'soap' } } as AgentOption['instruction'],
  parameters: { dna: { enabled: true } },
};

describe('AgentSummarySection pins', () => {
  it('shows the version this node is pinned to, and that a newer one exists', () => {
    render(<AgentSummarySection agent={AGENT} config={{ agentRef: { slug: 'clinic-summary', versionNumber: 3 } }} />);
    expect(screen.getByTestId('agent-pin').textContent).toMatch(/Pinned to v3/);
    expect(screen.getByTestId('agent-pin').textContent).toMatch(/v4 is available/);
  });

  it('shows no pin row for a node that carries no pin yet', () => {
    render(<AgentSummarySection agent={AGENT} config={{ agentRef: { slug: 'clinic-summary' } }} />);
    expect(screen.queryByTestId('agent-pin')).toBeNull();
  });

  it('says a node pinned to the current version has nothing newer', () => {
    render(<AgentSummarySection agent={AGENT} config={{ agentRef: { slug: 'clinic-summary', versionNumber: 4 } }} />);
    expect(screen.getByTestId('agent-pin').textContent).toMatch(/Pinned to v4/);
    expect(screen.getByTestId('agent-pin').textContent).not.toMatch(/available/);
  });

  it('lists the prompt pin, the document template (always latest) and DNA, from the agent', () => {
    render(<AgentSummarySection agent={AGENT} config={{}} />);
    expect(screen.getByTestId('agent-prompt-pin').textContent).toMatch(/v3/);
    expect(screen.getByTestId('agent-document-template').textContent).toMatch(/soap.*latest/i);
    expect(screen.getByTestId('agent-dna').textContent).toMatch(/on/i);
  });
});
