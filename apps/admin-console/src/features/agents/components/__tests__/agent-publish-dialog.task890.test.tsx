/**
 * TASK-890 §3.8/§3.9 — the agent publish dialog: a confirm step, then (once published) the
 * resolved endpoint, the `@arcaai/vox-node` snippet, and the `/api-keys` link.
 */
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { axe } from 'vitest-axe';
import type { Agent } from '../../api/types';
import { AgentPublishDialog } from '../agent-publish-dialog';

function agent(overrides: Partial<Agent> = {}): Agent {
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
    ...overrides,
  };
}

afterEach(cleanup);

describe('AgentPublishDialog', () => {
  it('confirms with the activate switch on by default', () => {
    const onConfirm = vi.fn();
    render(<AgentPublishDialog open onOpenChange={() => undefined} onConfirm={onConfirm} agent={agent()} published={null} />);
    fireEvent.click(screen.getByRole('button', { name: 'Publish' }));
    expect(onConfirm).toHaveBeenCalledWith(true);
  });

  it('once published, shows the invocation endpoint, the vox-node snippet, and the api-keys link', () => {
    render(<AgentPublishDialog open onOpenChange={() => undefined} onConfirm={() => undefined} agent={agent()} published={agent({ status: 'PUBLISHED', isActive: true })} />);
    expect(screen.getByText(/POST \/agents\/clinic-summarizer\/invocations/)).toBeTruthy();
    expect(screen.getByText(/hope\.agents\.invoke/)).toBeTruthy();
    expect(screen.getByRole('link', { name: /Mint an API key/ })).toHaveProperty('href', expect.stringContaining('/api-keys'));
  });

  it('a speech-to-text agent shows the transcriptions endpoint', () => {
    render(<AgentPublishDialog open onOpenChange={() => undefined} onConfirm={() => undefined} agent={agent()} published={agent({ status: 'PUBLISHED', isActive: true, task: 'SPEECH_TO_TEXT' })} />);
    expect(screen.getAllByText(/POST \/agents\/clinic-summarizer\/transcriptions/).length).toBeGreaterThan(0);
    // The panel opens on the Realtime job for a speech-to-text agent (TASK-983); the batch SDK
    // call lives under Node → Batch.
    const node = screen.getByRole('tab', { name: 'Node' });
    fireEvent.mouseDown(node);
    fireEvent.click(node);
    const jobList = screen.getAllByRole('tablist').find((list) => within(list).queryByRole('tab', { name: 'Batch' }) !== null);
    if (!jobList) throw new Error('no Batch job view');
    const batch = within(jobList).getByRole('tab', { name: 'Batch' });
    fireEvent.mouseDown(batch);
    fireEvent.click(batch);
    expect(screen.getAllByText(/hope\.agents\.transcribe/).length).toBeGreaterThan(0);
  });

  it('has no axe violations, confirming or published (WCAG 2.2 AA gate)', async () => {
    const confirming = render(<AgentPublishDialog open onOpenChange={() => undefined} onConfirm={() => undefined} agent={agent()} published={null} />);
    expect(await axe(confirming.container)).toHaveNoViolations();
    confirming.unmount();
    const done = render(<AgentPublishDialog open onOpenChange={() => undefined} onConfirm={() => undefined} agent={agent()} published={agent({ status: 'PUBLISHED', isActive: true })} />);
    expect(await axe(done.container)).toHaveNoViolations();
  });
});
