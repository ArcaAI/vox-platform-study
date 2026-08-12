import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runCodegenOnce } from '../run';

function jsonResponse(body: unknown): Response {
  return { ok: true, status: 200, statusText: 'OK', json: async () => body, text: async () => JSON.stringify(body) } as unknown as Response;
}

describe('runCodegenOnce', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'vox-codegen-run-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('fetches, generates, and writes the output file (including creating nested output directories)', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonResponse({
        schemaId: 's1',
        slug: 'default',
        name: 'Default',
        versionNumber: 1,
        contextSchemaVersionId: 'v1',
        checksum: 'sum',
        definition: { schemaVersion: '1.0', kinds: [] },
        etag: '"1"',
      }),
    );
    const outFile = join(dir, 'nested', 'out.generated.ts');

    const result = await runCodegenOnce({
      baseUrl: 'http://localhost:8868',
      tenantId: 'tenant-1',
      token: 'jwt',
      outFile,
      fetchImpl,
      generatedAt: new Date('2026-08-12T00:00:00.000Z'),
    });

    expect(result.bundle.etag).toBe('"1"');
    const written = await readFile(outFile, 'utf8');
    expect(written).toBe(result.file.contents);
    expect(written).toContain('Tenant: tenant-1');
  });
});
