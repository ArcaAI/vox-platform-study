/**
 * TASK-797 W1 (R2) — the editor must hand `StudioToolbar` the id of the row it is
 * editing, so the Workbench deep link lands on THAT definition. Without this the
 * toolbar affordance exists but always renders create-mode (no link), which is the
 * failure the ticket is closing.
 */
import { cleanup, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderWithProviders } from '@/test/render';
import { WorkflowStudioEditor } from '../workflow-studio-editor';
import type { WorkflowDefinition } from '../../api/types';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn(), back: vi.fn() }),
}));

vi.mock('sonner', () => ({
  toast: Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn() }),
}));

function definition(overrides: Partial<WorkflowDefinition> = {}): WorkflowDefinition {
  return {
    id: 'd-42',
    tenantId: 'tnt-1',
    slug: 'discharge_summary',
    name: 'Discharge Summary',
    description: null,
    paletteKey: 'summarization',
    versionNumber: 1,
    parentVersionId: null,
    status: 'DRAFT',
    graph: { version: 1, nodes: [], edges: [] },
    graphChecksum: 'chk',
    compiledConfig: null,
    compiledConfigChecksum: null,
    registryChecksum: null,
    validationReport: null,
    needsReview: false,
    validatedAt: null,
    publishedAt: null,
    deprecatedAt: null,
    isActive: false,
    resourceStatus: 'ENABLED',
    createdAt: '2026-08-16T10:00:00.000Z',
    updatedAt: '2026-08-16T10:00:00.000Z',
    version: 1,
    tags: [],
    ...overrides,
  };
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('WorkflowStudioEditor — Workbench deep link (TASK-797 W1)', () => {
  it('offers a sandbox test link for the definition being edited', () => {
    renderWithProviders(<WorkflowStudioEditor definition={definition()} etag='"1"' registryNodes={[]} />);

    expect(screen.getByRole('link', { name: /test in workbench/i }).getAttribute('href')).toBe('/playground/workbench?definitionId=d-42');
  });

  it('offers it on a PUBLISHED (read-only) version too', () => {
    renderWithProviders(<WorkflowStudioEditor definition={definition({ id: 'd-99', status: 'PUBLISHED' })} etag='"3"' registryNodes={[]} />);

    expect(screen.getByRole('link', { name: /test in workbench/i }).getAttribute('href')).toBe('/playground/workbench?definitionId=d-99');
  });
});
