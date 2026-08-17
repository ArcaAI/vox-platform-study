/**
 * `WorkflowDefinition` + node-registry API module (TASK-719 Task 10). Paths and OCC posture
 * verified against the DELIVERED `WorkflowDefinitionController`/`WorkflowNodeController`
 * (TASK-734) — see `docs/implementation/TASK-719-Workflow-Studio-V1/contracts/definition-api.contract.md`:
 * PATCH is If-Match OCC; `validate` and `publish` are confirmed NOT If-Match gated (the service
 * either self-CASes with the version it just read, or is not a CAS at all).
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createWorkflowDefinition,
  deleteWorkflowDefinition,
  getWorkflowDefinition,
  listPromptTemplateOptions,
  listWorkflowDefinitions,
  listWorkflowDefinitionVersions,
  listWorkflowNodes,
  publishWorkflowDefinition,
  updateWorkflowDefinition,
  validateWorkflowDefinition,
} from '../client';
import { workflowStudioKeys } from '../keys';
import type { WorkflowGraph } from '../types';

interface RecordedCall {
  url: string;
  method: string;
  body: unknown;
  headers: Record<string, string>;
}

function installFetchMock(): RecordedCall[] {
  const calls: RecordedCall[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      calls.push({
        url: String(input),
        method: init?.method ?? 'GET',
        body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined,
        headers: Object.fromEntries(new Headers(init?.headers).entries()),
      });
      return Response.json({ success: true });
    }),
  );
  return calls;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

const EMPTY_GRAPH: WorkflowGraph = { version: 1, nodes: [], edges: [] };

describe('workflowStudioKeys', () => {
  it('roots every key at ["workflow-studio"] and separates lists, details, versions and the registry', () => {
    expect(workflowStudioKeys.detail('d-1')).not.toEqual(workflowStudioKeys.versions('d-1'));
    expect(workflowStudioKeys.list()[0]).toBe('workflow-studio');
    expect(workflowStudioKeys.registry()[0]).toBe('workflow-studio');
    expect(workflowStudioKeys.registry()).not.toEqual(workflowStudioKeys.list());
    expect(workflowStudioKeys.promptTemplates()[0]).toBe('workflow-studio');
    expect(workflowStudioKeys.promptTemplates()).not.toEqual(workflowStudioKeys.registry());
  });
});

describe('workflow-studio client', () => {
  it('lists, creates, reads and lists versions of a definition', async () => {
    const calls = installFetchMock();
    await listWorkflowDefinitions();
    await createWorkflowDefinition({ slug: 'discharge_summary', name: 'Discharge Summary', paletteKey: 'summarization', graph: EMPTY_GRAPH });
    await getWorkflowDefinition('d-1');
    await listWorkflowDefinitionVersions('d-1');
    expect(calls.map((call) => `${call.method} ${call.url}`)).toEqual([
      'GET /api/hope/admin/workflow-definitions',
      'POST /api/hope/admin/workflow-definitions',
      'GET /api/hope/admin/workflow-definitions/d-1',
      'GET /api/hope/admin/workflow-definitions/d-1/versions',
    ]);
    expect(calls[1].body).toEqual({ slug: 'discharge_summary', name: 'Discharge Summary', paletteKey: 'summarization', graph: EMPTY_GRAPH });
  });

  it('PATCHes a draft with If-Match and the ETag-derived expectedVersion', async () => {
    const calls = installFetchMock();
    await updateWorkflowDefinition('d-1', { name: 'Renamed' }, '"3"');
    expect(calls.map((call) => `${call.method} ${call.url}`)).toEqual(['PATCH /api/hope/admin/workflow-definitions/d-1']);
    expect(calls[0].headers['if-match']).toBe('"3"');
    expect(calls[0].body).toEqual({ name: 'Renamed', expectedVersion: 3 });
  });

  it('soft-deletes a definition', async () => {
    const calls = installFetchMock();
    await deleteWorkflowDefinition('d-1');
    expect(calls.map((call) => `${call.method} ${call.url}`)).toEqual(['DELETE /api/hope/admin/workflow-definitions/d-1']);
  });

  it('validates WITHOUT an If-Match header (self-CAS, not a client CAS)', async () => {
    const calls = installFetchMock();
    await validateWorkflowDefinition('d-1');
    expect(calls.map((call) => `${call.method} ${call.url}`)).toEqual(['POST /api/hope/admin/workflow-definitions/d-1/validate']);
    expect(calls[0].headers['if-match']).toBeUndefined();
    expect(calls[0].body).toBeUndefined();
  });

  it('publishes WITHOUT an If-Match header (confirmed: not a CAS at all)', async () => {
    const calls = installFetchMock();
    await publishWorkflowDefinition('d-1', { activate: false });
    expect(calls.map((call) => `${call.method} ${call.url}`)).toEqual(['POST /api/hope/admin/workflow-definitions/d-1/publish']);
    expect(calls[0].headers['if-match']).toBeUndefined();
    expect(calls[0].body).toEqual({ activate: false });
  });

  it('reads the code-owned node registry from its own read-gated controller', async () => {
    const calls = installFetchMock();
    await listWorkflowNodes();
    expect(calls.map((call) => `${call.method} ${call.url}`)).toEqual(['GET /api/hope/admin/workflow-nodes']);
  });

  it('reads the tenant prompt-template catalog for the inspector picker (id + name only, Task 19)', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Response.json({ data: [{ id: 't-1', name: 'Discharge', category: 'ignored-field' }], count: 1 })),
    );
    const options = await listPromptTemplateOptions();
    expect(options).toEqual([{ id: 't-1', name: 'Discharge' }]);
    const [[url]] = vi.mocked(fetch).mock.calls;
    expect(String(url)).toContain('/api/hope/admin/prompt-templates');
  });
});
