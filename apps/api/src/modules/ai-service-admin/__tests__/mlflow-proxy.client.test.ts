/**
 * MlflowProxyClient unit tests.
 *
 * MLflow ships NO authentication of its own (TASK-822 §9.4 — `--app-name
 * basic-auth` deliberately off) and sets `X-Frame-Options: SAMEORIGIN` on every
 * response by default from 3.5.0 onward, so the console can neither frame it
 * nor call it from the browser. The gateway is therefore the ONLY path: it
 * proxies MLflow's own read-only REST verbs server-side and the console's
 * session governs access.
 *
 * The three registry/experiment reads this client uses are GET on MLflow's
 * side (verified against the 3.13 handler table: `/api/2.0/mlflow/{experiments,
 * registered-models,model-versions}/search` all register a GET endpoint), so
 * the proxy stays a pure read plane — no POST verb is exercised anywhere here.
 */
import { HttpException, ServiceUnavailableException } from '@nestjs/common';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MLFLOW_BASE_URL_SETTING, MLFLOW_UI_URL_SETTING, MlflowProxyClient } from '../mlflow-proxy.client';

interface AxiosLike {
  get: ReturnType<typeof vi.fn>;
}

function makeClient(options: { settings?: Record<string, unknown>; get?: AxiosLike['get'] } = {}) {
  const get = options.get ?? vi.fn();
  const httpService = { axiosRef: { get } } as never;
  const appSettings = {
    getValueWithDefault: vi.fn(<T>(key: string, fallback: T) => (options.settings?.[key] as T) ?? fallback),
    getValueFromCache: vi.fn((key: string) => options.settings?.[key] ?? null),
  } as never;
  return { client: new MlflowProxyClient(httpService, appSettings), get, httpService, appSettings };
}

function axiosError(status: number, data: unknown) {
  return { isAxiosError: true, response: { status, data }, message: `Request failed with status code ${status}` };
}

describe('MlflowProxyClient — base URL resolution', () => {
  beforeEach(() => vi.clearAllMocks());

  it('falls back to the local-dev transport address when no GlobalSetting is present', async () => {
    const { client, get } = makeClient({ get: vi.fn().mockResolvedValue({ status: 200, data: {}, headers: {} }) });
    await client.status();
    expect(get.mock.calls[0]?.[0]).toBe('http://localhost:5000/health');
  });

  it('prefers the MLFLOW_URL GlobalSetting and strips a trailing slash', async () => {
    const { client, get } = makeClient({
      settings: { [MLFLOW_BASE_URL_SETTING]: 'http://hope-mlflow.hope-v2-dev.svc:5000/' },
      get: vi.fn().mockResolvedValue({ status: 200, data: {}, headers: {} }),
    });
    await client.status();
    expect(get.mock.calls[0]?.[0]).toBe('http://hope-mlflow.hope-v2-dev.svc:5000/health');
  });
});

describe('MlflowProxyClient — status probe', () => {
  beforeEach(() => vi.clearAllMocks());

  it('reports reachable with the live X-Frame-Options header, never an assumed value', async () => {
    const get = vi.fn(async (url: string) => {
      if (url.endsWith('/health')) return { status: 200, data: 'OK', headers: { 'x-frame-options': 'SAMEORIGIN' } };
      return { status: 200, data: '3.15.2', headers: {} };
    });
    const { client } = makeClient({ get });
    const status = await client.status();

    expect(status.probeStatus).toBe('ok');
    expect(status.reachable).toBe(true);
    expect(status.version).toBe('3.15.2');
    // The header is OBSERVED, so an operator who sets
    // MLFLOW_SERVER_X_FRAME_OPTIONS=NONE flips this without a code change.
    expect(status.frameOptions).toBe('SAMEORIGIN');
    expect(status.embeddable).toBe(false);
    expect(status.embedBlockedReason).toMatch(/X-Frame-Options/);
    expect(typeof status.latencyMs).toBe('number');
  });

  it('treats a missing X-Frame-Options as embeddable-by-header while still requiring a UI URL', async () => {
    const get = vi.fn(async () => ({ status: 200, data: 'OK', headers: {} }));
    const { client } = makeClient({ get });
    const status = await client.status();

    expect(status.frameOptions).toBeNull();
    // No browser-reachable UI URL is configured, so framing is still impossible.
    expect(status.uiUrl).toBeNull();
    expect(status.embeddable).toBe(false);
    expect(status.embedBlockedReason).toMatch(/no browser-reachable/i);
  });

  it('is embeddable only when the header is absent AND a UI URL is configured', async () => {
    const get = vi.fn(async () => ({ status: 200, data: 'OK', headers: { 'x-frame-options': 'NONE' } }));
    const { client } = makeClient({ settings: { [MLFLOW_UI_URL_SETTING]: 'https://mlflow.example.test' }, get });
    const status = await client.status();

    expect(status.uiUrl).toBe('https://mlflow.example.test');
    expect(status.embeddable).toBe(true);
    expect(status.embedBlockedReason).toBeNull();
  });

  it('degrades to an unreachable status document instead of throwing when MLflow is down', async () => {
    const get = vi.fn().mockRejectedValue(new Error('connect ECONNREFUSED 127.0.0.1:5000'));
    const { client } = makeClient({ get });
    const status = await client.status();

    expect(status.reachable).toBe(false);
    expect(status.probeStatus).toBe('error');
    expect(status.error).toBeTruthy();
    // The operator-facing cause must not leak an internal host:port (TASK-768).
    expect(status.error).not.toMatch(/127\.0\.0\.1:5000/);
  });

  it('classifies a timeout distinctly from a transport error', async () => {
    const get = vi.fn().mockRejectedValue({ isAxiosError: true, code: 'ECONNABORTED', message: 'timeout of 10000ms exceeded' });
    const { client } = makeClient({ get });
    expect((await client.status()).probeStatus).toBe('timeout');
  });
});

describe('MlflowProxyClient — read proxies', () => {
  beforeEach(() => vi.clearAllMocks());

  it('searchExperiments GETs MLflow’s own search verb with the caller’s paging window', async () => {
    const get = vi.fn().mockResolvedValue({ status: 200, data: { experiments: [{ experiment_id: '1', name: 'default' }] }, headers: {} });
    const { client } = makeClient({ get });

    const result = await client.searchExperiments({ maxResults: 50, pageToken: 'tok' });

    expect(get).toHaveBeenCalledTimes(1);
    const [url, config] = get.mock.calls[0] as [string, { params: Record<string, unknown> }];
    expect(url).toBe('http://localhost:5000/api/2.0/mlflow/experiments/search');
    expect(config.params).toMatchObject({ max_results: 50, page_token: 'tok' });
    expect(result).toEqual({ experiments: [{ experiment_id: '1', name: 'default' }] });
  });

  it('searchRegisteredModels and searchModelVersions hit their own GET verbs', async () => {
    const get = vi.fn().mockResolvedValue({ status: 200, data: {}, headers: {} });
    const { client } = makeClient({ get });

    await client.searchRegisteredModels({});
    await client.searchModelVersions({ filter: "name='whisper'" });

    expect(get.mock.calls[0]?.[0]).toBe('http://localhost:5000/api/2.0/mlflow/registered-models/search');
    expect(get.mock.calls[1]?.[0]).toBe('http://localhost:5000/api/2.0/mlflow/model-versions/search');
    expect((get.mock.calls[1]?.[1] as { params: Record<string, unknown> }).params).toMatchObject({ filter: "name='whisper'" });
  });

  it('omits undefined query params rather than sending empty strings', async () => {
    const get = vi.fn().mockResolvedValue({ status: 200, data: {}, headers: {} });
    const { client } = makeClient({ get });

    await client.searchRegisteredModels({});

    const { params } = get.mock.calls[0]?.[1] as { params: Record<string, unknown> };
    expect(Object.keys(params)).not.toContain('filter');
    expect(Object.keys(params)).not.toContain('page_token');
  });

  it('passes an upstream HTTP error through with its own status', async () => {
    const get = vi.fn().mockRejectedValue(axiosError(400, { error_code: 'INVALID_PARAMETER_VALUE' }));
    const { client } = makeClient({ get });

    await expect(client.searchExperiments({})).rejects.toBeInstanceOf(HttpException);
    await expect(client.searchExperiments({})).rejects.toMatchObject({ status: 400 });
  });

  it('turns a transport failure into a 503 with no internal address in the message', async () => {
    const get = vi.fn().mockRejectedValue(new Error('getaddrinfo ENOTFOUND hope-mlflow.hope-v2-dev.svc'));
    const { client } = makeClient({ get });

    const error = await client.searchExperiments({}).catch((err: unknown) => err);
    expect(error).toBeInstanceOf(ServiceUnavailableException);
    expect(JSON.stringify((error as HttpException).getResponse())).not.toMatch(/hope-mlflow\.hope-v2-dev\.svc/);
  });
});
