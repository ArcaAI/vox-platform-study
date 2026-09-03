/**
 * Frame 32 — Agents & Prompt Templates API module. Paths and envelopes are
 * verified against apps/api PromptManagementController: OCC If-Match on
 * PATCH :id AND POST :id/test, the static analytics/usage + usage-records
 * routes, the :from/diff/:to version diff, and assign-department (which
 * carries the DEPARTMENT row's expectedVersion, not the template's).
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  activateVersion,
  assignDepartment,
  createTemplate,
  deleteTemplate,
  diffVersions,
  getTemplate,
  getUsageAnalytics,
  getUsageStats,
  getVersion,
  listDepartments,
  listTemplates,
  listUsageRecords,
  listVersions,
  finalizeTemplateTest,
  testTemplate,
  updateTemplate,
} from '../client';
import { promptTemplateKeys } from '../keys';

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

describe('promptTemplateKeys', () => {
  it('roots at ["agents"] and separates lists, details, versions and diffs', () => {
    expect(promptTemplateKeys.list({ page: 1 })).toEqual(promptTemplateKeys.list({ page: 1 }));
    expect(promptTemplateKeys.list({ page: 1 })).not.toEqual(promptTemplateKeys.list({ page: 2 }));
    expect(promptTemplateKeys.detail('pt-1')).not.toEqual(promptTemplateKeys.versions('pt-1'));
    expect(promptTemplateKeys.diff('pt-1', 6, 7)).not.toEqual(promptTemplateKeys.diff('pt-1', 5, 7));
    expect(promptTemplateKeys.usage('pt-1')).not.toEqual(promptTemplateKeys.analytics('pt-1'));
    expect(promptTemplateKeys.usageRecords({ promptTemplateId: 'pt-1' })[0]).toBe('agents');
    expect(promptTemplateKeys.departments()[0]).toBe('agents');
  });
});

describe('agents client', () => {
  it('lists (1-based page), creates, reads and soft-deletes templates', async () => {
    const calls = installFetchMock();
    await listTemplates({ search: 'soap', status: 'PUBLISHED', departmentId: 'd-1', page: 1, limit: 10 });
    await createTemplate({ name: 'SOAP Summary', content: 'You are a scribe.', category: 'SUMMARY' });
    await getTemplate('pt-1');
    await deleteTemplate('pt-1');
    expect(calls.map((call) => `${call.method} ${call.url}`)).toEqual([
      'GET /api/hope/admin/prompt-templates?search=soap&status=PUBLISHED&departmentId=d-1&page=1&limit=10',
      'POST /api/hope/admin/prompt-templates',
      'GET /api/hope/admin/prompt-templates/pt-1',
      'DELETE /api/hope/admin/prompt-templates/pt-1',
    ]);
    expect(calls[1].body).toEqual({ name: 'SOAP Summary', content: 'You are a scribe.', category: 'SUMMARY' });
  });

  it('PATCHes a template with If-Match and the ETag-derived expectedVersion', async () => {
    const calls = installFetchMock();
    await updateTemplate('pt-1', { content: 'Updated prompt body', changeReason: 'tighten wording' }, '"7"');
    expect(calls.map((call) => `${call.method} ${call.url}`)).toEqual(['PATCH /api/hope/admin/prompt-templates/pt-1']);
    expect(calls[0].headers['if-match']).toBe('"7"');
    expect(calls[0].body).toEqual({ content: 'Updated prompt body', changeReason: 'tighten wording', expectedVersion: 7 });
  });

  it('walks the version history: list, single version, :from/diff/:to and activate', async () => {
    const calls = installFetchMock();
    await listVersions('pt-1');
    await getVersion('pt-1', 6);
    await diffVersions('pt-1', 6, 7);
    await activateVersion('pt-1', 6);
    expect(calls.map((call) => `${call.method} ${call.url}`)).toEqual([
      'GET /api/hope/admin/prompt-templates/pt-1/versions',
      'GET /api/hope/admin/prompt-templates/pt-1/versions/6',
      'GET /api/hope/admin/prompt-templates/pt-1/versions/6/diff/7',
      'POST /api/hope/admin/prompt-templates/pt-1/versions/6/activate',
    ]);
  });

  /** BUG-018: the ack writes nothing, so it carries no If-Match. */
  it('runs a test as a non-writing ack: POST :id/test carries neither If-Match nor expectedVersion', async () => {
    const calls = installFetchMock();
    await testTemplate('pt-1', { sampleInput: 'Patient reports chest pain.' });
    expect(calls.map((call) => `${call.method} ${call.url}`)).toEqual(['POST /api/hope/admin/prompt-templates/pt-1/test']);
    expect(calls[0].headers['if-match']).toBeUndefined();
    expect(calls[0].body).toEqual({ sampleInput: 'Patient reports chest pain.' });
  });

  /** The OCC write moved here — finalize persists the score once the stream ends. */
  it('finalizes a test run as an OCC write: POST :id/test/finalize carries If-Match + expectedVersion', async () => {
    const calls = installFetchMock();
    await finalizeTemplateTest('pt-1', 'task-9', '"7"');
    expect(calls.map((call) => `${call.method} ${call.url}`)).toEqual(['POST /api/hope/admin/prompt-templates/pt-1/test/finalize']);
    expect(calls[0].headers['if-match']).toBe('"7"');
    expect(calls[0].body).toEqual({ taskId: 'task-9', expectedVersion: 7 });
  });

  it('reads usage: per-template stats, tenant analytics and raw run records (0-based page)', async () => {
    const calls = installFetchMock();
    await getUsageStats('pt-1');
    await getUsageAnalytics('pt-1');
    await getUsageAnalytics();
    await listUsageRecords({ page: 0, limit: 20, promptTemplateId: 'pt-1' });
    expect(calls.map((call) => `${call.method} ${call.url}`)).toEqual([
      'GET /api/hope/admin/prompt-templates/pt-1/usage',
      'GET /api/hope/admin/prompt-templates/analytics/usage?promptTemplateId=pt-1',
      'GET /api/hope/admin/prompt-templates/analytics/usage',
      'GET /api/hope/admin/prompt-templates/usage-records?page=0&limit=20&promptTemplateId=pt-1',
    ]);
  });

  it('assigns templates to a department slot with the Department row version', async () => {
    const calls = installFetchMock();
    await listDepartments();
    await assignDepartment({ departmentId: 'd-1', preSummaryPromptId: 'pt-1', expectedVersion: 3 });
    expect(calls.map((call) => `${call.method} ${call.url}`)).toEqual([
      'GET /api/hope/admin/departments',
      'POST /api/hope/admin/prompt-templates/assign-department',
    ]);
    expect(calls[1].body).toEqual({ departmentId: 'd-1', preSummaryPromptId: 'pt-1', expectedVersion: 3 });
  });
});
