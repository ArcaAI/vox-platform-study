/**
 * TASK-1036 (OD-4) — `WorkflowEntryGateService`: does the workflow VERSION a run belongs to admit
 * an entry (`socket`, …) under its effective settings? Legacy definitions (no settings) are
 * unrestricted here, exactly as the invoke path treats them.
 */
import { describe, expect, it, vi } from 'vitest';
import { BadRequestException } from '@nestjs/common';
import { WorkflowEntryGateService } from '../workflow-entry-gate.service';

const TENANT = '50000000-0000-0000-0000-000000000001';

function definition(settings?: { connections: string[]; sources: string[] }) {
  const stages = [{ stageIndex: 0, nodes: [] }];
  return { compiledConfig: { stages, ...(settings ? { settings } : {}) }, graph: { nodes: [], edges: [] } };
}

function make(row: unknown, active: unknown = null) {
  const repository = {
    findPublishedBySlugVersion: vi.fn(async () => row),
    findPublishedBySlug: vi.fn(async () => active),
  };
  const cls = { get: vi.fn(() => TENANT) };
  return { service: new WorkflowEntryGateService(repository as never, cls as never), repository };
}

describe('WorkflowEntryGateService.assertEntryAllowed', () => {
  it('passes when the frozen settings admit the entry', async () => {
    const { service } = make(definition({ connections: ['api', 'socket'], sources: [] }));
    await expect(service.assertEntryAllowed('report', 3, 'socket')).resolves.toBeUndefined();
  });

  it('refuses with 400 MODE_UNSUPPORTED when they do not', async () => {
    const { service } = make(definition({ connections: ['api', 'sse'], sources: [] }));
    await expect(service.assertEntryAllowed('report', 3, 'socket')).rejects.toBeInstanceOf(BadRequestException);
    await expect(service.assertEntryAllowed('report', 3, 'socket')).rejects.toMatchObject({ response: { code: 'MODE_UNSUPPORTED' } });
  });

  it('reads the run’s own version, then the tenant-scoped active one for a version that is no longer PUBLISHED', async () => {
    const { service, repository } = make(null, definition({ connections: ['socket'], sources: [] }));
    await service.assertEntryAllowed('report', 3, 'socket');
    expect(repository.findPublishedBySlugVersion).toHaveBeenCalledWith(TENANT, 'report', 3);
    expect(repository.findPublishedBySlug).toHaveBeenCalledWith(TENANT, 'report');
  });

  it('does not gate a definition with no settings at all (legacy, D-4) or an unreadable one', async () => {
    const legacy = make({ compiledConfig: null, graph: { nodes: [{ id: 'a', type: 'webhook-legacy', config: {} }] } });
    await expect(legacy.service.assertEntryAllowed('report', 3, 'socket')).resolves.toBeUndefined();
    const absent = make(null, null);
    await expect(absent.service.assertEntryAllowed('report', 3, 'socket')).resolves.toBeUndefined();
  });
});
