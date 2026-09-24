import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PLATFORM_SECRET_SETTINGS } from '../../settings-registry/descriptors/platform-secrets.descriptors';
import { HOPE_SETTINGS_REGISTRY } from '../../settings-registry/registry';
import { toEnvVarName } from '../../settings-registry/registry.types';
import { LmStudioEngineClient, LmStudioEngineError, LM_STUDIO_LOAD_TIMEOUT_MS } from '../lmstudio-engine.client';

/**
 * TASK-1005 — the gateway's LM Studio adapter, against LM Studio REST v1.
 *
 * Every engine response below is a RECORDED answer from the Phase 0 spike on
 * the live llmster pod (2026-09-24, ticket §10.1), trimmed to the fields that
 * matter. The four behaviours the spike forced on the adapter:
 *
 *  1. The load schema is STRICT — `ttl`, `identifier`, `gpu` answer 400
 *     `unrecognized_keys`. Only documented keys may ever be sent.
 *  2. Load is NOT idempotent — loading a loaded key creates a second instance
 *     (`<key>:2`). So the adapter lists first and answers `already_loaded`.
 *  3. A 5 GB LLM takes ~100 s to load, so a load gets 300 s, not the 5 s read
 *     budget — and two concurrent loads on one engine are refused, not raced.
 *  4. The echoed `load_config` carries a huge `prompt_template`; it must never
 *     reach a response or a log.
 */

const BASE = 'http://hope-lmstudio:1234';
const REPO_ROOT = resolve(__dirname, '../../../../../..');

/** The documented REST v1 load keys — nothing else is ever accepted by the engine. */
const DOCUMENTED_LOAD_KEYS = [
  'model',
  'context_length',
  'eval_batch_size',
  'flash_attention',
  'num_experts',
  'offload_kv_cache_to_gpu',
  'echo_load_config',
];

/** `GET /api/v1/models` — one LLM loaded by the pod's preloader, one embedding and one LLM on disk only. */
function listResponse(extraInstances: Array<Record<string, unknown>> = []) {
  return {
    models: [
      {
        type: 'llm',
        publisher: 'google',
        key: 'gemma-4-e2b-it-qat@q4_0',
        display_name: 'Gemma 4 E2B IT QAT',
        quantization: { name: 'Q4_0', bits_per_weight: 4 },
        size_bytes: 3_349_516_256,
        params_string: '2B',
        loaded_instances: [
          {
            id: 'gemma-4-e2b-it-qat',
            config: {
              context_length: 65_536,
              eval_batch_size: 512,
              physical_batch_size: 512,
              parallel: 4,
              flash_attention: true,
              offload_kv_cache_to_gpu: true,
            },
          },
          ...extraInstances,
        ],
        max_context_length: 131_072,
        format: 'gguf',
        capabilities: { vision: true },
      },
      {
        type: 'embedding',
        publisher: 'nomic-ai',
        key: 'text-embedding-nomic-embed-text-v1.5',
        size_bytes: 84_106_624,
        loaded_instances: [],
        max_context_length: 2048,
        format: 'gguf',
      },
      {
        type: 'llm',
        publisher: 'google',
        key: 'gemma-4-e4b-it-qat@q4_0',
        size_bytes: 5_150_000_000,
        loaded_instances: [],
        max_context_length: 131_072,
        format: 'gguf',
      },
    ],
  };
}

/** `POST /api/v1/models/load` for the 5 GB LLM with `echo_load_config` — 98.4 s on the live pod. */
const LLM_LOAD_RESPONSE = {
  type: 'llm',
  instance_id: 'gemma-4-e4b-it-qat@q4_0',
  load_time_seconds: 98.4,
  status: 'loaded',
  load_config: {
    context_length: 4096,
    eval_batch_size: 512,
    physical_batch_size: 512,
    parallel: 4,
    flash_attention: true,
    offload_kv_cache_to_gpu: true,
    prompt_template: { type: 'jinja', jinja_prompt_template: { template: `{% for m in messages %}${'x'.repeat(4000)}{% endfor %}` } },
  },
};

/** `POST /api/v1/models/load` for the embedding model — recorded verbatim. */
const EMBEDDING_LOAD_RESPONSE = {
  type: 'embedding',
  instance_id: 'text-embedding-nomic-embed-text-v1.5',
  load_time_seconds: 0.972,
  status: 'loaded',
};

const UNRECOGNIZED_KEYS = { error: { message: "Unrecognized key(s) in object: 'ttl'", type: 'invalid_request', code: 'unrecognized_keys' } };
const MODEL_NOT_FOUND = { error: { message: 'No model instance with id "ghost" is loaded', type: 'invalid_request', code: 'model_not_found' } };

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

interface Call {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: Record<string, unknown> | undefined;
}

describe('LmStudioEngineClient — REST v1 (TASK-1005)', () => {
  let calls: Call[];
  let routes: Record<string, (call: Call, signal?: AbortSignal) => Promise<Response> | Response>;
  let secrets: { getSecretOptional: ReturnType<typeof vi.fn> };
  let providerConnections: { resolveConnection: ReturnType<typeof vi.fn> };
  let client: LmStudioEngineClient;

  beforeEach(() => {
    calls = [];
    routes = {
      'GET /api/v1/models': () => json(listResponse()),
      'POST /api/v1/models/load': (call) =>
        json(call.body?.model === 'text-embedding-nomic-embed-text-v1.5' ? EMBEDDING_LOAD_RESPONSE : LLM_LOAD_RESPONSE),
      'POST /api/v1/models/unload': (call) => json({ instance_id: call.body?.instance_id }),
    };
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init: RequestInit = {}) => {
        const method = (init.method ?? 'GET').toUpperCase();
        const call: Call = {
          url,
          method,
          headers: { ...((init.headers as Record<string, string> | undefined) ?? {}) },
          body: typeof init.body === 'string' ? (JSON.parse(init.body) as Record<string, unknown>) : undefined,
        };
        calls.push(call);
        const route = routes[`${method} ${new URL(url).pathname}`];
        if (!route) return json({ error: 'Unexpected endpoint or method.' }, 200);
        return route(call, init.signal ?? undefined);
      }),
    );

    secrets = { getSecretOptional: vi.fn(async () => undefined) };
    providerConnections = { resolveConnection: vi.fn(async () => ({ baseUrl: `${BASE}/v1` })) };
    client = new LmStudioEngineClient(providerConnections as never, secrets as never);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  const loadCalls = () => calls.filter((c) => c.method === 'POST' && c.url.endsWith('/api/v1/models/load'));

  // ── load ──────────────────────────────────────────────────────────────────

  describe('load()', () => {
    it('loads a cold model with ONLY documented keys, and reports what the engine applied', async () => {
      const result = await client.load('gemma-4-e4b-it-qat@q4_0', { contextLength: 4096, flashAttention: true });

      expect(loadCalls()).toHaveLength(1);
      expect(loadCalls()[0].url).toBe(`${BASE}/api/v1/models/load`);
      expect(loadCalls()[0].body).toEqual({ model: 'gemma-4-e4b-it-qat@q4_0', context_length: 4096, flash_attention: true, echo_load_config: true });

      expect(result.outcome).toBe('loaded');
      expect(result.model).toMatchObject({
        modelRef: 'gemma-4-e4b-it-qat@q4_0',
        instanceId: 'gemma-4-e4b-it-qat@q4_0',
        cache: 'llm',
        state: 'loaded',
        device: 'multi',
        bytes: null,
        bytesSource: 'unknown',
        loadSeconds: 98.4,
      });
      expect(result.model.loadConfig).toEqual({
        contextLength: 4096,
        evalBatchSize: 512,
        physicalBatchSize: 512,
        parallel: 4,
        flashAttention: true,
        offloadKvCacheToGpu: true,
      });
    });

    it('never lets the echoed prompt_template into what it returns', async () => {
      const result = await client.load('gemma-4-e4b-it-qat@q4_0', { contextLength: 4096 });
      const serialised = JSON.stringify(result);
      expect(serialised).not.toContain('prompt_template');
      expect(serialised).not.toContain('promptTemplate');
      expect(serialised).not.toContain('jinja');
    });

    it('maps every documented option to its snake_case REST key', async () => {
      await client.load('gemma-4-e4b-it-qat@q4_0', {
        contextLength: 8192,
        evalBatchSize: 256,
        flashAttention: false,
        numExperts: 4,
        offloadKvCacheToGpu: false,
      });
      expect(loadCalls()[0].body).toEqual({
        model: 'gemma-4-e4b-it-qat@q4_0',
        context_length: 8192,
        eval_batch_size: 256,
        flash_attention: false,
        num_experts: 4,
        offload_kv_cache_to_gpu: false,
        echo_load_config: true,
      });
    });

    it('never sends ttl, identifier or gpu — the strict schema 400s each — even when a caller smuggles them in', async () => {
      await client.load('gemma-4-e4b-it-qat@q4_0', { contextLength: 2048, ttl: 120, identifier: 'probe-x', gpu: { ratio: 1 } } as never);
      const body = loadCalls()[0].body ?? {};
      for (const key of Object.keys(body)) expect(DOCUMENTED_LOAD_KEYS, key).toContain(key);
      expect(body).not.toHaveProperty('ttl');
      expect(body).not.toHaveProperty('identifier');
      expect(body).not.toHaveProperty('gpu');
    });

    it('lists before loading: an already-loaded key answers `already_loaded` with the EXISTING instance and never creates `:2`', async () => {
      const result = await client.load('gemma-4-e2b-it-qat@q4_0', { contextLength: 4096 });

      expect(result.outcome).toBe('already_loaded');
      expect(result.model.instanceId).toBe('gemma-4-e2b-it-qat');
      expect(result.model.loadConfig).toEqual({
        contextLength: 65_536,
        evalBatchSize: 512,
        physicalBatchSize: 512,
        parallel: 4,
        flashAttention: true,
        offloadKvCacheToGpu: true,
      });
      expect(loadCalls()).toHaveLength(0);
    });

    it('refuses a key the engine does not carry (MODEL_UNKNOWN) without calling load — no prefix matching', async () => {
      const error = await client.load('gemma-4-e2b-it-qat', {}).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(LmStudioEngineError);
      expect((error as LmStudioEngineError).code).toBe('MODEL_UNKNOWN');
      expect(loadCalls()).toHaveLength(0);
    });

    it('surfaces an engine refusal as LOAD_FAILED carrying the engine`s own reason', async () => {
      routes['POST /api/v1/models/load'] = () => json(UNRECOGNIZED_KEYS, 400);
      const error = await client.load('gemma-4-e4b-it-qat@q4_0', {}).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(LmStudioEngineError);
      expect((error as LmStudioEngineError).code).toBe('LOAD_FAILED');
      expect((error as Error).message).toContain('unrecognized_keys');
      expect((error as Error).message).toContain("Unrecognized key(s) in object: 'ttl'");
    });

    it('refuses to load blind when the engine cannot be listed (ENGINE_UNREACHABLE)', async () => {
      routes['GET /api/v1/models'] = () => {
        throw new TypeError('fetch failed');
      };
      const error = await client.load('gemma-4-e4b-it-qat@q4_0', {}).catch((e: unknown) => e);
      expect((error as LmStudioEngineError).code).toBe('ENGINE_UNREACHABLE');
      expect(loadCalls()).toHaveLength(0);
    });

    it('refuses with ENGINE_NOT_CONFIGURED when no SYSTEM row carries an address', async () => {
      providerConnections.resolveConnection.mockResolvedValue(null);
      const error = await client.load('gemma-4-e4b-it-qat@q4_0', {}).catch((e: unknown) => e);
      expect((error as LmStudioEngineError).code).toBe('ENGINE_NOT_CONFIGURED');
      expect(calls).toHaveLength(0);
    });

    describe('serialisation per engine', () => {
      it('refuses a second concurrent load with a typed LOAD_IN_PROGRESS conflict, then accepts once the first settles', async () => {
        let release!: () => void;
        const gate = new Promise<void>((done) => (release = done));
        routes['POST /api/v1/models/load'] = async () => {
          await gate;
          return json(LLM_LOAD_RESPONSE);
        };

        const first = client.load('gemma-4-e4b-it-qat@q4_0', { contextLength: 4096 });
        const second = await client.load('text-embedding-nomic-embed-text-v1.5', {}).catch((e: unknown) => e);
        expect(second).toBeInstanceOf(LmStudioEngineError);
        expect((second as LmStudioEngineError).code).toBe('LOAD_IN_PROGRESS');

        release();
        await expect(first).resolves.toMatchObject({ outcome: 'loaded' });

        routes['POST /api/v1/models/load'] = () => json(EMBEDDING_LOAD_RESPONSE);
        await expect(client.load('text-embedding-nomic-embed-text-v1.5', {})).resolves.toMatchObject({ outcome: 'loaded' });
      });

      it('releases the engine after a FAILED load too', async () => {
        routes['POST /api/v1/models/load'] = () => json(UNRECOGNIZED_KEYS, 400);
        await expect(client.load('gemma-4-e4b-it-qat@q4_0', {})).rejects.toMatchObject({ code: 'LOAD_FAILED' });

        routes['POST /api/v1/models/load'] = () => json(EMBEDDING_LOAD_RESPONSE);
        await expect(client.load('text-embedding-nomic-embed-text-v1.5', {})).resolves.toMatchObject({ outcome: 'loaded' });
      });

      it('holds the engine through the list step, so two callers cannot both see "not loaded" and double-load', async () => {
        let release!: () => void;
        const gate = new Promise<void>((done) => (release = done));
        routes['GET /api/v1/models'] = async () => {
          await gate;
          return json(listResponse());
        };

        const first = client.load('gemma-4-e4b-it-qat@q4_0', {});
        const second = await client.load('gemma-4-e4b-it-qat@q4_0', {}).catch((e: unknown) => e);
        expect((second as LmStudioEngineError).code).toBe('LOAD_IN_PROGRESS');

        release();
        await first;
        expect(loadCalls()).toHaveLength(1);
      });
    });

    it('gives a load 300 s — a 5 GB model takes ~100 s — not the 5 s read budget', async () => {
      expect(LM_STUDIO_LOAD_TIMEOUT_MS).toBe(300_000);
      vi.useFakeTimers();

      let signal: AbortSignal | undefined;
      routes['POST /api/v1/models/load'] = (_call, s) => {
        signal = s;
        return new Promise<Response>((_, reject) => s?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError'))));
      };

      const pending = client.load('gemma-4-e4b-it-qat@q4_0', {}).catch((e: unknown) => e);
      await vi.advanceTimersByTimeAsync(120_000);
      expect(signal?.aborted).toBe(false);

      await vi.advanceTimersByTimeAsync(LM_STUDIO_LOAD_TIMEOUT_MS);
      const error = await pending;
      expect(signal?.aborted).toBe(true);
      expect((error as LmStudioEngineError).code).toBe('LOAD_FAILED');
    });
  });

  // ── unload ────────────────────────────────────────────────────────────────

  describe('unload()', () => {
    it('unloads an instance by `instance_id` → `unloaded`', async () => {
      const result = await client.unload('gemma-4-e2b-it-qat');
      const call = calls.find((c) => c.url.endsWith('/api/v1/models/unload'));
      expect(call?.body).toEqual({ instance_id: 'gemma-4-e2b-it-qat' });
      expect(result).toEqual({ outcome: 'unloaded', instanceId: 'gemma-4-e2b-it-qat' });
    });

    it('treats an absent instance as `not_loaded`, not an error', async () => {
      routes['POST /api/v1/models/unload'] = () => json(MODEL_NOT_FOUND, 404);
      await expect(client.unload('ghost')).resolves.toEqual({ outcome: 'not_loaded', instanceId: 'ghost' });
    });

    it('throws UNLOAD_FAILED for any other refusal, so a route never reports a resident model as gone', async () => {
      routes['POST /api/v1/models/unload'] = () => json({ error: { message: 'boom', code: 'internal' } }, 500);
      await expect(client.unload('gemma-4-e2b-it-qat')).rejects.toMatchObject({ code: 'UNLOAD_FAILED' });
    });
  });

  // ── report ────────────────────────────────────────────────────────────────

  describe('report() — the pinned `gateway.report` residency shape', () => {
    const fixture = JSON.parse(readFileSync(resolve(REPO_ROOT, 'tests/contracts/model-residency-agent.fixture.json'), 'utf8')) as {
      gateway: { report: Record<string, unknown> & { models: Array<Record<string, unknown>> } };
    };

    it('carries exactly the fixture`s key set, report and model alike', async () => {
      const report = await client.report();
      expect(Object.keys(report).sort()).toEqual(Object.keys(fixture.gateway.report).sort());
      expect(report.models.length).toBeGreaterThan(0);
      for (const model of report.models) {
        expect(Object.keys(model).sort()).toEqual(Object.keys(fixture.gateway.report.models[0]).sort());
      }
    });

    it('reports what LM Studio CAN say and nulls what it cannot — never an invented number', async () => {
      const report = await client.report();
      expect(report.service).toBe('lm-studio');
      expect(report.instance).toBe('hope-lmstudio:1234');
      expect(Number.isNaN(Date.parse(report.reportedAt))).toBe(false);
      expect(report.devices).toEqual([]);
      expect(report.models).toEqual([
        {
          modelRef: 'gemma-4-e2b-it-qat@q4_0',
          aiModelId: null,
          cache: 'llm',
          state: 'loaded',
          device: 'multi',
          bytes: null,
          bytesSource: 'unknown',
          inFlight: null,
          pinned: false,
          adminPinned: false,
          ttlSeconds: null,
          loadedAt: null,
          lastUsedAt: null,
          loadSeconds: null,
          instanceId: 'gemma-4-e2b-it-qat',
          loadConfig: {
            contextLength: 65_536,
            evalBatchSize: 512,
            physicalBatchSize: 512,
            parallel: 4,
            flashAttention: true,
            offloadKvCacheToGpu: true,
          },
        },
      ]);
    });

    it('emits one entry per loaded INSTANCE — a `:2` duplicate shows up as its own row', async () => {
      routes['GET /api/v1/models'] = () =>
        json(
          listResponse([
            { id: 'gemma-4-e2b-it-qat:2', config: { context_length: 4096, parallel: 4, flash_attention: true, prompt_template: { jinja: 'x' } } },
          ]),
        );
      const report = await client.report();
      expect(report.models.map((m) => m.instanceId)).toEqual(['gemma-4-e2b-it-qat', 'gemma-4-e2b-it-qat:2']);
      expect(report.models[1].loadConfig).toEqual({ contextLength: 4096, parallel: 4, flashAttention: true });
      expect(JSON.stringify(report)).not.toContain('jinja');
    });

    it('throws ENGINE_UNREACHABLE rather than reporting an empty engine', async () => {
      routes['GET /api/v1/models'] = () => {
        throw new TypeError('fetch failed');
      };
      await expect(client.report()).rejects.toMatchObject({ code: 'ENGINE_UNREACHABLE' });
    });
  });

  // ── optional auth ─────────────────────────────────────────────────────────

  describe('API token (optional, D-6)', () => {
    it('sends `Authorization: Bearer <token>` on every request when the platform secret is set', async () => {
      secrets.getSecretOptional.mockResolvedValue('lms-token-123');
      await client.report();
      await client.load('gemma-4-e4b-it-qat@q4_0', {});
      await client.unload('gemma-4-e4b-it-qat@q4_0');
      await client.snapshot();

      expect(calls.length).toBeGreaterThanOrEqual(5);
      for (const call of calls) expect(call.headers.Authorization, `${call.method} ${call.url}`).toBe('Bearer lms-token-123');
      expect(secrets.getSecretOptional).toHaveBeenCalledWith('LM_STUDIO_API_TOKEN');
    });

    it('sends NO Authorization header when no token is configured', async () => {
      await client.report();
      await client.load('gemma-4-e4b-it-qat@q4_0', {});
      await client.unload('gemma-4-e4b-it-qat@q4_0');
      for (const call of calls) expect(call.headers).not.toHaveProperty('Authorization');
    });

    it('treats the unfilled CHANGE_ME placeholder as "no token", never as a credential', async () => {
      secrets.getSecretOptional.mockResolvedValue('CHANGE_ME');
      await client.report();
      for (const call of calls) expect(call.headers).not.toHaveProperty('Authorization');
    });

    it('works with no SecretsService at all (unit graphs, hermetic CI)', async () => {
      const bare = new LmStudioEngineClient(providerConnections as never);
      await bare.report();
      for (const call of calls) expect(call.headers).not.toHaveProperty('Authorization');
    });

    it('is a registered `vault-kv` platform secret, so vault-seed-secrets.sh can seed it', () => {
      const descriptor = PLATFORM_SECRET_SETTINGS.find((d) => toEnvVarName(d.key) === 'LM_STUDIO_API_TOKEN');
      expect(descriptor?.key).toBe('lmStudio.apiToken');
      const registered = HOPE_SETTINGS_REGISTRY.getOrThrow('lmStudio.apiToken');
      expect(registered).toMatchObject({ tier: 'vault-kv', sensitivity: 'secret', failMode: 'closed', maxScope: 'system', globalOnly: true });
    });
  });
});
