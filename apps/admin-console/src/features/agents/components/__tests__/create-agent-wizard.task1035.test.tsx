/**
 * The wizard asks for the context schema ONCE, in step 1 (it decides what every later editor
 * suggests). TASK-1036 W2 removed the raw "Input / Output contract" step: a tenant sees the task's
 * inputs and outputs as a table on Settings instead.
 */
import { cleanup, fireEvent, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { axe } from 'vitest-axe';
import { renderWithProviders } from '@/test/render';
import { CreateAgentWizard } from '../create-agent-wizard';

const SCHEMAS = [{ id: 'schema-1', slug: 'visit', name: 'Visit context', status: 'PUBLISHED', pinnedVersionNumber: 1, isDefault: true }];

beforeEach(() => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes('/versions')) return Response.json([]);
      if (url.includes('admin/consultation-context-schemas')) return Response.json(SCHEMAS);
      return Response.json([]);
    }),
  );
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('CreateAgentWizard — one schema choice, named steps', () => {
  it('has no JSON-schema step at all — neither "Input / Output contract" nor "Schemas" (TASK-1036 W2)', async () => {
    renderWithProviders(<CreateAgentWizard open onOpenChange={() => undefined} onCreated={() => undefined} />);
    const steps = await screen.findByRole('list', { name: 'Steps' });
    expect(within(steps).queryByText(/Input \/ Output contract/)).toBeNull();
    expect(within(steps).queryByText(/\bSchemas\b/)).toBeNull();
  });

  it('asks for the context schema on step 1 for a text-generation agent, and not for other tasks', async () => {
    renderWithProviders(<CreateAgentWizard open onOpenChange={() => undefined} onCreated={() => undefined} />);
    const wizard = await screen.findByRole('dialog');
    expect(within(wizard).getByLabelText('Context schema')).toBeTruthy();
    fireEvent.click(within(wizard).getByLabelText('Speech-to-text'));
    expect(within(wizard).queryByLabelText('Context schema')).toBeNull();
  });

  it('has no axe violations on step 1', async () => {
    renderWithProviders(<CreateAgentWizard open onOpenChange={() => undefined} onCreated={() => undefined} />);
    const wizard = await screen.findByRole('dialog');
    expect(await axe(wizard)).toHaveNoViolations();
  });
});
