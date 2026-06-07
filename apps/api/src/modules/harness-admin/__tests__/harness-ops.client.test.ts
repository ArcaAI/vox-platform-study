/**
 * HarnessOpsClient unit tests (TASK-330 Phase 6 — Phase B).
 *
 * Verifies the outbound contract the Python harness agent must match: base-URL
 * resolution, the `/api/v1/internal/harness/workflows*` paths, the
 * `X-Service-Token` header, query/body shapes, and upstream-error translation
 * (harness status passthrough vs. 503 on transport failure).
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { HttpException, ServiceUnavailableException } from '@nestjs/common';
import { HarnessOpsClient } from '../harness-ops.client';

function makeClient(getEnv: (key: string) => string | undefined = () => undefined) {
  const axiosRef = { get: vi.fn(), post: vi.fn() };
  const httpService = { axiosRef } as any;
  const configService = { get: vi.fn((key: string) => getEnv(key)) } as any;
  const secretsService = { getSecretOptional: vi.fn().mockResolvedValue('svc-token') } as any;
  const client = new HarnessOpsClient(httpService, configService, secretsService);
  return { client, axiosRef, secretsService };
}

describe('HarnessOpsClient', () => {
  beforeEach(() => vi.clearAllMocks());

  it('resolves the base URL from HARNESS_BASE_URL and sends the X-Service-Token header', async () => {
    const { client, axiosRef, secretsService } = makeClient((k) => (k === 'HARNESS_BASE_URL' ? 'http://harness:9000' : undefined));
    axiosRef.get.mockResolvedValue({ data: { items: [{ workflowId: 'wf-1' }], nextPageToken: 'np' } });

    const result = await client.listWorkflows({ tenantId: 't1', status: 'RUNNING', limit: 25 });

    const [url, opts] = axiosRef.get.mock.calls[0];
    expect(url).toBe('http://harness:9000/api/v1/internal/harness/workflows');
    expect(opts.params).toMatchObject({ tenantId: 't1', status: 'RUNNING', limit: 25 });
    expect(opts.headers['X-Service-Token']).toBe('svc-token');
    expect(secretsService.getSecretOptional).toHaveBeenCalledWith('HARNESS_SERVICE_TOKEN');
    expect(result.items).toEqual([{ workflowId: 'wf-1' }]);
    expect(result.nextPageToken).toBe('np');
  });

  it('falls back to HARNESS_URL then localhost:8866', async () => {
    const { client, axiosRef } = makeClient((k) => (k === 'HARNESS_URL' ? 'http://legacy:8866' : undefined));
    axiosRef.get.mockResolvedValue({ data: {} });
    await client.listWorkflows();
    expect(axiosRef.get.mock.calls[0][0]).toBe('http://legacy:8866/api/v1/internal/harness/workflows');

    const { client: c2, axiosRef: a2 } = makeClient();
    a2.get.mockResolvedValue({ data: {} });
    await c2.listWorkflows();
    expect(a2.get.mock.calls[0][0]).toBe('http://localhost:8866/api/v1/internal/harness/workflows');
  });

  it('describeWorkflow encodes the id and sends ?phase=true', async () => {
    const { client, axiosRef } = makeClient();
    axiosRef.get.mockResolvedValue({ data: { workflowId: 'wf 1', tenantId: 't1' } });

    await client.describeWorkflow('wf 1', { phase: true, tenantId: 't1' });

    const [url, opts] = axiosRef.get.mock.calls[0];
    expect(url).toBe('http://localhost:8866/api/v1/internal/harness/workflows/wf%201');
    expect(opts.params).toMatchObject({ phase: 'true', tenantId: 't1' });
  });

  it('cancel / terminate / signal POST to the right paths with a tenant-scoped body', async () => {
    const { client, axiosRef } = makeClient();
    axiosRef.post.mockResolvedValue({ data: { workflowId: 'wf-1', status: 'CANCELED', action: 'cancel', requested: true } });

    await client.cancelWorkflow('wf-1', { tenantId: 't1', reason: 'mistake' });
    expect(axiosRef.post.mock.calls[0][0]).toBe('http://localhost:8866/api/v1/internal/harness/workflows/wf-1/cancel');
    expect(axiosRef.post.mock.calls[0][1]).toEqual({ tenantId: 't1', reason: 'mistake' });

    await client.terminateWorkflow('wf-1', { tenantId: 't1' });
    expect(axiosRef.post.mock.calls[1][0]).toBe('http://localhost:8866/api/v1/internal/harness/workflows/wf-1/terminate');

    await client.signalWorkflow('wf-1', { tenantId: 't1', signalName: 'approve', payload: { ok: true } });
    expect(axiosRef.post.mock.calls[2][0]).toBe('http://localhost:8866/api/v1/internal/harness/workflows/wf-1/signal');
    expect(axiosRef.post.mock.calls[2][1]).toEqual({ tenantId: 't1', signalName: 'approve', payload: { ok: true } });
  });

  it('passes through the upstream status on an axios error response', async () => {
    const { client, axiosRef } = makeClient();
    axiosRef.get.mockRejectedValue({ isAxiosError: true, response: { status: 404, data: { message: 'no such workflow' } }, message: 'Request failed' });

    await expect(client.describeWorkflow('missing')).rejects.toMatchObject({ status: 404 });
    await expect(client.describeWorkflow('missing')).rejects.toBeInstanceOf(HttpException);
  });

  it('maps a transport failure to 503 Service Unavailable', async () => {
    const { client, axiosRef } = makeClient();
    axiosRef.post.mockRejectedValue(new Error('ECONNREFUSED'));

    await expect(client.cancelWorkflow('wf-1', { tenantId: 't1' })).rejects.toBeInstanceOf(ServiceUnavailableException);
  });
});
