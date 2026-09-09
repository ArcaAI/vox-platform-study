import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { main } from '../cli';

function jsonResponse(body: unknown, init: { ok?: boolean; status?: number; statusText?: string } = {}): Response {
  return {
    ok: init.ok ?? true,
    status: init.status ?? 200,
    statusText: init.statusText ?? 'OK',
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

describe('cli main()', () => {
  let dir: string;
  let stdout: string[];
  let stderr: string[];

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'vox-codegen-cli-'));
    stdout = [];
    stderr = [];
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
      stdout.push(String(chunk));
      return true;
    });
    vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
      stderr.push(String(chunk));
      return true;
    });
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    await rm(dir, { recursive: true, force: true });
  });

  it('--help prints usage and exits 0', async () => {
    const code = await main(['--help']);
    expect(code).toBe(0);
    expect(stdout.join('')).toContain('vox-codegen — emit TypeScript types');
  });

  it('requires --tenant', async () => {
    const code = await main(['--token', 'jwt']);
    expect(code).toBe(1);
    expect(stderr.join('')).toContain('--tenant <id> is required');
  });

  /**
   * AMENDED TASK-933: the context-schema mode now accepts a SERVICE ACCOUNT as
   * well as a super-admin JWT, so the refusal names both classes rather than
   * only the bearer token. What is being pinned is unchanged — no credential is
   * a refusal, never an anonymous read.
   */
  it('requires a credential — a JWT or a service-account pair, from a flag or the environment', async () => {
    const previousToken = process.env.HOPE_API_TOKEN;
    const previousId = process.env.HOPE_SVC_CLIENT_ID;
    const previousSecret = process.env.HOPE_SVC_CLIENT_SECRET;
    delete process.env.HOPE_API_TOKEN;
    delete process.env.HOPE_SVC_CLIENT_ID;
    delete process.env.HOPE_SVC_CLIENT_SECRET;
    try {
      const code = await main(['--tenant', 'tenant-1']);
      expect(code).toBe(1);
      expect(stderr.join('')).toContain('a credential is required');
      expect(stderr.join('')).toContain('--token');
      expect(stderr.join('')).toContain('--client-id');
    } finally {
      if (previousToken !== undefined) process.env.HOPE_API_TOKEN = previousToken;
      if (previousId !== undefined) process.env.HOPE_SVC_CLIENT_ID = previousId;
      if (previousSecret !== undefined) process.env.HOPE_SVC_CLIENT_SECRET = previousSecret;
    }
  });

  it('rejects a non-positive --interval', async () => {
    const code = await main(['--tenant', 'tenant-1', '--token', 'jwt', '--interval', '0']);
    expect(code).toBe(1);
    expect(stderr.join('')).toContain('--interval must be a positive number');
  });

  it('runs one-shot codegen successfully and writes the output file', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        jsonResponse({
          schemaId: null,
          slug: null,
          name: null,
          versionNumber: null,
          contextSchemaVersionId: null,
          checksum: null,
          definition: null,
          etag: 'none',
        }),
      ),
    );
    const outFile = join(dir, 'out.generated.ts');

    const code = await main(['--tenant', 'tenant-1', '--token', 'jwt', '--out', outFile]);

    expect(code).toBe(0);
    expect(stdout.join('')).toContain(`wrote ${outFile}`);
    const written = await readFile(outFile, 'utf8');
    expect(written).toContain('No consultation context schema is configured');
  });

  it('surfaces a CodegenError from a failed fetch as exit code 1 with a clear message, not a stack trace', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse('unauthorized', { ok: false, status: 401, statusText: 'Unauthorized' })));

    const code = await main(['--tenant', 'tenant-1', '--token', 'bad-token', '--out', join(dir, 'out.generated.ts')]);

    expect(code).toBe(1);
    expect(stderr.join('')).toContain('401');
  });
});
