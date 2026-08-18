/**
 * ApiHealthController Unit Tests
 *
 * Since TASK-759 this controller is the PUBLIC k8s probe surface and nothing
 * else: `/health`, `/health/live`, `/health/ready`, `/health/startup`. The two
 * CASL-gated downstream probes moved to `AdminHealthServicesController`
 * (`api/v1/admin/health/services`) — their tests moved with them, to
 * `admin-health-services.controller.test.ts`.
 *
 * @vitest-environment node
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { PATH_METADATA } from '@nestjs/common/constants';
import { ApiHealthController } from '../health.controller';

const REQUIRED_PERMISSIONS_KEY = 'required_permissions';
const THROTTLER_LIMIT = 'THROTTLER:LIMIT';
const THROTTLER_TTL = 'THROTTLER:TTL';

const createMockShutdownService = (overrides?: { isReady?: boolean; isShuttingDown?: boolean }) => ({
  isReady: overrides?.isReady ?? true,
  isShuttingDown: overrides?.isShuttingDown ?? false,
});

// Stubbed `BuildInfoService` — the real reader is unit-tested in
// `packages/applications`; here we only need a fixed `version` so the
// controller's `/health` payload can be asserted.
const createMockBuildInfoService = (version = '2.1.0') => ({
  getBuildInfo: vi.fn(() => ({
    service: 'api',
    version,
    releaseTag: `ALL-${version}`,
    gitBranch: 'main',
    gitCommitSha: '0ab258f9c1d2e3f4a5b6c7d8e9f0011223344557',
    buildAt: '2026-08-09T11:22:33Z',
    ciPipelineId: '12345',
    ciPipelineUrl: 'https://gitlab.example.com/pipelines/12345',
  })),
});

describe('ApiHealthController', () => {
  let controller: ApiHealthController;
  let mockShutdownService: ReturnType<typeof createMockShutdownService>;
  let mockBuildInfoService: ReturnType<typeof createMockBuildInfoService>;

  const build = () =>
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test doubles for the two injected collaborators
    new ApiHealthController(mockShutdownService as any, mockBuildInfoService as any);

  beforeEach(() => {
    vi.clearAllMocks();
    mockShutdownService = createMockShutdownService();
    mockBuildInfoService = createMockBuildInfoService();
    controller = build();
  });

  describe('GET /health/live', () => {
    it('should return healthy status', () => {
      expect(controller.liveness()).toEqual({ status: 'healthy' });
    });
  });

  describe('GET /health/ready', () => {
    it('should return healthy when service is ready', () => {
      expect(controller.readiness()).toEqual({ status: 'healthy' });
    });

    it('should throw 503 when service is shutting down', () => {
      mockShutdownService = createMockShutdownService({ isReady: false, isShuttingDown: true });
      controller = build();

      expect(() => controller.readiness()).toThrow();
    });

    it('should throw 503 when service is not ready', () => {
      mockShutdownService = createMockShutdownService({ isReady: false });
      controller = build();

      expect(() => controller.readiness()).toThrow();
    });
  });

  describe('GET /health/startup', () => {
    it('should return healthy when service is ready', () => {
      expect(controller.startup()).toEqual({ status: 'healthy' });
    });

    it('should throw 503 when service is initializing', () => {
      mockShutdownService = createMockShutdownService({ isReady: false, isShuttingDown: false });
      controller = build();

      expect(() => controller.startup()).toThrow();
    });
  });

  describe('GET /health', () => {
    it('should return detailed health check with status healthy when ready', () => {
      const result = controller.check();

      expect(result.status).toBe('healthy');
      expect(result.service).toBe('api');
      expect(result.version).toBeDefined();
      expect(result.uptime_seconds).toBeGreaterThanOrEqual(0);
      expect(result.timestamp).toBeDefined();
      expect(result.checks.process.status).toBe('healthy');
    });

    it('reports the real baked build version, not the npm_package_version placeholder', () => {
      // The API container runs `node dist/main.js` directly, so
      // `npm_package_version` is never injected in any deployed environment
      // and previously always fell back to the `0.1.0` default. `/health`
      // must now report `BuildInfoService`'s baked version instead.
      const result = controller.check();

      expect(result.version).toBe('2.1.0');
      expect(result.version).not.toBe('0.1.0');
      expect(mockBuildInfoService.getBuildInfo).toHaveBeenCalled();
    });

    it('does not leak branch/SHA/CI detail onto the public /health payload', () => {
      const result = controller.check();

      expect(result).not.toHaveProperty('gitBranch');
      expect(result).not.toHaveProperty('gitCommitSha');
      expect(result).not.toHaveProperty('ciPipelineUrl');
      expect(result).not.toHaveProperty('releaseTag');
    });

    it('should return unhealthy when shutting down', () => {
      mockShutdownService = createMockShutdownService({ isReady: false, isShuttingDown: true });
      controller = build();

      const result = controller.check();
      expect(result.status).toBe('unhealthy');
    });

    it('should return degraded when not ready and not shutting down', () => {
      mockShutdownService = createMockShutdownService({ isReady: false, isShuttingDown: false });
      controller = build();

      const result = controller.check();
      expect(result.status).toBe('degraded');
    });
  });

  // ─────────────────────────────────────────────────────────────────
  // TASK-759 — the split. This controller is now PUBLIC-ONLY.
  //   - the four k8s probes stay public and unauthenticated (k3s
  //     liveness/readiness depends on it — non-negotiable)
  //   - the two CASL-gated /services probes are GONE from this class
  //   - the class-level 30/60s probe throttle is unchanged
  // ─────────────────────────────────────────────────────────────────
  describe('public probe surface (TASK-759)', () => {
    it('stays mounted on the public `health` prefix', () => {
      expect(Reflect.getMetadata(PATH_METADATA, ApiHealthController)).toBe('health');
    });

    it('no longer carries the CASL-gated /services handlers — they moved to AdminHealthServicesController', () => {
      expect('checkServices' in ApiHealthController.prototype).toBe(false);
      expect('checkServiceByKey' in ApiHealthController.prototype).toBe(false);
    });

    it('declares NO permission decorator on any remaining handler — every route here is a public probe', () => {
      for (const method of ['liveness', 'readiness', 'startup', 'check'] as const) {
        expect(Reflect.getMetadata(REQUIRED_PERMISSIONS_KEY, ApiHealthController.prototype[method])).toBeUndefined();
      }
    });

    it('keeps the class-level 30 req/60s probe throttle', () => {
      expect(Reflect.getMetadata(THROTTLER_LIMIT + 'default', ApiHealthController)).toBe(30);
      expect(Reflect.getMetadata(THROTTLER_TTL + 'default', ApiHealthController)).toBe(60000);
    });
  });
});
