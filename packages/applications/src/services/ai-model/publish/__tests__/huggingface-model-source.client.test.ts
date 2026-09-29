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
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
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

  describe('getRepoInfo (TASK-860)', () => {
    it('reads the model-card facts the registry mirrors: sha, license, gated, pipeline_tag, library_name', async () => {
      axiosRef.get.mockResolvedValue({
        data: { sha: 'abc123', gated: 'auto', pipeline_tag: 'token-classification', library_name: 'transformers', cardData: { license: 'apache-2.0', language: ['en'] } },
      });

      const info = await client.getRepoInfo('blaze999/Medical-NER');

      expect(axiosRef.get).toHaveBeenCalledWith('https://huggingface.co/api/models/blaze999/Medical-NER?revision=main', expect.objectContaining({ timeout: expect.any(Number) }));
      expect(info).toEqual({ sha: 'abc123', gated: true, license: 'apache-2.0', pipelineTag: 'token-classification', libraryName: 'transformers', languages: ['en'] });
    });

    it('maps an un-gated public repo to gated=false and tolerates a missing card', async () => {
      axiosRef.get.mockResolvedValue({ data: { sha: 'ffff', gated: false } });
      const info = await client.getRepoInfo('onnx-community/silero-vad');
      expect(info).toEqual({ sha: 'ffff', gated: false, license: null, pipelineTag: null, libraryName: null, languages: [] });
    });
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

  describe('downloadFileTo (TASK-1019 P3 — streamed to disk, never a whole-file Buffer)', () => {
    let dir: string;
    beforeEach(async () => {
      dir = await mkdtemp(join(tmpdir(), 'hf-client-test-'));
    });
    afterEach(async () => {
      vi.restoreAllMocks();
      await rm(dir, { recursive: true, force: true });
    });

    it('streams a 3-chunk body to the destination while hashing it, reporting bytes as they arrive', async () => {
      const chunks = [Buffer.alloc(4096, 1), Buffer.alloc(4096, 2), Buffer.alloc(1000, 3)];
      const total = chunks.reduce((n, c) => n + c.length, 0);
      const expectedSha = createHash('sha256').update(chunks[0]).update(chunks[1]).update(chunks[2]).digest('hex');
      axiosRef.get.mockResolvedValue({ data: Readable.from(chunks) });
      const concatSpy = vi.spyOn(Buffer, 'concat');
      const onBytes = vi.fn();
      const dest = join(dir, 'nested', 'model.gguf');

      const result = await client.downloadFileTo('org/repo', 'nested/model.gguf', 'abc123', dest, onBytes);

      expect(axiosRef.get).toHaveBeenCalledWith('https://huggingface.co/org/repo/resolve/abc123/nested/model.gguf', expect.objectContaining({ responseType: 'stream' }));
      expect(result).toEqual({ size: total, sha256: expectedSha });
      expect(onBytes.mock.calls.map((c) => c[0])).toEqual([4096, 4096, 1000]);
      expect((await readFile(dest)).equals(Buffer.concat(chunks))).toBe(true);
      // The only whole-file concat is the assertion's own, made after the call.
      const fullFileConcats = concatSpy.mock.results.filter((r) => (r.value as Buffer).length >= total);
      expect(fullFileConcats).toHaveLength(1);
    });

    it('rejects when the body stream errors mid-transfer (no partial success)', async () => {
      const body = new Readable({ read() {} });
      // The socket fails AFTER the response arrived — as it does for real.
      axiosRef.get.mockImplementation(async () => {
        setImmediate(() => {
          body.push(Buffer.alloc(10));
          body.destroy(new Error('socket hang up'));
        });
        return { data: body };
      });

      await expect(client.downloadFileTo('org/repo', 'model.gguf', 'main', join(dir, 'model.gguf'))).rejects.toThrow('socket hang up');
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
      axiosRef.get.mockResolvedValue({ data: Readable.from([]) });

      await client.downloadFileTo('some/private-repo', 'weights.gguf', 'main', join(tmpdir(), `hf-client-${process.pid}-a.bin`));

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
      axiosRef.get.mockResolvedValue({ data: Readable.from([]) });

      await client.downloadFileTo('google/gemma-4-e2b-it-qat-q4_0-gguf', 'model.gguf', 'main', join(tmpdir(), `hf-client-${process.pid}-b.bin`));

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

      await expect(client.downloadFileTo('gated/private-repo', 'model.gguf', 'main', join(tmpdir(), `hf-client-${process.pid}-c.bin`))).rejects.toThrow(/403.*configure the SYSTEM/);
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
