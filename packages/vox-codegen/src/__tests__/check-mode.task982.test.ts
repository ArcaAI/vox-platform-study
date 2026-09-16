/**
 * `--check` at the CLI level, for both generator modes: regenerate in memory, compare against
 * what is on disk, never write, exit 1 on drift.
 */

import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
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

const UNCONFIGURED_BUNDLE = {
  schemaId: null,
  slug: null,
  name: null,
  versionNumber: null,
  contextSchemaVersionId: null,
  checksum: null,
  definition: null,
  etag: 'none',
};

describe('cli main() — --check, consultation-context mode', () => {
  let dir: string;
  let stdout: string[];
  let stderr: string[];

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'vox-codegen-check-tenant-'));
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

  it('exits 0 and writes nothing when the on-disk file already matches', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(UNCONFIGURED_BUNDLE)));
    const outFile = join(dir, 'out.generated.ts');

    // Seed the file by running once for real, then check it.
    await main(['--tenant', 'tenant-1', '--token', 'jwt', '--out', outFile]);
    const before = await readFile(outFile, 'utf8');

    const code = await main(['--tenant', 'tenant-1', '--token', 'jwt', '--out', outFile, '--check']);

    expect(code).toBe(0);
    expect(stdout.join('')).toContain(`${outFile} is up to date`);
    expect(await readFile(outFile, 'utf8')).toBe(before);
  });

  it('exits 1 with a diff when the file is missing', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(UNCONFIGURED_BUNDLE)));
    const outFile = join(dir, 'missing.generated.ts');

    const code = await main(['--tenant', 'tenant-1', '--token', 'jwt', '--out', outFile, '--check']);

    expect(code).toBe(1);
    expect(stderr.join('')).toContain('OUT OF DATE');
  });

  it('exits 1 with a diff when the on-disk file has drifted', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(UNCONFIGURED_BUNDLE)));
    const outFile = join(dir, 'out.generated.ts');
    await writeFile(outFile, 'export type Stale = true;\n', 'utf8');

    const code = await main(['--tenant', 'tenant-1', '--token', 'jwt', '--out', outFile, '--check']);

    expect(code).toBe(1);
    expect(stderr.join('')).toContain('OUT OF DATE');
    expect(stderr.join('')).toContain('Stale');
  });

  it('--check and --watch are mutually exclusive', async () => {
    const code = await main(['--tenant', 'tenant-1', '--token', 'jwt', '--out', join(dir, 'out.ts'), '--check', '--watch']);

    expect(code).toBe(1);
    expect(stderr.join('')).toContain('--check and --watch are mutually exclusive');
  });
});

describe('cli main() — --check, business-plane mode', () => {
  let dir: string;
  let stdout: string[];
  let stderr: string[];

  const NOTE_WRITER = {
    slug: 'note-writer',
    name: 'Note writer',
    description: null,
    task: 'TEXT_GENERATION',
    versionNumber: 1,
    inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'], additionalProperties: false },
    outputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'], additionalProperties: false },
  };

  function routedFetch() {
    return vi.fn(async (input: Parameters<typeof fetch>[0]) => {
      const url = String(input);
      if (url.endsWith('/api/v1/agents')) return jsonResponse({ data: [NOTE_WRITER] });
      if (url.endsWith('/api/v1/agents/note-writer')) return jsonResponse(NOTE_WRITER);
      throw new Error(`unexpected URL ${url}`);
    });
  }

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'vox-codegen-check-catalogue-'));
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

  it('exits 0 when every requested plane matches', async () => {
    vi.stubGlobal('fetch', routedFetch());
    await main(['--api-key', 'hope_key', '--agents', '--out', dir]);

    const code = await main(['--api-key', 'hope_key', '--agents', '--out', dir, '--check']);

    expect(code).toBe(0);
    expect(stdout.join('')).toContain('is up to date');
  });

  it('exits 1 when a plane file is missing, without creating it', async () => {
    vi.stubGlobal('fetch', routedFetch());
    await mkdir(dir, { recursive: true });

    const code = await main(['--api-key', 'hope_key', '--agents', '--out', dir, '--check']);

    expect(code).toBe(1);
    expect(stderr.join('')).toContain('OUT OF DATE');
    await expect(readFile(join(dir, 'agents.generated.ts'), 'utf8')).rejects.toThrow();
  });

  it('--watch is refused on the business plane regardless of --check', async () => {
    const code = await main(['--api-key', 'hope_key', '--agents', '--out', dir, '--check', '--watch']);

    expect(code).toBe(1);
    expect(stderr.join('')).toContain('--watch is only supported for the consultation-context mode');
  });
});
