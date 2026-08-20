/**
 * ServiceReleaseInternalController unit tests.
 *
 * @vitest-environment node
 */
import { DataNotFoundException } from '@arcaai/exceptions';
import { describe, expect, it, vi } from 'vitest';
import { ServiceReleaseInternalController } from '../service-release-internal.controller';

const createMockService = () => ({
  registerInstance: vi.fn(),
  attachDigest: vi.fn(),
  listReleases: vi.fn(),
  listCurrent: vi.fn(),
  getHistory: vi.fn(),
});

const registerRequest = {
  service: 'text',
  version: '2.1.0',
  releaseTag: 'TEXT-2.1.0',
  gitBranch: 'main',
  gitCommitSha: '0ab258f9c1d2e3f4a5b6c7d8e9f0011223344557',
  buildAt: '2026-08-09T11:22:33.000Z',
  ciPipelineId: '12345',
  ciPipelineUrl: 'https://gitlab.example.com/pipelines/12345',
  environment: 'dev',
  instanceId: 'text-0',
};

describe('ServiceReleaseInternalController', () => {
  it('delegates registration (self-registration + heartbeat) to the service', async () => {
    const service = createMockService();
    const response = { id: 'release-1', serviceName: 'text', version: '2.1.0' };
    service.registerInstance.mockResolvedValue(response);

    const controller = new ServiceReleaseInternalController(service as any);
    const result = await controller.register(registerRequest as any);

    expect(service.registerInstance).toHaveBeenCalledWith(registerRequest);
    expect(result).toBe(response);
  });

  it('delegates digest attachment to the service', async () => {
    const service = createMockService();
    const digestRequest = {
      service: 'text',
      gitCommitSha: '0ab258f9c1d2e3f4a5b6c7d8e9f0011223344557',
      imageRepository: 'registry.gitlab/arca/hope/text',
      imageDigest: `sha256:${'a'.repeat(64)}`,
    };
    const response = { id: 'release-1', serviceName: 'text', imageDigest: digestRequest.imageDigest };
    service.attachDigest.mockResolvedValue(response);

    const controller = new ServiceReleaseInternalController(service as any);
    const result = await controller.attachDigest(digestRequest as any);

    expect(service.attachDigest).toHaveBeenCalledWith(digestRequest);
    expect(result).toBe(response);
  });

  it('propagates a 404 (DataNotFoundException) for digest on an unknown (service, sha) — creates no row', async () => {
    const service = createMockService();
    const digestRequest = {
      service: 'unknown-service',
      gitCommitSha: '0ab258f9c1d2e3f4a5b6c7d8e9f0011223344557',
      imageDigest: `sha256:${'b'.repeat(64)}`,
    };
    service.attachDigest.mockRejectedValue(new DataNotFoundException('serviceRelease', 'unknown-service@sha'));

    const controller = new ServiceReleaseInternalController(service as any);

    await expect(controller.attachDigest(digestRequest as any)).rejects.toThrow(DataNotFoundException);
    // The controller must not attempt any create-shaped call on a 404 — it
    // only ever calls attachDigest, which itself is documented to never
    // create a row.
    expect(service.registerInstance).not.toHaveBeenCalled();
  });
});
