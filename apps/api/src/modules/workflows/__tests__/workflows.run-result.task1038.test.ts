/**
 * TASK-1038 D-I — `GET /workflows/:slug/runs/:runId/result`, the business-plane read of what a
 * run delivered. Same authorisation as the run status route; the rendering of each answer:
 * inline → 200 with the value as the body; ref → 200 with a signed URL; none → 204;
 * expired → 410. The 409 (not terminal) and 404 (not yours) come from the service unchanged.
 */
import { describe, expect, it, vi } from 'vitest';
import { ConflictException, GoneException, NotFoundException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { API_KEY_REQUIRED_SCOPES, REQUIRED_PERMISSIONS_KEY, SERVICE_ACCOUNT_REQUIRED_SCOPES } from '@arcaai/applications';
import { WorkflowsController } from '../workflows.controller';

const reflector = new Reflector();

function makeController(result: unknown) {
  const exposure = { getRunResult: vi.fn(async () => (result instanceof Error ? Promise.reject(result) : result)) };
  const controller = new WorkflowsController(exposure as never, {} as never);
  const res = { setHeader: vi.fn(), status: vi.fn() };
  return { controller, exposure, res };
}

describe('GET workflows/:slug/runs/:runId/result', () => {
  it('carries the same ability and scopes as the run status route', () => {
    const handler = (WorkflowsController.prototype as never as Record<string, () => void>).getRunResult;
    const status = (WorkflowsController.prototype as never as Record<string, () => void>).getRunStatus;
    for (const key of [REQUIRED_PERMISSIONS_KEY, API_KEY_REQUIRED_SCOPES, SERVICE_ACCOUNT_REQUIRED_SCOPES]) {
      expect(reflector.getAllAndOverride(key, [handler, WorkflowsController])).toEqual(reflector.getAllAndOverride(key, [status, WorkflowsController]));
    }
    expect(reflector.getAllAndOverride(API_KEY_REQUIRED_SCOPES, [handler, WorkflowsController])).toEqual(['workflow:run:read']);
  });

  it('inline: the delivered JSON value IS the body', async () => {
    const { controller, exposure, res } = makeController({ runId: 'run-1', status: 'COMPLETED', kind: 'inline', value: { note: 'SOAP' } });
    const body = await controller.getRunResult('flow', 'run-1', res as never);
    expect(exposure.getRunResult).toHaveBeenCalledWith('flow', 'run-1');
    expect(body).toEqual({ note: 'SOAP' });
    expect(res.setHeader).toHaveBeenCalledWith('X-Hope-Result-Kind', 'inline');
  });

  it('ref: a short-lived signed URL with its integrity facts, never the bucket or key', async () => {
    const { controller, res } = makeController({
      runId: 'run-1',
      status: 'COMPLETED',
      kind: 'ref',
      url: 'https://minio.example/signed',
      expiresAt: '2026-10-04T00:05:00.000Z',
      sizeBytes: 300_000,
      sha256: 'f'.repeat(64),
    });
    const body = await controller.getRunResult('flow', 'run-1', res as never);
    expect(body).toEqual({ url: 'https://minio.example/signed', expiresAt: '2026-10-04T00:05:00.000Z', sizeBytes: 300_000, sha256: 'f'.repeat(64) });
    expect(res.setHeader).toHaveBeenCalledWith('X-Hope-Result-Kind', 'ref');
  });

  it('none: 204 with no body', async () => {
    const { controller, res } = makeController({ runId: 'run-1', status: 'FAILED', kind: 'none' });
    const body = await controller.getRunResult('flow', 'run-1', res as never);
    expect(res.status).toHaveBeenCalledWith(204);
    expect(body).toBeUndefined();
  });

  it('expired: 410 Gone', async () => {
    const { controller, res } = makeController({ runId: 'run-1', status: 'COMPLETED', kind: 'expired', expiredAt: '2026-11-03T00:00:00.000Z' });
    await expect(controller.getRunResult('flow', 'run-1', res as never)).rejects.toBeInstanceOf(GoneException);
  });

  it('passes the service`s 409 (not terminal) and 404 (not yours) through untouched', async () => {
    const conflict = new ConflictException({ code: 'RUN_NOT_TERMINAL', status: 'RUNNING' });
    await expect(makeController(conflict).controller.getRunResult('flow', 'run-1', { setHeader: vi.fn(), status: vi.fn() } as never)).rejects.toBe(conflict);
    const missing = new NotFoundException();
    await expect(makeController(missing).controller.getRunResult('flow', 'run-1', { setHeader: vi.fn(), status: vi.fn() } as never)).rejects.toBe(missing);
  });
});
