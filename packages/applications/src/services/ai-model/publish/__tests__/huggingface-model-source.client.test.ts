/**
 * HuggingFaceModelSourceClient — thin transport wrapper over the HF Hub
 * REST surface. No real network I/O in this suite; `HttpService.axiosRef`
 * is mocked, matching `KnowledgeIngestClient`'s test convention.
 *
 * the client also resolves the platform HuggingFace token
 * (`model-registry`/`huggingface`, SYSTEM-tenant) through an injected
 * `IProviderConnectionService` and attaches it as a bearer token. That
 * resolver is mocked here the same way `axiosRef` is.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { SYSTEM_TENANT_ID } from '@arcaai/domains';
import { HuggingFaceModelSourceClient } from '../huggingface-model-source.client';

function resolvedCredential(apiKey: string) {
  return { outcome: 'resolved' as const, apiKey, funding: 'platform' as const };
}

describe('HuggingFaceModelSourceClient', () => {
  const axiosRef = { get: vi.fn() };
  const resolveCredential = vi.fn();
  const providerConnections = { resolveCredential } as never;
  let client: HuggingFaceModelSourceClient;

  beforeEach(() => {
    vi.clearAllMocks();
    resolveCredential.mockResolvedValue({ outcome: 'absent' });
    client = new HuggingFaceModelSourceClient({ axiosRef } as never, providerConnections);
  });

  describe('listRepoFiles', () => {
    it('requests the recursive tree endpoint and returns only file entries', async () => {
      axiosRef.get.mockResolvedValue({
        data: [
          { path: 'config.json', type: 'file', size: 512 },
          { path: 'weights', type: 'directory' },
          { path: 'model.gguf', type: 'file', lfs: { size: 3350000000 } },
        ],
      });

      const files = await client.listRepoFiles('google/gemma-4-e2b-it-qat-q4_0-gguf');

      expect(axiosRef.get).toHaveBeenCalledWith(
        'https://huggingface.co/api/models/google/gemma-4-e2b-it-qat-q4_0-gguf/tree/main?recursive=1',
        expect.objectContaining({ timeout: expect.any(Number) }),
      );
      expect(files).toEqual([
        { path: 'config.json', size: 512 },
        { path: 'model.gguf', size: 3350000000 },
      ]);
    });

    it('returns an empty list when the API responds with something unexpected', async () => {
      axiosRef.get.mockResolvedValue({ data: { error: 'not found' } });
      const files = await client.listRepoFiles('missing/repo');
      expect(files).toEqual([]);
    });
  });

  describe('downloadFile', () => {
    it('GETs the resolve URL as an arraybuffer and returns a Buffer', async () => {
      axiosRef.get.mockResolvedValue({ data: new TextEncoder().encode('hello').buffer });

      const result = await client.downloadFile('google/gemma-4-e2b-it-qat-q4_0-gguf', 'config.json');

      expect(axiosRef.get).toHaveBeenCalledWith(
        'https://huggingface.co/google/gemma-4-e2b-it-qat-q4_0-gguf/resolve/main/config.json',
        expect.objectContaining({ responseType: 'arraybuffer' }),
      );
      expect(Buffer.isBuffer(result)).toBe(true);
      expect(result.toString('utf8')).toBe('hello');
    });
  });

  describe('HuggingFace token — resolved from model-registry/huggingface, SYSTEM tenant', () => {
    it('sends Bearer <token> when the SYSTEM row resolves a credential', async () => {
      resolveCredential.mockResolvedValue(resolvedCredential('hf_live_secret_token'));
      axiosRef.get.mockResolvedValue({ data: [] });

      await client.listRepoFiles('taphuynh/whisper-large-en-medical-2607.26-merged-gguf');

      expect(resolveCredential).toHaveBeenCalledWith('model-registry', 'huggingface', SYSTEM_TENANT_ID);
      expect(axiosRef.get).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({ headers: { Authorization: 'Bearer hf_live_secret_token' } }),
      );
    });

    it('resolves against SYSTEM regardless of which model/tenant is being fetched — never a caller-supplied tenant', async () => {
      resolveCredential.mockResolvedValue(resolvedCredential('hf_live_secret_token'));
      axiosRef.get.mockResolvedValue({ data: new ArrayBuffer(0) });

      await client.downloadFile('some/private-repo', 'weights.gguf');

      expect(resolveCredential).toHaveBeenCalledWith('model-registry', 'huggingface', SYSTEM_TENANT_ID);
    });

    it.each([
      ['absent — no row configured', { outcome: 'absent' }],
      ['denied — the row was disabled (a veto)', { outcome: 'denied', reason: 'tenant veto' }],
      ['unavailable — the resolve itself faulted (e.g. Vault down)', { outcome: 'unavailable', reason: 'credential resolution failed' }],
      ['resolved but keyless (should not happen, defensive)', { outcome: 'resolved' }],
    ])('sends NO Authorization header and does not fail when the outcome is %s', async (_label, outcome) => {
      resolveCredential.mockResolvedValue(outcome);
      axiosRef.get.mockResolvedValue({ data: [{ path: 'config.json', type: 'file', size: 10 }] });

      const files = await client.listRepoFiles('blaze999/Medical-NER');

      expect(files).toEqual([{ path: 'config.json', size: 10 }]);
      const [, config] = axiosRef.get.mock.calls[0];
      expect(config.headers).toEqual({});
    });

    it('a public repo keeps working with no IProviderConnectionService wired at all', async () => {
      const unwired = new HuggingFaceModelSourceClient({ axiosRef } as never, undefined);
      axiosRef.get.mockResolvedValue({ data: [] });

      await expect(unwired.listRepoFiles('unsloth/Qwen3-0.6B-GGUF')).resolves.toEqual([]);
      const [, config] = axiosRef.get.mock.calls[0];
      expect(config.headers).toEqual({});
    });

    it('never sends the credential to the wrong host — Authorization only reaches huggingface.co URLs already being requested', async () => {
      resolveCredential.mockResolvedValue(resolvedCredential('hf_live_secret_token'));
      axiosRef.get.mockResolvedValue({ data: new ArrayBuffer(0) });

      await client.downloadFile('google/gemma-4-e2b-it-qat-q4_0-gguf', 'model.gguf');

      const [url] = axiosRef.get.mock.calls[0];
      expect(url).toMatch(/^https:\/\/huggingface\.co\//);
    });
  });

  describe('a 401/403 from HuggingFace itself surfaces an actionable error', () => {
    it('names the repo, the status, and the fix — never a bare axios stack', async () => {
      resolveCredential.mockResolvedValue({ outcome: 'absent' });
      axiosRef.get.mockRejectedValue({ response: { status: 401 }, message: 'Request failed with status code 401' });

      await expect(client.listRepoFiles('gated/private-repo')).rejects.toThrow(
        /gated\/private-repo.*401.*configure the SYSTEM model-registry\/huggingface provider connection/,
      );
    });

    it('reports 403 the same way', async () => {
      resolveCredential.mockResolvedValue(resolvedCredential('hf_live_secret_token'));
      axiosRef.get.mockRejectedValue({ response: { status: 403 }, message: 'Request failed with status code 403' });

      await expect(client.downloadFile('gated/private-repo', 'model.gguf')).rejects.toThrow(/403.*configure the SYSTEM/);
    });

    it('NEVER includes the resolved token in the thrown error, in any form (message, cause, or stack)', async () => {
      const secret = 'hf_super_secret_do_not_leak';
      resolveCredential.mockResolvedValue(resolvedCredential(secret));
      axiosRef.get.mockRejectedValue({
        response: { status: 401 },
        message: 'Request failed with status code 401',
        config: { headers: { Authorization: `Bearer ${secret}` } },
      });

      try {
        await client.listRepoFiles('gated/private-repo');
        throw new Error('expected listRepoFiles to reject');
      } catch (error) {
        const err = error as Error;
        expect(err.message).not.toContain(secret);
        expect(String(err.cause ?? '')).not.toContain(secret);
        expect(err.stack ?? '').not.toContain(secret);
      }
    });

    it('a non-auth failure (e.g. a 500 or network error) is NOT rewritten with the configure hint', async () => {
      resolveCredential.mockResolvedValue({ outcome: 'absent' });
      const serverError = Object.assign(new Error('Request failed with status code 500'), { response: { status: 500 } });
      axiosRef.get.mockRejectedValue(serverError);

      await expect(client.listRepoFiles('some/repo')).rejects.toThrow('Request failed with status code 500');
      await expect(client.listRepoFiles('some/repo')).rejects.not.toThrow(/configure the SYSTEM/);
    });
  });
});
