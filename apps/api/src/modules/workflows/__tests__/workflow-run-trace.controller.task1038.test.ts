/**
 * TASK-1038 B3a deliverable 3 — `GET admin/workflow-runs/:runId/trace/stream`: the ADMIN TRACE
 * of any run (sandbox or real) of the caller's working tenant — every stored v2 event, with
 * resume. Console only: `@ForbidApiKey()`, `@ForbidServiceAccount()`, and an imperative
 * super/tenant-admin gate that runs BEFORE the run is resolved (row-independent 403), while a
 * foreign or unknown run stays the house 404.
 */
import 'reflect-metadata';
import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { describe, expect, it, vi } from 'vitest';
import { API_KEY_FORBIDDEN, REQUIRED_PERMISSIONS_KEY, SERVICE_ACCOUNT_FORBIDDEN } from '@arcaai/applications';
import { STREAM_SCOPE_METADATA } from '../../auth/decorators/stream-scope.decorator';
import { WorkflowRunTraceController } from '../workflow-run-trace.controller';

const TENANT = '10000000-0000-0000-0000-000000000001';
const run = { runId: 'R', workflowSlug: 'flow', workflowVersionNumber: 3, status: 'RUNNING', startedAt: '2026-10-04T10:00:00.000Z', endedAt: null, isSandbox: true };

function build(overrides: { access?: () => Promise<void>; getRun?: () => Promise<unknown>; tenantId?: string | null } = {}) {
  const access = { assertCanTrace: vi.fn(overrides.access ?? (async () => undefined)) };
  const runs = { getRun: vi.fn(overrides.getRun ?? (async () => run)) };
  const stream = { streamRun: vi.fn(async (input: { readStatus: () => Promise<unknown> }) => input.readStatus()) };
  const cls = {
    get: vi.fn((key: string) => {
      if (key === 'tenantId') return overrides.tenantId === undefined ? TENANT : overrides.tenantId;
      if (key === 'user') return { id: 'u1' };
      return undefined;
    }),
  };
  const controller = new WorkflowRunTraceController(runs as never, access as never, stream as never, cls as never);
  return { controller, access, runs, stream };
}

describe('WorkflowRunTraceController', () => {
  it('is console-only: ForbidApiKey + ForbidServiceAccount + read:WorkflowRun + the workflow_run stream ticket', () => {
    const reflector = new Reflector();
    const handler = WorkflowRunTraceController.prototype.streamTrace;
    expect(reflector.getAllAndOverride(API_KEY_FORBIDDEN, [handler, WorkflowRunTraceController])).toBe(true);
    expect(reflector.getAllAndOverride(SERVICE_ACCOUNT_FORBIDDEN, [handler, WorkflowRunTraceController])).toBe(true);
    expect(reflector.getAllAndOverride(REQUIRED_PERMISSIONS_KEY, [handler, WorkflowRunTraceController])).toEqual([{ action: 'read', subject: 'WorkflowRun' }]);
    expect(reflector.getAllAndOverride(STREAM_SCOPE_METADATA, [handler, WorkflowRunTraceController])).toEqual({ namespace: 'workflow_run', param: 'runId' });
  });

  it('streams the ADMIN plane in protocol v2 with the cursor, reading status from the run read model', async () => {
    const { controller, stream, runs } = build();
    const res = {};
    await controller.streamTrace('R', res as never, '7', undefined);

    expect(stream.streamRun).toHaveBeenCalledWith(expect.objectContaining({ runId: 'R', res, plane: 'admin', protocol: '2', lastEventId: '7' }));
    const status = await stream.streamRun.mock.results[0].value;
    expect(status).toMatchObject({ runId: 'R', slug: 'flow', workflowVersionNumber: 3, status: 'RUNNING' });
    expect(runs.getRun).toHaveBeenCalledWith(TENANT, 'R');
  });

  it('the admin gate runs FIRST: a non-admin gets 403 and the run is never looked up', async () => {
    const { controller, runs, stream } = build({ access: async () => Promise.reject(new ForbiddenException()) });
    await expect(controller.streamTrace('R', {} as never)).rejects.toBeInstanceOf(ForbiddenException);
    expect(runs.getRun).not.toHaveBeenCalled();
    expect(stream.streamRun).not.toHaveBeenCalled();
  });

  it('a foreign or unknown run is the house 404 (from the read model, before any header)', async () => {
    const { controller } = build({ getRun: async () => Promise.reject(new NotFoundException()) });
    await expect(controller.streamTrace('R', {} as never)).rejects.toBeInstanceOf(NotFoundException);
  });

  it('no working tenant is a 403', async () => {
    const { controller } = build({ tenantId: null });
    await expect(controller.streamTrace('R', {} as never)).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('a protocol other than 2 is refused (400), never downgraded', async () => {
    const { controller } = build();
    await expect(controller.streamTrace('R', {} as never, undefined, undefined, '1')).rejects.toMatchObject({ status: 400 });
  });
});
