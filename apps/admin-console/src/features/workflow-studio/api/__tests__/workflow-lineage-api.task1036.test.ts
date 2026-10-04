/**
 * TASK-1036 §3.3/§3.4 — the lineage register + lifecycle client for the workflow management screen.
 * Paths verified against `WorkflowDefinitionController` (lineages / tags / :id/draft / activate /
 * deprecate). fetch is stubbed at the network boundary.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  activateDefinition,
  createDraftFrom,
  deprecateDefinition,
  listWorkflowLineages,
  listWorkflowTags,
} from '../client';
import { workflowStudioKeys } from '../keys';

interface RecordedCall {
  url: string;
  method: string;
  body: unknown;
}

function installFetchMock(): RecordedCall[] {
  const calls: RecordedCall[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(input), method: init?.method ?? 'GET', body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined });
      return Response.json({ ok: true });
    }),
  );
  return calls;
}

afterEach(() => vi.unstubAllGlobals());

describe('workflow lineage client (TASK-1036)', () => {
  it('reads the lineage register, the tag suggestions and drives the lifecycle verbs on the right paths', async () => {
    const calls = installFetchMock();
    await listWorkflowLineages({ page: 1, limit: 25, search: 'dis', searchFields: 'slug' });
    await listWorkflowTags('card');
    await createDraftFrom('d 1');
    await activateDefinition('d-1');
    await deprecateDefinition('d-1');
    expect(calls.map((call) => `${call.method} ${call.url}`)).toEqual([
      'GET /api/hope/admin/workflow-definitions/lineages?page=1&limit=25&search=dis&searchFields=slug',
      'GET /api/hope/admin/workflow-definitions/tags?q=card',
      'POST /api/hope/admin/workflow-definitions/d%201/draft',
      'POST /api/hope/admin/workflow-definitions/d-1/activate',
      'POST /api/hope/admin/workflow-definitions/d-1/deprecate',
    ]);
  });

  it('keeps lineage and tag reads under the studio key root so one invalidation refreshes them', () => {
    expect(workflowStudioKeys.lineages({ page: 1 })[0]).toBe('workflow-studio');
    expect(workflowStudioKeys.lineages()).not.toEqual(workflowStudioKeys.list());
    expect(workflowStudioKeys.tags('x')[0]).toBe('workflow-studio');
  });
});
