/**
 * TASK-1023 J7 (OD-3) — the HF credential is resolved for the JOB's tenant, and a
 * non-SYSTEM job NEVER falls back to the platform (SYSTEM) token: its own
 * enabled, keyed default row, or no Authorization header at all.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SYSTEM_TENANT_ID } from '@arcaai/domains';
import { HuggingFaceModelSourceClient } from '../huggingface-model-source.client';

const TENANT = '11111111-1111-1111-1111-111111111111';

describe('HuggingFaceModelSourceClient — credential per job tenant (J7)', () => {
  const axiosRef = { get: vi.fn() };
  const resolveCredential = vi.fn();
  const findDefaultRow = vi.fn();
  let client: HuggingFaceModelSourceClient;
  let dir: string;

  beforeEach(async () => {
    vi.clearAllMocks();
    axiosRef.get.mockResolvedValue({ data: { sha: 'abc' } });
    client = new HuggingFaceModelSourceClient({ axiosRef } as never, { resolveCredential, findDefaultRow } as never);
    dir = await mkdtemp(join(tmpdir(), 'hf-j7-'));
  });
  afterEach(async () => rm(dir, { recursive: true, force: true }));

  const authOf = (call: number) => (axiosRef.get.mock.calls[call][1] as { headers?: Record<string, string> }).headers?.Authorization;

  it('a SYSTEM job (the default) sends the SYSTEM token exactly as before', async () => {
    resolveCredential.mockResolvedValue({ outcome: 'resolved', apiKey: 'hf_platform', funding: 'platform' });
    await client.getRepoInfo('org/repo');
    await client.listRepoFiles('org/repo', 'main', { tenantId: SYSTEM_TENANT_ID });
    expect(resolveCredential).toHaveBeenCalledWith('model-registry', 'huggingface', SYSTEM_TENANT_ID);
    expect(authOf(0)).toBe('Bearer hf_platform');
    expect(authOf(1)).toBe('Bearer hf_platform');
  });

  it('a non-SYSTEM job with no tenant row sends NO Authorization header — the SYSTEM token is never read', async () => {
    findDefaultRow.mockResolvedValue(null);
    resolveCredential.mockResolvedValue({ outcome: 'resolved', apiKey: 'hf_platform', funding: 'platform' });

    await client.getRepoInfo('org/repo', 'main', { tenantId: TENANT });
    axiosRef.get.mockResolvedValueOnce({ data: Readable.from([Buffer.from('x')]) });
    await client.downloadFileTo('org/repo', 'a.bin', 'main', join(dir, 'a.bin'), undefined, { tenantId: TENANT });

    expect(findDefaultRow).toHaveBeenCalledWith('model-registry', 'huggingface', TENANT);
    expect(resolveCredential).not.toHaveBeenCalled();
    expect(authOf(0)).toBeUndefined();
    expect(authOf(1)).toBeUndefined();
  });

  it('a non-SYSTEM job whose row is disabled or keyless sends no header either', async () => {
    findDefaultRow.mockResolvedValueOnce({ enabled: false, encryptedApiKey: new Uint8Array([1]) });
    await client.getRepoInfo('org/repo', 'main', { tenantId: TENANT });
    findDefaultRow.mockResolvedValueOnce({ enabled: true, encryptedApiKey: null });
    await client.getRepoInfo('org/repo', 'main', { tenantId: TENANT });
    expect(resolveCredential).not.toHaveBeenCalled();
    expect(authOf(0)).toBeUndefined();
    expect(authOf(1)).toBeUndefined();
  });

  it("a non-SYSTEM job with its own enabled, keyed row sends the TENANT's token", async () => {
    findDefaultRow.mockResolvedValue({ enabled: true, encryptedApiKey: new Uint8Array([1]) });
    resolveCredential.mockResolvedValue({ outcome: 'resolved', apiKey: 'hf_tenant', funding: 'tenant' });
    await client.getRepoInfo('org/repo', 'main', { tenantId: TENANT });
    expect(resolveCredential).toHaveBeenCalledWith('model-registry', 'huggingface', TENANT);
    expect(authOf(0)).toBe('Bearer hf_tenant');
  });

  it('belt and braces: a resolve that still comes back PLATFORM-funded for a tenant job is dropped', async () => {
    findDefaultRow.mockResolvedValue({ enabled: true, encryptedApiKey: new Uint8Array([1]) });
    resolveCredential.mockResolvedValue({ outcome: 'resolved', apiKey: 'hf_platform', funding: 'platform' });
    await client.getRepoInfo('org/repo', 'main', { tenantId: TENANT });
    expect(authOf(0)).toBeUndefined();
  });

  it('D-C — an external cancel signal aborts a streaming download with the CANCEL reason (not the idle error)', async () => {
    resolveCredential.mockResolvedValue({ outcome: 'absent' });
    const controller = new AbortController();
    const reason = new Error('CANCELLED');
    const body = new Readable({ read() {} });
    body.push(Buffer.from('partial'));
    axiosRef.get.mockResolvedValueOnce({ data: body });
    const pending = client.downloadFileTo('org/repo', 'w.bin', 'main', join(dir, 'w.bin'), () => controller.abort(reason), {
      signal: controller.signal,
      idleTimeoutMs: 60_000,
    });
    await expect(pending).rejects.toBe(reason);
    expect((axiosRef.get.mock.calls[0][1] as { signal: AbortSignal }).signal.aborted).toBe(true);
  });

  it('D-C — an already-aborted signal makes no request', async () => {
    const controller = new AbortController();
    controller.abort(new Error('CANCELLED'));
    await expect(client.downloadFileTo('org/repo', 'w.bin', 'main', join(dir, 'w.bin'), undefined, { signal: controller.signal })).rejects.toThrow('CANCELLED');
    expect(axiosRef.get).not.toHaveBeenCalled();
  });
});
