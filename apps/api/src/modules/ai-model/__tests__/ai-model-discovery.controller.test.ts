/**
 * AI model discovery (merge view + explicit register).
 *
 * Unit level: the TEXT probe transport and `AiModelService` are stubbed, so the
 * assertions are about the MERGE RULE and the register mapping, not HTTP.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { PATH_METADATA, METHOD_METADATA } from '@nestjs/common/constants';
import { RequestMethod } from '@nestjs/common';
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

function makeService(opts: {
  text?: TextProviderEntry[];
  textError?: Error;
  dbRows?: Array<Record<string, unknown>>;
  create?: ReturnType<typeof vi.fn>;
}) {
  const get = opts.textError ? vi.fn().mockRejectedValue(opts.textError) : vi.fn().mockResolvedValue({ data: opts.text ?? [] });
  const httpService = { axiosRef: { get } } as never;
  const configService = { getConfigValue: vi.fn().mockReturnValue('http://text.test') } as never;
  const create = opts.create ?? vi.fn().mockResolvedValue({ id: 'new-id', slug: 's' });
  const aiModelService = {
    getAllForAdmin: vi.fn().mockResolvedValue(opts.dbRows ?? []),
    create,
  };
  const service = new AiModelDiscoveryService(httpService, configService, aiModelService as never, undefined);
  return { service, get, create, aiModelService };
}

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

  it('passes the register body through', async () => {
    const body = { provider: 'vllm', modelName: 'x' };
    await controller.register(body as never);
    expect(service.register).toHaveBeenCalledWith(body);
  });
});
