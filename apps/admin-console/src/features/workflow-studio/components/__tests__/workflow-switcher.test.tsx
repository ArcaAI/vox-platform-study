/**
 * `WorkflowSwitcher` — TASK-893 OD-1. With the definitions grid deleted, this combobox is the
 * ONLY way to reach another workflow from inside the studio, so it has to name the open one even
 * when the list page it reads does not contain it.
 *
 * TASK-973 RC-2: `GET admin/workflow-definitions` takes a `search`/`searchFields` filter
 * (`ListWorkflowDefinitionsQuery extends PaginatedQuery`), so typing in the combobox must hit the
 * server (debounced) rather than only re-filtering the first `PAGE_SIZE` rows already in memory.
 */
import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { axe } from 'vitest-axe';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderWithProviders } from '@/test/render';
import { WorkflowSwitcher } from '../workflow-switcher';
import type { WorkflowDefinition } from '../../api/types';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn(), back: vi.fn() }),
}));

const BASE = '/api/hope/admin/workflow-definitions';

function queryOf(url: string): URLSearchParams {
  return new URL(url, 'http://localhost').searchParams;
}

function definition(overrides: Partial<WorkflowDefinition> = {}): WorkflowDefinition {
  return {
    id: 'd-1',
    tenantId: 'tnt-1',
    slug: 'discharge_summary',
    name: 'Discharge Summary',
    description: null,
    paletteKey: 'summarization',
    versionNumber: 3,
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

describe('WorkflowSwitcher', () => {
  it('names the open workflow and its version on a labelled combobox', () => {
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ data: [], count: 0 })));
    renderWithProviders(<WorkflowSwitcher current={definition()} />);

    const trigger = screen.getByRole('combobox', { name: /switch workflow/i });
    expect(trigger.textContent).toContain('Discharge Summary');
    expect(trigger.textContent).toContain('v3');
  });

  it('0 axe violations', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ data: [], count: 0 })));
    const { container } = renderWithProviders(<WorkflowSwitcher current={definition()} />);
    expect(await axe(container)).toHaveNoViolations();
  });

  it('searches the server (debounced) instead of only the loaded page — RC-2', async () => {
    const calls: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        calls.push(String(input));
        return Response.json({ data: [definition()], count: 1 });
      }),
    );
    renderWithProviders(<WorkflowSwitcher current={definition()} />);

    fireEvent.click(screen.getByRole('combobox', { name: /switch workflow/i }));
    const input = await screen.findByPlaceholderText('Search workflows by name or slug…');

    calls.length = 0;
    fireEvent.change(input, { target: { value: 'discharge' } });

    // Debounced (300ms) — the request carries `search` + the two scalar `String`
    // columns (`name`, `slug`) the search targets, never the `status` enum column.
    await waitFor(() => {
      const call = calls.find((url) => url.startsWith(BASE));
      expect(call).toBeDefined();
      const params = queryOf(call!);
      expect(params.get('search')).toBe('discharge');
      expect(params.get('searchFields')).toBe('name,slug');
    });
  });
});
