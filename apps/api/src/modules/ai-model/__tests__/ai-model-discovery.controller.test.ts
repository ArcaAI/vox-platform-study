/**
 * AI model discovery (merge view + explicit register).
 *
 * Unit level: the TEXT probe transport and `AiModelService` are stubbed, so the
 * assertions are about the MERGE RULE and the register mapping, not HTTP.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { PATH_METADATA, METHOD_METADATA, HTTP_CODE_METADATA } from '@nestjs/common/constants';
import { GoneException, HttpStatus, RequestMethod } from '@nestjs/common';
import { AiModelDiscoveryController } from '../ai-model-discovery.controller';
import { AiModelDiscoveryService, normalizeModelSlug } from '../ai-model-discovery.service';

type TextProviderEntry = {
  name: string;
  display_name?: string;
  status?: string;
  models?: Array<{ name: string; state?: string | null; engine_native?: Record<string, unknown> | null }>;
  probe_status?: string;
  probe_latency_ms?: number;
  probe_error?: string | null;
};

type OverrideEntry = { api_key: string; funding: 'tenant' | 'platform'; base_url?: string };

function makeService(opts: {
  text?: TextProviderEntry[];
  textError?: Error;
  dbRows?: Array<Record<string, unknown>>;
  create?: ReturnType<typeof vi.fn>;
  tenantId?: string | null;
  overrides?: Record<string, OverrideEntry>;
  overridesError?: Error;
  rows?: Record<string, { baseUrl: string | null; source: 'tenant' | 'system' } | null>;
}) {
  const post = opts.textError ? vi.fn().mockRejectedValue(opts.textError) : vi.fn().mockResolvedValue({ data: opts.text ?? [] });
  const httpService = { axiosRef: { post } } as never;
  const configService = { getConfigValue: vi.fn().mockReturnValue('http://text.test') } as never;
  const create = opts.create ?? vi.fn().mockResolvedValue({ id: 'new-id', slug: 's' });
  const aiModelService = {
    getAllForAdmin: vi.fn().mockResolvedValue(opts.dbRows ?? []),
    create,
  };
  const clsService = { get: vi.fn().mockReturnValue(opts.tenantId === undefined ? 'tenant-1' : opts.tenantId) };
  const connections = {
    resolveTenantCloudOverrides: opts.overridesError
      ? vi.fn().mockRejectedValue(opts.overridesError)
      : vi.fn().mockResolvedValue({ overrides: opts.overrides ?? {} }),
    resolveConnection: vi.fn(async (_service: string, provider: string) => opts.rows?.[provider] ?? null),
  };
  const service = new AiModelDiscoveryService(
    httpService,
    configService,
    aiModelService as never,
    undefined,
    clsService as never,
    connections as never,
  );
  return { service, post, create, aiModelService, clsService, connections };
}

/** The `connections` map the gateway POSTs to TEXT for this call. */
const sentConnections = (post: ReturnType<typeof vi.fn>) => post.mock.calls[0]?.[1]?.connections ?? {};

/** The headers the gateway sent on the outbound TEXT probe call. */
const sentHeaders = (post: ReturnType<typeof vi.fn>): Record<string, string> => post.mock.calls[0]?.[2]?.headers ?? {};

const dbRow = (over: Record<string, unknown> = {}) => ({
  id: 'row-1',
  slug: 'llama3-1-8b',
  sourceUri: 'llama3.1:8b',
  provider: 'vllm',
  resourceStatus: 'ENABLED',
  ...over,
});

// =============================================================================
// Merge rule
// =============================================================================
describe('AiModelDiscoveryService.discover — merge rule', () => {
  it('tags a live-only model as discovered', async () => {
    const { service } = makeService({
      text: [{ name: 'vllm', probe_status: 'ok', models: [{ name: 'mistral-7b' }] }],
      dbRows: [],
    });

    const result = await service.discover();

    expect(result.entries).toHaveLength(1);
    expect(result.entries[0]).toMatchObject({ provider: 'vllm', modelName: 'mistral-7b', status: 'discovered' });
    expect(result.probedAt).toEqual(expect.any(String));
  });

  it('tags a registry row absent from the live listing as registered-missing-on-server', async () => {
    const { service } = makeService({
      text: [{ name: 'vllm', probe_status: 'ok', models: [{ name: 'mistral-7b' }] }],
      dbRows: [dbRow()],
    });

    const result = await service.discover();

    const missing = result.entries.find((e) => e.modelName === 'llama3.1:8b');
    expect(missing?.status).toBe('registered-missing-on-server');
    expect(missing?.registeredModel).toMatchObject({ id: 'row-1', slug: 'llama3-1-8b', resourceStatus: 'ENABLED' });
  });

  it('matches on sourceUri AND on slug, and passes engine load state through', async () => {
    const { service } = makeService({
      text: [
        {
          name: 'vllm',
          probe_status: 'ok',
          models: [
            { name: 'llama3.1:8b', state: 'loaded' },
            { name: 'matched-by-slug', state: 'not-loaded' },
          ],
        },
      ],
      dbRows: [dbRow(), dbRow({ id: 'row-2', slug: 'matched-by-slug', sourceUri: 'something-else' })],
    });

    const result = await service.discover();
    const byName = Object.fromEntries(result.entries.map((e) => [e.modelName, e]));

    expect(byName['llama3.1:8b']).toMatchObject({ status: 'registered', loadState: 'loaded' });
    expect(byName['matched-by-slug']).toMatchObject({ status: 'registered', loadState: 'not-loaded' });
    expect(result.entries).toHaveLength(2);
  });

  it('degrades DB rows to registered/unknown when the provider probe is not ok', async () => {
    const { service } = makeService({
      text: [{ name: 'vllm', probe_status: 'timeout', probe_error: 'probe exceeded 5.0s', models: [] }],
      dbRows: [dbRow()],
    });

    const result = await service.discover();

    // No FALSE "missing on server" from a transient probe failure.
    expect(result.entries[0]).toMatchObject({ status: 'registered', loadState: 'unknown' });
    expect(result.probes).toEqual(expect.arrayContaining([expect.objectContaining({ provider: 'vllm', probeStatus: 'timeout' })]));
  });

  it('reports probeStatus error for the whole probe when TEXT itself is unreachable', async () => {
    const { service } = makeService({ textError: new Error('ECONNREFUSED'), dbRows: [dbRow()] });

    const result = await service.discover();

    expect(result.probes[0]?.probeStatus).toBe('error');
    expect(result.entries[0]).toMatchObject({ status: 'registered', loadState: 'unknown' });
  });

  it('filters to a single provider when asked', async () => {
    const { service, aiModelService } = makeService({
      text: [
        { name: 'vllm', probe_status: 'ok', models: [{ name: 'a' }] },
        { name: 'lm-studio', probe_status: 'ok', models: [{ name: 'b' }] },
      ],
      dbRows: [],
    });

    const result = await service.discover('lm-studio');

    expect(result.entries.map((e) => e.modelName)).toEqual(['b']);
    expect(aiModelService.getAllForAdmin).toHaveBeenCalled();
  });

  it('ignores registry rows on non-server-managed providers (azure has nothing to discover)', async () => {
    const { service } = makeService({
      text: [{ name: 'vllm', probe_status: 'ok', models: [] }],
      dbRows: [dbRow({ id: 'cloud', provider: 'azure', slug: 'gpt-5-mini', sourceUri: 'gpt-5-mini' })],
    });

    const result = await service.discover();

    expect(result.entries).toHaveLength(0);
  });
});

// =============================================================================
// Tenant-aware discovery 
// =============================================================================
describe('AiModelDiscoveryService.discover — tenant-aware engine resolution', () => {
  it("probes the TENANT's own LM Studio when it has one", async () => {
    const { service, post, connections } = makeService({
      text: [{ name: 'lm-studio', probe_status: 'ok', models: [{ name: 'tenant-qwen' }] }],
      overrides: { 'lm-studio': { api_key: 'tenant-key', funding: 'tenant', base_url: 'http://tenant-lms.test/v1' } },
    });

    const result = await service.discover('lm-studio');

    expect(connections.resolveTenantCloudOverrides).toHaveBeenCalledWith('llm', 'tenant-1');
    expect(sentConnections(post)).toEqual({ 'lm-studio': { base_url: 'http://tenant-lms.test/v1', api_key: 'tenant-key' } });
    expect(result.probes.find((p) => p.provider === 'lm-studio')?.connectionSource).toBe('tenant');
    expect(result.entries.map((e) => e.modelName)).toEqual(['tenant-qwen']);
  });

  it('falls back to the SYSTEM engine when the tenant has no connection of its own', async () => {
    const { service, post } = makeService({
      text: [{ name: 'lm-studio', probe_status: 'ok', models: [{ name: 'platform-qwen' }] }],
      overrides: { 'lm-studio': { api_key: 'platform-key', funding: 'platform', base_url: 'http://platform-lms.test/v1' } },
    });

    const result = await service.discover('lm-studio');

    expect(sentConnections(post)['lm-studio']).toMatchObject({ base_url: 'http://platform-lms.test/v1' });
    expect(result.probes.find((p) => p.provider === 'lm-studio')?.connectionSource).toBe('system');
  });

  it('sends a KEYLESS self-hosted row so the probe goes out unauthenticated', async () => {
    // A keyless row injects on neither tier, so it never appears in `overrides`
    // — the cascade still knows its endpoint via `resolveConnection`.
    const { service, post, connections } = makeService({
      text: [{ name: 'ollama', probe_status: 'ok', models: [{ name: 'llama3.1:8b' }] }],
      overrides: {},
      rows: { ollama: { baseUrl: 'http://sys-ollama.test', source: 'system' } },
    });

    const result = await service.discover('ollama');

    expect(connections.resolveConnection).toHaveBeenCalledWith('llm', 'ollama', 'tenant-1');
    expect(sentConnections(post)).toEqual({ ollama: { base_url: 'http://sys-ollama.test' } });
    expect(sentConnections(post).ollama).not.toHaveProperty('api_key');
    expect(result.entries.map((e) => e.modelName)).toEqual(['llama3.1:8b']);
  });

  it('sends no connection for a provider the cascade resolves nothing for', async () => {
    const { service, post } = makeService({
      text: [{ name: 'ollama', probe_status: 'ok', models: [] }],
      overrides: {},
      rows: { ollama: null },
    });

    await service.discover('ollama');

    expect(sentConnections(post)).toEqual({});
  });

  it('fails OPEN: a resolver error still probes, it never 500s the listing', async () => {
    const { service, post } = makeService({
      text: [{ name: 'lm-studio', probe_status: 'ok', models: [{ name: 'x' }] }],
      overridesError: new Error('config db down'),
    });

    const result = await service.discover('lm-studio');

    expect(sentConnections(post)).toEqual({});
    expect(result.entries.map((e) => e.modelName)).toEqual(['x']);
  });

  it('resolves nothing when there is no tenant context', async () => {
    const { service, post, connections } = makeService({
      text: [{ name: 'lm-studio', probe_status: 'ok', models: [] }],
      tenantId: null,
    });

    await service.discover();

    expect(connections.resolveTenantCloudOverrides).not.toHaveBeenCalled();
    expect(sentConnections(post)).toEqual({});
  });

  it('never leaks a credential into the discovery response', async () => {
    const { service } = makeService({
      text: [{ name: 'lm-studio', probe_status: 'ok', models: [{ name: 'x' }] }],
      overrides: { 'lm-studio': { api_key: 'super-secret-key', funding: 'tenant', base_url: 'http://x.test/v1' } },
    });

    const result = await service.discover('lm-studio');

    expect(JSON.stringify(result)).not.toContain('super-secret-key');
  });

  it('only asks about the providers actually being discovered', async () => {
    const { service, connections } = makeService({
      text: [{ name: 'ollama', probe_status: 'ok', models: [] }],
      overrides: {},
      rows: {},
    });

    await service.discover('ollama');

    expect(connections.resolveConnection.mock.calls.map((c: unknown[]) => c[1])).toEqual(['ollama']);
  });
});

// =============================================================================
// Internal-call headers — the outbound POST to TEXT must carry
// `X-Tenant-Id` per the mandatory-tenant-header contract
// (`.claude/rules/00-project-context.md` §"Tenant identity is mandatory on
// internal service calls"). Before the fix this header was omitted entirely,
// so TEXT's own auth middleware 428'd every probe.
// =============================================================================
describe('AiModelDiscoveryService.probeText — internal service headers', () => {
  it('sends X-Tenant-Id on the outbound TEXT probe call', async () => {
    const { service, post } = makeService({
      text: [{ name: 'vllm', probe_status: 'ok', models: [] }],
      tenantId: 'tenant-1',
    });

    await service.discover();

    expect(sentHeaders(post)['X-Tenant-Id']).toBe('tenant-1');
  });

  it('declares a tenant-less internal call rather than omitting the header when there is no tenant context', async () => {
    const { service, post } = makeService({
      text: [{ name: 'vllm', probe_status: 'ok', models: [] }],
      tenantId: null,
    });

    await service.discover();

    expect(sentHeaders(post)['X-Tenant-Id']).toMatch(/^tenantless:/);
  });
});

// =============================================================================
// Register (R2)
// =============================================================================
describe('AiModelDiscoveryService.register', () => {
  it('delegates to AiModelService.create with a derived slug and the verbatim sourceUri', async () => {
    const create = vi.fn().mockResolvedValue({ id: 'new-id' });
    const { service } = makeService({ text: [], dbRows: [], create });

    await service.register({ provider: 'vllm', modelName: 'llama3.1-8b-instruct-q4_K_M' });

    expect(create).toHaveBeenCalledTimes(1);
    expect(create.mock.calls[0][0]).toMatchObject({
      provider: 'vllm',
      slug: 'llama3-1-8b-instruct-q4-k-m',
      sourceUri: 'llama3.1-8b-instruct-q4_K_M',
      name: 'llama3.1-8b-instruct-q4_K_M',
      taskType: 'TEXT_GENERATION',
      category: 'NLP',
      source: 'LOCAL',
    });
  });

  it('honours an explicit slug and name', async () => {
    const create = vi.fn().mockResolvedValue({ id: 'new-id' });
    const { service } = makeService({ text: [], dbRows: [], create });

    await service.register({ provider: 'lm-studio', modelName: 'qwen3-8b', slug: 'my-qwen', name: 'Qwen 3 8B' });

    expect(create.mock.calls[0][0]).toMatchObject({ slug: 'my-qwen', name: 'Qwen 3 8B' });
  });

  it('surfaces the duplicate-slug 400 with an actionable message naming the taken slug', async () => {
    const create = vi.fn().mockRejectedValue(new Error("Model with slug 'qwen3-8b' already exists"));
    const { service } = makeService({ text: [], dbRows: [], create });

    await expect(service.register({ provider: 'lm-studio', modelName: 'qwen3-8b' })).rejects.toThrow(/qwen3-8b/);
    await expect(service.register({ provider: 'lm-studio', modelName: 'qwen3-8b' })).rejects.toThrow(/slug/i);
  });
});

describe('normalizeModelSlug', () => {
  it.each([
    ['llama3.1-8b-instruct-q4_K_M', 'llama3-1-8b-instruct-q4-k-m'],
    ['org/repo-GGUF', 'org-repo-gguf'],
    ['  spaced  name  ', 'spaced-name'],
    ['a...b', 'a-b'],
    ['--edges--', 'edges'],
  ])('normalizes %s -> %s', (input, expected) => {
    expect(normalizeModelSlug(input)).toBe(expected);
  });

  it('caps at 100 characters without leaving a trailing hyphen', () => {
    const slug = normalizeModelSlug(`${'a'.repeat(99)}-${'b'.repeat(30)}`);
    expect(slug.length).toBeLessThanOrEqual(100);
    expect(slug.endsWith('-')).toBe(false);
  });
});

// =============================================================================
// Controller wiring + guard
// =============================================================================
describe('AiModelDiscoveryController metadata', () => {
  it('is decorated @Authorize(["manage","all"]) at class level (super-admin only)', () => {
    const meta = Reflect.getMetadata('required_permissions', AiModelDiscoveryController);
    expect(meta).toEqual(expect.arrayContaining([{ action: 'manage', subject: 'all' }]));
  });

  it('class-level @Controller path is admin/ai-models', () => {
    expect(Reflect.getMetadata(PATH_METADATA, AiModelDiscoveryController)).toBe('admin/ai-models');
  });

  it('discover is bound to GET discovery', () => {
    expect(Reflect.getMetadata(PATH_METADATA, AiModelDiscoveryController.prototype.discover)).toBe('discovery');
    expect(Reflect.getMetadata(METHOD_METADATA, AiModelDiscoveryController.prototype.discover)).toBe(RequestMethod.GET);
  });

  it('register is bound to POST discovery/register', () => {
    expect(Reflect.getMetadata(PATH_METADATA, AiModelDiscoveryController.prototype.register)).toBe('discovery/register');
    expect(Reflect.getMetadata(METHOD_METADATA, AiModelDiscoveryController.prototype.register)).toBe(RequestMethod.POST);
  });
});

describe('AiModelDiscoveryController delegation', () => {
  let service: { discover: ReturnType<typeof vi.fn>; register: ReturnType<typeof vi.fn> };
  let controller: AiModelDiscoveryController;

  beforeEach(() => {
    service = { discover: vi.fn().mockResolvedValue({ entries: [], probes: [], probedAt: 'now' }), register: vi.fn().mockResolvedValue({ id: 'm' }) };
    controller = new AiModelDiscoveryController(service as never);
  });

  it('passes the provider filter through', async () => {
    await controller.discover('vllm');
    expect(service.discover).toHaveBeenCalledWith('vllm');
  });

  it('register is DEPRECATED (TASK-860): answers 410 Gone naming the replacement and never touches the service', async () => {
    const body = { provider: 'vllm', modelName: 'x' };
    await expect(controller.register(body as never)).rejects.toBeInstanceOf(GoneException);
    await expect(controller.register(body as never)).rejects.toThrow(/inventory|register from the bucket/i);
    expect(service.register).not.toHaveBeenCalled();
    expect(Reflect.getMetadata(HTTP_CODE_METADATA, AiModelDiscoveryController.prototype.register)).toBe(HttpStatus.GONE);
  });
});
