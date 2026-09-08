/**
 * TASK-931 — the BUSINESS-plane codegen mode.
 *
 * The existing mode types a tenant's consultation CONTEXT SCHEMA from a super-admin JWT. This
 * one types what the tenant PUBLISHES — its agents and workflows — from an API key, which is
 * the credential an integrator actually holds:
 *
 * ```
 * npx @arcaai/vox-codegen --api-key <key> --base-url <url> --agents --workflows --out ./generated
 * ```
 *
 * Two properties are load-bearing here and asserted below: it sends `X-API-Key` and NEVER
 * calls an admin route (an API key cannot reach one, and what a tenant publishes is exactly
 * what an integrator needs to type), and the two modes are mutually exclusive — mixing an API
 * key with `--tenant` is a refusal, not a guess about which one was meant.
 */

import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { main } from '../cli';
import { fetchPublishedCatalogue } from '../fetch-catalogue';
import { generateCatalogueTypes } from '../generate-catalogue';
import { formatDiagnostics, typeCheckSource } from './support/typecheck';

function jsonResponse(body: unknown, init: { ok?: boolean; status?: number; statusText?: string } = {}): Response {
  return {
    ok: init.ok ?? true,
    status: init.status ?? 200,
    statusText: init.statusText ?? 'OK',
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

const NOTE_WRITER = {
  slug: 'note-writer',
  name: 'Note writer',
  description: 'Drafts a visit note',
  task: 'TEXT_GENERATION',
  versionNumber: 4,
  inputSchema: {
    type: 'object',
    properties: { text: { type: 'string' }, tone: { type: 'string', enum: ['formal', 'plain'] } },
    required: ['text'],
    additionalProperties: false,
  },
  outputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'], additionalProperties: false },
};

const CLINIC_NER = {
  slug: 'clinic-ner',
  name: 'Clinic NER',
  description: null,
  task: 'NAMED_ENTITY_RECOGNITION',
  versionNumber: 1,
  inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'], additionalProperties: false },
  outputSchema: {
    type: 'object',
    properties: {
      entities: {
        type: 'array',
        items: {
          type: 'object',
          properties: { text: { type: 'string' }, label: { type: 'string' }, start: { type: 'integer' }, end: { type: 'integer' } },
          required: ['text', 'label', 'start', 'end'],
          additionalProperties: false,
        },
      },
    },
    required: ['entities'],
    additionalProperties: false,
  },
};

const TRIAGE = { slug: 'triage', name: 'Triage', description: null, paletteKey: 'core', versionNumber: 2 };

const TRIAGE_SCHEMA = {
  slug: 'triage',
  versionNumber: 2,
  triggerKinds: ['api'],
  protocols: ['http', 'http-sse'],
  modes: ['async', 'blocking', 'stream'],
  components: {
    Workflow_triage_Input: {
      type: 'object',
      properties: { note: { type: 'string' }, urgency: { type: 'integer' } },
      required: ['note'],
      additionalProperties: false,
    },
    Workflow_triage_Output: {
      type: 'object',
      properties: { summary: { type: 'string' } },
      required: ['summary'],
      additionalProperties: false,
    },
  },
  asyncapi: {},
};

/** A fetch double that answers by URL path — so an unexpected route is a loud failure, not a silent default. */
function routedFetch(): { fetchImpl: typeof fetch; urls: string[]; headers: Array<Record<string, string>> } {
  const urls: string[] = [];
  const headers: Array<Record<string, string>> = [];
  const impl = vi.fn(async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const url = String(input);
    urls.push(url);
    headers.push((init?.headers ?? {}) as Record<string, string>);
    if (url.endsWith('/api/v1/agents')) return jsonResponse({ data: [NOTE_WRITER, CLINIC_NER] });
    if (url.endsWith('/api/v1/agents/note-writer')) return jsonResponse(NOTE_WRITER);
    if (url.endsWith('/api/v1/agents/clinic-ner')) return jsonResponse(CLINIC_NER);
    if (url.endsWith('/api/v1/workflows')) return jsonResponse({ data: [TRIAGE] });
    if (url.endsWith('/api/v1/workflows/triage/schema')) return jsonResponse(TRIAGE_SCHEMA);
    throw new Error(`routedFetch: unexpected URL ${url}`);
  });
  return { fetchImpl: impl as unknown as typeof fetch, urls, headers };
}

describe('fetchPublishedCatalogue', () => {
  it('reads the four business-plane routes with X-API-Key, and no admin route', async () => {
    const { fetchImpl, urls, headers } = routedFetch();

    const catalogue = await fetchPublishedCatalogue({
      baseUrl: 'http://localhost:8868',
      apiKey: 'hope_key_abc',
      agents: true,
      workflows: true,
      fetchImpl,
    });

    expect(urls).toEqual([
      'http://localhost:8868/api/v1/agents',
      'http://localhost:8868/api/v1/agents/note-writer',
      'http://localhost:8868/api/v1/agents/clinic-ner',
      'http://localhost:8868/api/v1/workflows',
      'http://localhost:8868/api/v1/workflows/triage/schema',
    ]);
    expect(urls.some((u) => u.includes('/admin/'))).toBe(false);
    for (const header of headers) expect(header['X-API-Key']).toBe('hope_key_abc');
    // No `Authorization` header: this mode holds an API key, not a JWT, and sending both is
    // two credential classes on one request — which the gateway refuses.
    for (const header of headers) expect(header.Authorization).toBeUndefined();

    expect(catalogue.agents.map((a) => a.slug)).toEqual(['note-writer', 'clinic-ner']);
    expect(catalogue.workflows.map((w) => w.slug)).toEqual(['triage']);
  });

  it('skips the plane that was not asked for', async () => {
    const { fetchImpl, urls } = routedFetch();

    await fetchPublishedCatalogue({ baseUrl: 'http://localhost:8868', apiKey: 'k', agents: false, workflows: true, fetchImpl });

    expect(urls).toEqual(['http://localhost:8868/api/v1/workflows', 'http://localhost:8868/api/v1/workflows/triage/schema']);
  });

  it('throws CodegenError on a non-2xx, rather than emitting a file that claims the tenant published nothing', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ message: 'Forbidden' }, { ok: false, status: 403, statusText: 'Forbidden' }));

    await expect(
      fetchPublishedCatalogue({ baseUrl: 'http://h', apiKey: 'k', agents: true, workflows: false, fetchImpl: fetchImpl as unknown as typeof fetch }),
    ).rejects.toThrow(/403/);
  });
});

describe('generateCatalogueTypes', () => {
  const FIXED_DATE = new Date('2026-09-08T00:00:00.000Z');

  it('emits Agent_<Slug>_Input / _Output that compile', async () => {
    const { fetchImpl } = routedFetch();
    const catalogue = await fetchPublishedCatalogue({ baseUrl: 'http://h', apiKey: 'k', agents: true, workflows: false, fetchImpl });

    const file = generateCatalogueTypes(catalogue, { surface: 'agents', baseUrl: 'http://h', generatedAt: FIXED_DATE });

    expect(file.contents).toContain('export type Agent_NoteWriter_Input');
    expect(file.contents).toContain('export type Agent_NoteWriter_Output');
    expect(file.contents).toContain('export type Agent_ClinicNer_Input');
    expect(file.contents).toContain('export type Agent_ClinicNer_Output');
    // An enum in the authored schema is a real TS union, not `string`.
    expect(file.contents).toMatch(/tone\?:\s*\("formal"\s*\|\s*"plain"\)/);
    const diagnostics = typeCheckSource(file.contents);
    expect(diagnostics, formatDiagnostics(diagnostics)).toHaveLength(0);
  });

  it('emits Workflow_<Slug>_Input / _Output from the schema route components', async () => {
    const { fetchImpl } = routedFetch();
    const catalogue = await fetchPublishedCatalogue({ baseUrl: 'http://h', apiKey: 'k', agents: false, workflows: true, fetchImpl });

    const file = generateCatalogueTypes(catalogue, { surface: 'workflows', baseUrl: 'http://h', generatedAt: FIXED_DATE });

    expect(file.contents).toContain('export type Workflow_Triage_Input');
    expect(file.contents).toContain('export type Workflow_Triage_Output');
    const diagnostics = typeCheckSource(file.contents);
    expect(diagnostics, formatDiagnostics(diagnostics)).toHaveLength(0);
  });

  it('carries a lookup map keyed by the SLUG, which is what a call site actually passes', async () => {
    const { fetchImpl } = routedFetch();
    const catalogue = await fetchPublishedCatalogue({ baseUrl: 'http://h', apiKey: 'k', agents: true, workflows: false, fetchImpl });

    const { contents } = generateCatalogueTypes(catalogue, { surface: 'agents', baseUrl: 'http://h', generatedAt: FIXED_DATE });

    expect(contents).toContain("'note-writer': { input: Agent_NoteWriter_Input; output: Agent_NoteWriter_Output };");
    expect(contents).toContain('export type AgentSlug = keyof AgentContractMap;');
  });
});

describe('cli main() — the business-plane mode', () => {
  let dir: string;
  let stdout: string[];
  let stderr: string[];

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'vox-codegen-catalogue-'));
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

  it('writes one file per requested plane', async () => {
    const { fetchImpl } = routedFetch();
    vi.stubGlobal('fetch', fetchImpl);

    const code = await main(['--api-key', 'hope_key_abc', '--base-url', 'http://localhost:8868', '--agents', '--workflows', '--out', dir]);

    expect(code, stderr.join('')).toBe(0);
    expect(await readFile(join(dir, 'agents.generated.ts'), 'utf8')).toContain('export type Agent_NoteWriter_Input');
    expect(await readFile(join(dir, 'workflows.generated.ts'), 'utf8')).toContain('export type Workflow_Triage_Input');
    expect(stdout.join('')).toContain('agents.generated.ts');
  });

  it('refuses --api-key together with --tenant — two modes, two credential classes, no guessing', async () => {
    const code = await main(['--api-key', 'k', '--tenant', 't', '--agents']);
    expect(code).toBe(1);
    expect(stderr.join('')).toMatch(/mutually exclusive/i);
  });

  it('refuses --api-key with neither --agents nor --workflows', async () => {
    const code = await main(['--api-key', 'k']);
    expect(code).toBe(1);
    expect(stderr.join('')).toMatch(/--agents/);
  });

  it('refuses --agents without a credential', async () => {
    const code = await main(['--agents']);
    expect(code).toBe(1);
    expect(stderr.join('')).toMatch(/--api-key/);
  });

  it('refuses --watch in this mode — a published catalogue has no etag to poll', async () => {
    const code = await main(['--api-key', 'k', '--agents', '--watch']);
    expect(code).toBe(1);
    expect(stderr.join('')).toMatch(/--watch/);
  });

  it('leaves the consultation-context mode intact', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ definition: null, etag: 'none' }));
    vi.stubGlobal('fetch', fetchImpl);
    const out = join(dir, 'ctx.ts');

    const code = await main(['--tenant', 'tenant-1', '--token', 'jwt', '--out', out]);

    expect(code, stderr.join('')).toBe(0);
    expect(await readFile(out, 'utf8')).toContain('No consultation context schema is configured');
  });
});
