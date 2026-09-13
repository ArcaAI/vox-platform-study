/**
 * TASK-965 WS-1 (AG-6) — the "Make this the active version" switch starts ON every time the
 * dialog opens. It used to be one `useState(true)` on a component that stays mounted, so turning
 * it off once for agent A silently made every later publish default to inactive.
 */
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Agent } from '../../api/types';
import { AgentPublishDialog } from '../agent-publish-dialog';

function agent(): Agent {
  return {
    id: 'a-1',
    tenantId: 'tnt-1',
    slug: 'clinic-summarizer',
    name: 'Clinic summarizer',
    description: null,
    task: 'TEXT_GENERATION',
    versionNumber: 1,
    parentVersionId: null,
    sourceAgentId: null,
    sourceTenantId: null,
    sourceSlug: null,
    sourceVersionNumber: null,
    status: 'DRAFT',
    isActive: false,
    modelId: 'm-1',
    contextSchemaId: null,
    contextSchemaVersionNumber: null,
    modelSlug: 'lms-gemma',
    fallbacks: [],
    instruction: null,
    parameters: {},
    inputSchema: null,
    outputSchema: null,
    tools: null,
    compiledConfig: null,
    compiledConfigChecksum: null,
    validationReport: null,
    validatedAt: null,
    publishedAt: null,
    deprecatedAt: null,
    resourceStatus: 'ENABLED',
    tags: [],
    createdAt: '2026-09-01T10:00:00.000Z',
    updatedAt: '2026-09-02T10:00:00.000Z',
    createdBy: null,
    updatedBy: null,
    version: 1,
  };
}

afterEach(cleanup);

describe('AgentPublishDialog — the activate switch resets per open (TASK-965 WS-1, AG-6)', () => {
  it('starts ON again after being switched off, closed and reopened', () => {
    const { rerender } = render(<AgentPublishDialog open onOpenChange={vi.fn()} onConfirm={vi.fn()} agent={agent()} published={null} />);
    const toggle = () => screen.getByRole('switch', { name: /make this the active version/i });
    expect(toggle().getAttribute('aria-checked')).toBe('true');

    fireEvent.click(toggle());
    expect(toggle().getAttribute('aria-checked')).toBe('false');

    rerender(<AgentPublishDialog open={false} onOpenChange={vi.fn()} onConfirm={vi.fn()} agent={agent()} published={null} />);
    rerender(<AgentPublishDialog open onOpenChange={vi.fn()} onConfirm={vi.fn()} agent={agent()} published={null} />);

    expect(toggle().getAttribute('aria-checked')).toBe('true');
  });
});
