import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { BuildInfo, BuildInfoService, IServiceReleaseService, ServiceReleaseResponse } from '@arcaai/applications';
import {
  buildRegisterInstancePayload,
  normalizeEnvironment,
  resolveInstanceId,
  startServiceReleaseRegistration,
} from '../service-release-registration';

const SAMPLE_BUILD_INFO: BuildInfo = {
  service: 'api',
  version: '2.1.0',
  releaseTag: 'ALL-2.1.0',
  gitBranch: 'main',
  gitCommitSha: '0ab258f9c1d2e3f4a5b6c7d8e9f0011223344557',
  buildAt: '2026-08-09T11:22:33Z',
  ciPipelineId: '12345',
  ciPipelineUrl: 'https://gitlab.example.com/pipelines/12345',
};

const SAMPLE_RESPONSE = { id: 'abc' } as unknown as ServiceReleaseResponse;

function fakeBuildInfoService(buildInfo: BuildInfo = SAMPLE_BUILD_INFO): BuildInfoService {
  return { getBuildInfo: () => buildInfo } as unknown as BuildInfoService;
}

describe('normalizeEnvironment', () => {
  it.each([
    ['development', 'dev'],
    ['dev', 'dev'],
    ['test', 'dev'],
    ['staging', 'staging'],
    ['production', 'prod'],
    ['prod', 'prod'],
    [undefined, 'dev'],
    ['Production', 'prod'],
  ] as const)('normalizes %s -> %s', (raw, expected) => {
    expect(normalizeEnvironment(raw)).toBe(expected);
  });
});

describe('resolveInstanceId', () => {
  const originalHostname = process.env.HOSTNAME;

  afterEach(() => {
    if (originalHostname === undefined) delete process.env.HOSTNAME;
    else process.env.HOSTNAME = originalHostname;
  });

  it('prefers HOSTNAME (Kubernetes pod name)', () => {
    process.env.HOSTNAME = 'api-7d8f9c-abcde';
    expect(resolveInstanceId()).toBe('api-7d8f9c-abcde');
  });

  it('falls back to hostname:pid when HOSTNAME is unset', () => {
    delete process.env.HOSTNAME;
    expect(resolveInstanceId()).toContain(':');
  });
});

describe('buildRegisterInstancePayload', () => {
  it('builds the wire shape from build-info + the two runtime facts', () => {
    const payload = buildRegisterInstancePayload(SAMPLE_BUILD_INFO, 'production', 'api-pod-1');

    expect(payload).toEqual({
      service: 'api',
      version: '2.1.0',
      releaseTag: 'ALL-2.1.0',
      gitBranch: 'main',
      gitCommitSha: '0ab258f9c1d2e3f4a5b6c7d8e9f0011223344557',
      buildAt: '2026-08-09T11:22:33Z',
      ciPipelineId: '12345',
      ciPipelineUrl: 'https://gitlab.example.com/pipelines/12345',
      environment: 'prod',
      instanceId: 'api-pod-1',
    });
  });
});

describe('startServiceReleaseRegistration — never blocks or fails boot', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('does not throw when the in-process call rejects (gateway "down")', async () => {
    const serviceReleaseService: IServiceReleaseService = {
      registerInstance: vi.fn().mockRejectedValue(new Error('database unavailable')),
      attachDigest: vi.fn(),
      listReleases: vi.fn(),
      listCurrent: vi.fn(),
      getHistory: vi.fn(),
    };
    const onError = vi.fn();

    expect(() =>
      startServiceReleaseRegistration(serviceReleaseService, fakeBuildInfoService(), 'development', {
        instanceId: 'api-pod-1',
        onError,
      }),
    ).not.toThrow();

    // Let the fire-and-forget microtask settle.
    await vi.advanceTimersByTimeAsync(0);

    expect(serviceReleaseService.registerInstance).toHaveBeenCalledTimes(1);
    expect(onError).toHaveBeenCalledTimes(1);
  });

  it('does not throw and times out when the in-process call never resolves', async () => {
    const serviceReleaseService: IServiceReleaseService = {
      registerInstance: vi.fn().mockImplementation(() => new Promise(() => {})),
      attachDigest: vi.fn(),
      listReleases: vi.fn(),
      listCurrent: vi.fn(),
      getHistory: vi.fn(),
    };
    const onError = vi.fn();

    const handle = startServiceReleaseRegistration(serviceReleaseService, fakeBuildInfoService(), 'development', {
      instanceId: 'api-pod-1',
      timeoutMs: 100,
      onError,
    });

    await vi.advanceTimersByTimeAsync(150);

    expect(onError).toHaveBeenCalledTimes(1);
    expect((onError.mock.calls[0][0] as Error).message).toMatch(/timed out/);
    handle.stop();
  });

  it('resolves cleanly on a successful registration', async () => {
    const serviceReleaseService: IServiceReleaseService = {
      registerInstance: vi.fn().mockResolvedValue(SAMPLE_RESPONSE),
      attachDigest: vi.fn(),
      listReleases: vi.fn(),
      listCurrent: vi.fn(),
      getHistory: vi.fn(),
    };
    const onError = vi.fn();

    const handle = startServiceReleaseRegistration(serviceReleaseService, fakeBuildInfoService(), 'development', {
      instanceId: 'api-pod-1',
      onError,
    });

    await vi.advanceTimersByTimeAsync(0);

    expect(serviceReleaseService.registerInstance).toHaveBeenCalledWith(
      expect.objectContaining({ service: 'api', environment: 'dev', instanceId: 'api-pod-1' }),
    );
    expect(onError).not.toHaveBeenCalled();
    handle.stop();
  });
});

describe('startServiceReleaseRegistration — heartbeat scheduling + clean shutdown', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('heartbeats on the configured interval', async () => {
    const serviceReleaseService: IServiceReleaseService = {
      registerInstance: vi.fn().mockResolvedValue(SAMPLE_RESPONSE),
      attachDigest: vi.fn(),
      listReleases: vi.fn(),
      listCurrent: vi.fn(),
      getHistory: vi.fn(),
    };

    const handle = startServiceReleaseRegistration(serviceReleaseService, fakeBuildInfoService(), 'development', {
      instanceId: 'api-pod-1',
      intervalMs: 1000,
    });

    await vi.advanceTimersByTimeAsync(0); // initial registration
    await vi.advanceTimersByTimeAsync(3500); // 3 more heartbeats

    expect(serviceReleaseService.registerInstance).toHaveBeenCalledTimes(4);
    handle.stop();
  });

  it('stop() cancels the interval — no leaked timer', async () => {
    const clearIntervalSpy = vi.spyOn(global, 'clearInterval');
    const serviceReleaseService: IServiceReleaseService = {
      registerInstance: vi.fn().mockResolvedValue(SAMPLE_RESPONSE),
      attachDigest: vi.fn(),
      listReleases: vi.fn(),
      listCurrent: vi.fn(),
      getHistory: vi.fn(),
    };

    const handle = startServiceReleaseRegistration(serviceReleaseService, fakeBuildInfoService(), 'development', {
      instanceId: 'api-pod-1',
      intervalMs: 1000,
    });

    await vi.advanceTimersByTimeAsync(0);
    handle.stop();

    expect(clearIntervalSpy).toHaveBeenCalled();

    const callsAtStop = (serviceReleaseService.registerInstance as ReturnType<typeof vi.fn>).mock.calls.length;
    await vi.advanceTimersByTimeAsync(5000);
    expect(serviceReleaseService.registerInstance).toHaveBeenCalledTimes(callsAtStop);
  });

  it('stop() is safe to call twice', async () => {
    const serviceReleaseService: IServiceReleaseService = {
      registerInstance: vi.fn().mockResolvedValue(SAMPLE_RESPONSE),
      attachDigest: vi.fn(),
      listReleases: vi.fn(),
      listCurrent: vi.fn(),
      getHistory: vi.fn(),
    };

    const handle = startServiceReleaseRegistration(serviceReleaseService, fakeBuildInfoService(), 'development', {
      instanceId: 'api-pod-1',
    });

    expect(() => {
      handle.stop();
      handle.stop();
    }).not.toThrow();
  });
});
