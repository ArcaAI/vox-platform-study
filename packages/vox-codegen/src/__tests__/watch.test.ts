import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { watchCodegen, type WatchCycleInfo } from '../watch';

function jsonResponse(body: unknown): Response {
  return { ok: true, status: 200, statusText: 'OK', json: async () => body, text: async () => JSON.stringify(body) } as unknown as Response;
}

function bundleWithEtag(etag: string) {
  return { schemaId: 's1', slug: 'default', name: 'Default', versionNumber: 1, contextSchemaVersionId: 'v1', checksum: etag, definition: { schemaVersion: '1.0', kinds: [] }, etag };
}

describe('watchCodegen (TDD-4: --watch regenerates on change)', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'vox-codegen-watch-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('regenerates the file only when the etag changes across polls, and stops on abort', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(bundleWithEtag('"1"')))
      .mockResolvedValueOnce(jsonResponse(bundleWithEtag('"1"'))) // unchanged — no rewrite expected
      .mockResolvedValueOnce(jsonResponse(bundleWithEtag('"2"'))) // changed — rewrite expected
      .mockResolvedValue(jsonResponse(bundleWithEtag('"2"')));

    const outFile = join(dir, 'out.generated.ts');
    const controller = new AbortController();
    const cycles: WatchCycleInfo[] = [];
    const sleep = vi.fn().mockResolvedValue(undefined);

    await watchCodegen({
      baseUrl: 'http://localhost:8868',
      tenantId: 'tenant-1',
      token: 'jwt',
      outFile,
      fetchImpl,
      intervalMs: 10,
      sleep,
      signal: controller.signal,
      generatedAt: new Date('2026-08-12T00:00:00.000Z'),
      onCycle: (info) => {
        cycles.push(info);
        if (cycles.length >= 3) controller.abort();
      },
    });

    expect(cycles).toEqual([
      { changed: true, etag: '"1"' },
      { changed: false, etag: '"1"' },
      { changed: true, etag: '"2"' },
    ]);
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect(sleep).toHaveBeenCalledTimes(2); // no sleep after the final (aborting) cycle

    const written = await readFile(outFile, 'utf8');
    expect(written).toContain('Tenant: tenant-1'); // sanity: a real generated file, not a stub
  });

  it('does not poll at all when the signal is already aborted', async () => {
    const fetchImpl = vi.fn();
    const controller = new AbortController();
    controller.abort();

    await watchCodegen({
      baseUrl: 'http://localhost:8868',
      tenantId: 'tenant-1',
      token: 'jwt',
      outFile: join(dir, 'out.generated.ts'),
      fetchImpl,
      intervalMs: 10,
      signal: controller.signal,
    });

    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
