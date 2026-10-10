/** TASK-1059 C-10 — Validate surfaces blocking findings and gates Publish. */
import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderWithProviders } from '@/test/render';
import type { Agent, AgentLineage } from '../../api/types';
import { AgentLineageDrawer } from '../agent-detail';

import { toast } from 'sonner';

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

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
    instruction: { promptTemplateId: 'tpl-1' },
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
    tags: ['specialty:general'],
    createdAt: '2026-09-01T10:00:00.000Z',
    updatedAt: '2026-09-02T10:00:00.000Z',
    createdBy: null,
    updatedBy: null,
    version: 1,
    ...overrides,
  };
}

const CATALOGUE = {
  providers: [{ id: 'hope', group: 'hope', name: 'Hope provider', providerClass: null, connectionId: null, usable: true, reason: null, modelCount: 1 }],
  models: [
    { id: 'm-1', slug: 'lms-gemma', name: 'Gemma 4 E2B', taskType: 'TEXT_GENERATION', providerId: 'hope', provider: 'lm-studio', providerClass: 'engine-served', readiness: 'ready', readinessCheckedAt: null, readinessDetail: null, usable: true, unusableReason: null },
  ],
};
const TEMPLATE = { id: 'tpl-1', name: 'SOAP note', status: 'APPROVED', category: 'SUMMARY', approvedVersionNumber: 2, currentVersionNumber: 2, contentPreview: 'Write a note', declaredVariables: [] };
const TENANT_DEFAULT_ROW = { id: 'as-1', tenantId: 'tnt-1', scope: 'TENANT', scopeId: null, task: 'TEXT_GENERATION', agentSlug: 'clinic-summarizer', selectorTags: [], version: 1, createdAt: '2026-09-01T10:00:00.000Z', updatedAt: '2026-09-01T10:00:00.000Z' };

/**
 * TASK-965 WS-4 — the drawer is keyed by the lineage SLUG, not by a version row id, so a test
 * hands it the lineage the grid would have. This folds the one fixture row into that shape.
 */
function lineageFor(row: Agent): AgentLineage {
  const open = row.status === 'DRAFT' || row.status === 'VALIDATED';
  return {
    slug: row.slug,
    name: row.name,
    task: row.task,
    versionCount: 1,
    latestVersionNumber: row.versionNumber,
    deprecatedCount: row.status === 'DEPRECATED' ? 1 : 0,
    active: row.isActive
      ? { id: row.id, versionNumber: row.versionNumber, publishedAt: row.publishedAt, publishedBy: row.updatedBy, modelSlug: row.modelSlug, compiledConfigChecksum: row.compiledConfigChecksum }
      : null,
    draft: open ? { id: row.id, versionNumber: row.versionNumber, status: row.status as 'DRAFT' | 'VALIDATED', updatedAt: row.updatedAt } : null,
    assignment: { tenantDefault: false, departmentCount: 0, selectorCount: 0 },
    origin: { sourceTenantId: row.sourceTenantId, sourceSlug: row.sourceSlug },
    tags: row.tags,
    updatedAt: row.updatedAt,
    hidden: false,
  };
}

function stubFetch(rows: Agent[], assignments: unknown[] = []) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL | Request) => {
      const path = new URL(String(input), 'http://test.local').pathname;
      for (const row of rows) {
        if (path === `/api/hope/admin/agents/${row.id}`) return Response.json(row, { headers: { etag: `"${row.version}"` } });
        if (path === `/api/hope/admin/agents/${row.id}/versions`) return Response.json(rows);
      }
      if (path === '/api/hope/admin/agent-assignments') return Response.json(assignments);
      if (path === '/api/hope/admin/departments') return Response.json({ data: [] });
      if (path === '/api/hope/admin/ai-models/catalogue') return Response.json(CATALOGUE);
      if (path === '/api/hope/admin/consultation-context-schemas') return Response.json([]);
      if (path === '/api/hope/admin/prompt-templates') return Response.json({ data: [TEMPLATE] });
      if (path === `/api/hope/admin/prompt-templates/${TEMPLATE.id}`) return Response.json(TEMPLATE);
      throw new Error(`Unhandled fetch: ${path}`);
    }),
  );
}


const BLOCKING = { checkedAt: '2026-09-02T10:00:00.000Z', blocking: true, findings: [{ severity: 'ERROR' as const, code: 'MODEL_UNUSABLE', path: 'modelId', message: 'Model is not ready' }] };

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
  cleanup();
});

describe('AgentLineageDrawer — blocking validation (C-10)', () => {
  it('disables Publish with a visible reason when the stored report blocks', async () => {
    const row = agent({ validationReport: BLOCKING });
    stubFetch([row]);
    renderWithProviders(<AgentLineageDrawer slug="clinic-summarizer" lineage={lineageFor(row)} onOpenChange={vi.fn()} />);

    expect(await screen.findByText(/Publish is disabled: Model is not ready/)).toBeTruthy();
    await waitFor(() => expect((screen.getByRole('button', { name: 'Publish' }) as HTMLButtonElement).disabled).toBe(true));
  });

  it('Validate toasts an error, not success, when the result is blocking', async () => {
    const row = agent();
    stubFetch([row]);
    const base = globalThis.fetch;
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const path = new URL(String(input), 'http://test.local').pathname;
      if (path === `/api/hope/admin/agents/${row.id}/validate`) return Response.json({ ...row, validationReport: BLOCKING });
      return base(input, init);
    }));
    renderWithProviders(<AgentLineageDrawer slug="clinic-summarizer" lineage={lineageFor(row)} onOpenChange={vi.fn()} />);

    const validateButton = await screen.findByRole('button', { name: 'Validate' });
    await waitFor(() => expect((validateButton as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(validateButton);

    await waitFor(() => expect(toast.error).toHaveBeenCalledWith(expect.stringContaining('Model is not ready')));
    expect(toast.success).not.toHaveBeenCalledWith('Validation complete');
  });
});
