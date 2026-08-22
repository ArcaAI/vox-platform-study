/**
 * AdminHealthServicesController Unit Tests — TASK-759 (P2).
 *
 * The two CASL-gated downstream probes used to ride the PUBLIC `health`
 * prefix (`GET /api/v1/health/services{,/:serviceKey}`). They are ops
 * telemetry gated on `manage:all | read:TenantTelemetry`, so rule P2 files
 * them on the admin plane: `GET /api/v1/admin/health/services{,/:serviceKey}`.
 *
 * The split is a re-filing, not a re-authorization — the `@CanAny` gate, the
 * class `@ForbidApiKey()`, the 30/60s throttle and the sanitised payload
 * shape all move across unchanged. Everything asserted here about behaviour
 * was previously asserted against `ApiHealthController` in
 * `health.controller.test.ts`; it moved with the handlers.
 *
 * @vitest-environment node
 */

import { PATH_METADATA } from '@nestjs/common/constants';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { AdminHealthServicesController } from '../admin-health-services.controller';

const REQUIRED_PERMISSIONS_KEY = 'required_permissions';
const PERMISSION_MODE_KEY = 'permission_mode';
const API_KEY_FORBIDDEN = 'apiKeyForbidden';
const THROTTLER_LIMIT = 'THROTTLER:LIMIT';
const THROTTLER_TTL = 'THROTTLER:TTL';

const createMockHttpService = () => ({ axiosRef: { get: vi.fn() } });

const createMockConfigService = () => ({
  getConfigValue: vi.fn((key: string) => {
    const map: Record<string, string> = {
      TEXT_URL: 'http://localhost:8862',
      NLP_URL: 'http://localhost:8864',
      STT_URL: 'http://localhost:8861',
      TTS_URL: 'http://localhost:8867',
      GUARDRAIL_URL: 'http://localhost:8863',
      HARNESS_URL: 'http://localhost:8866',
    };
    return map[key];
  }),
});

describe('AdminHealthServicesController', () => {
  let controller: AdminHealthServicesController;
  let mockHttpService: ReturnType<typeof createMockHttpService>;
  let mockConfigService: ReturnType<typeof createMockConfigService>;

  beforeEach(() => {
    vi.clearAllMocks();
    mockHttpService = createMockHttpService();
    mockConfigService = createMockConfigService();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test doubles for the two injected collaborators
    controller = new AdminHealthServicesController(mockHttpService as any, mockConfigService as any);
  });

  // ─────────────────────────────────────────────────────────────────
  // Route taxonomy (the reason this controller exists)
  // ─────────────────────────────────────────────────────────────────
  describe('route taxonomy (TASK-759)', () => {
    it('is mounted on the admin plane at `admin/health/services`', () => {
      expect(Reflect.getMetadata(PATH_METADATA, AdminHealthServicesController)).toBe('admin/health/services');
    });

    it('keeps the by-key sub-path as `:serviceKey` (NOT `:key`)', () => {
      expect(Reflect.getMetadata(PATH_METADATA, AdminHealthServicesController.prototype.checkServices)).toBe('/');
      expect(Reflect.getMetadata(PATH_METADATA, AdminHealthServicesController.prototype.checkServiceByKey)).toBe(':serviceKey');
    });

    it('carries CanAny(manage:all | read:TenantTelemetry) in OR mode — a TENANT_ADMIN must keep reading it', () => {
      for (const handler of [AdminHealthServicesController.prototype.checkServices, AdminHealthServicesController.prototype.checkServiceByKey]) {
        expect(Reflect.getMetadata(REQUIRED_PERMISSIONS_KEY, handler)).toEqual([
          { action: 'manage', subject: 'all' },
          { action: 'read', subject: 'TenantTelemetry' },
        ]);
        expect(Reflect.getMetadata(PERMISSION_MODE_KEY, handler)).toBe('OR');
      }
    });

    it('carries the class-level @ForbidApiKey() the routes had on ApiHealthController', () => {
      expect(Reflect.getMetadata(API_KEY_FORBIDDEN, AdminHealthServicesController)).toBe(true);
    });

    it('preserves the 30/60s throttle the routes inherited before the split', () => {
      expect(Reflect.getMetadata(THROTTLER_LIMIT + 'default', AdminHealthServicesController)).toBe(30);
      expect(Reflect.getMetadata(THROTTLER_TTL + 'default', AdminHealthServicesController)).toBe(60000);
    });
  });

  // ─────────────────────────────────────────────────────────────────
  // Behaviour — moved verbatim from health.controller.test.ts
  // ─────────────────────────────────────────────────────────────────
  describe('GET /api/v1/admin/health/services', () => {
    const textHealthy = {
      data: { status: 'healthy', service: 'text', version: '2.0.0', uptime_seconds: 200, timestamp: '2026-03-02T00:00:00Z', checks: {} },
    };
    const nlpHealthy = {
      data: { status: 'healthy', service: 'nlp', version: '1.0.0', uptime_seconds: 300, timestamp: '2026-03-02T00:00:00Z', checks: {} },
    };
    const sttHealthy = {
      data: { status: 'healthy', service: 'stt', version: '1.0.0', uptime_seconds: 400, timestamp: '2026-03-02T00:00:00Z', checks: {} },
    };
    const ttsHealthy = {
      data: { status: 'healthy', service: 'tts', version: '1.0.0', uptime_seconds: 450, timestamp: '2026-03-02T00:00:00Z', checks: {} },
    };
    const guardrailHealthy = {
      data: { status: 'healthy', service: 'guardrail', version: '1.0.0', uptime_seconds: 500, timestamp: '2026-03-02T00:00:00Z', checks: {} },
    };
    const harnessHealthy = {
      data: { status: 'healthy', service: 'harness', version: '0.1.0', uptime_seconds: 600, timestamp: '2026-03-02T00:00:00Z', checks: {} },
    };

    it('should return health status for all 6 downstream services', async () => {
      mockHttpService.axiosRef.get
        .mockResolvedValueOnce(textHealthy)
        .mockResolvedValueOnce(nlpHealthy)
        .mockResolvedValueOnce(sttHealthy)
        .mockResolvedValueOnce(ttsHealthy)
        .mockResolvedValueOnce(guardrailHealthy)
        .mockResolvedValueOnce(harnessHealthy);

      const result = await controller.checkServices();

      expect(result.status).toBe('healthy');
      for (const key of ['text', 'nlp', 'stt', 'tts', 'guardrail', 'harness']) {
        expect(result.services).toHaveProperty(key);
        expect(result.services[key].status).toBe('healthy');
      }
    });

    it('should return degraded when some services are down', async () => {
      mockHttpService.axiosRef.get
        .mockResolvedValueOnce(textHealthy)
        .mockRejectedValueOnce(new Error('ECONNREFUSED'))
        .mockResolvedValueOnce(sttHealthy)
        .mockResolvedValueOnce(ttsHealthy)
        .mockResolvedValueOnce(guardrailHealthy)
        .mockResolvedValueOnce(harnessHealthy);

      const result = await controller.checkServices();

      expect(result.status).toBe('degraded');
      expect(result.services.nlp.status).toBe('down');
      expect(result.services.text.status).toBe('healthy');
    });

    it('should return unhealthy when all services are down', async () => {
      mockHttpService.axiosRef.get.mockRejectedValue(new Error('ECONNREFUSED'));

      const result = await controller.checkServices();

      expect(result.status).toBe('unhealthy');
      for (const key of ['text', 'nlp', 'stt', 'tts', 'guardrail', 'harness']) {
        expect(result.services[key].status).toBe('down');
      }
    });

    it('should include timestamp in response', async () => {
      mockHttpService.axiosRef.get.mockResolvedValue(textHealthy);

      const result = await controller.checkServices();

      expect(result.timestamp).toBeDefined();
      expect(new Date(result.timestamp).getTime()).not.toBeNaN();
    });

    it('should include service-name response data from healthy services (sanitised — no version)', async () => {
      mockHttpService.axiosRef.get.mockResolvedValue(textHealthy);

      const result = await controller.checkServices();

      expect(result.services.text.service).toBe('Text');
      expect(result.services.guardrail.service).toBe('Guardrail');
      expect(result.services.text).not.toHaveProperty('version');
      expect(result.services.guardrail).not.toHaveProperty('version');
    });

    it('should include error message for down services', async () => {
      mockHttpService.axiosRef.get
        .mockResolvedValueOnce(textHealthy)
        .mockRejectedValueOnce(new Error('Connection refused'))
        .mockResolvedValueOnce(sttHealthy)
        .mockResolvedValueOnce(guardrailHealthy)
        .mockResolvedValueOnce(harnessHealthy);

      const result = await controller.checkServices();

      expect(result.services.nlp.error).toBe('Connection refused');
    });

    it('should call correct health endpoints for each service', async () => {
      mockHttpService.axiosRef.get.mockResolvedValue(textHealthy);

      await controller.checkServices();

      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- vitest mock call tuples
      const calledUrls = mockHttpService.axiosRef.get.mock.calls.map((c: any[]) => c[0]);
      expect(calledUrls).toHaveLength(6);
      expect(calledUrls[0]).toMatch(/localhost:8862\/api\/v1\/health$/);
      expect(calledUrls[1]).toMatch(/localhost:8864\/api\/v1\/health$/);
      expect(calledUrls[2]).toMatch(/localhost:8861\/api\/v1\/health$/);
      expect(calledUrls[3]).toMatch(/localhost:8867\/api\/v1\/health$/);
      // Guardrail mounts health under /api (not /api/v1).
      expect(calledUrls[4]).toMatch(/localhost:8863\/api\/health$/);
      expect(calledUrls[5]).toMatch(/localhost:8866\/api\/v1\/health$/);
    });

    it('strips `version` and `checks` from the public services payload', async () => {
      mockHttpService.axiosRef.get.mockResolvedValue({
        data: { status: 'healthy', service: 'text', version: '2.0.0', uptime_seconds: 200, checks: { gpu: { status: 'healthy' } } },
      });

      const result = await controller.checkServices();

      for (const key of Object.keys(result.services)) {
        expect(result.services[key]).not.toHaveProperty('version');
        expect(result.services[key]).not.toHaveProperty('checks');
      }
    });
  });

  describe('GET /api/v1/admin/health/services/:serviceKey', () => {
    const textHealthy = {
      data: {
        status: 'healthy',
        service: 'text',
        version: '2.0.0',
        uptime_seconds: 200,
        timestamp: '2026-03-02T00:00:00Z',
        checks: { gpu: { status: 'healthy' } },
      },
    };

    it('should return sanitised structured health for a valid service key (no version / no checks)', async () => {
      mockHttpService.axiosRef.get.mockResolvedValueOnce(textHealthy);

      const result = await controller.checkServiceByKey('text');

      expect(result.status).toBe('healthy');
      expect(result.service).toBe('Text');
      expect(result.duration_ms).toBeGreaterThanOrEqual(0);
      expect(result).not.toHaveProperty('version');
      expect(result).not.toHaveProperty('checks');
    });

    it('should return structured down status when service is unreachable', async () => {
      mockHttpService.axiosRef.get.mockRejectedValueOnce(new Error('connect ECONNREFUSED 127.0.0.1:8862'));

      const result = await controller.checkServiceByKey('text');

      expect(result.status).toBe('down');
      expect(result.service).toBe('Text');
      expect(result.error).toContain('ECONNREFUSED');
    });

    it('should return structured down status on timeout', async () => {
      const timeoutErr = new Error('timeout of 5000ms exceeded');
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- axios attaches `code` to its errors
      (timeoutErr as any).code = 'ECONNABORTED';
      mockHttpService.axiosRef.get.mockRejectedValueOnce(timeoutErr);

      const result = await controller.checkServiceByKey('text');

      expect(result.status).toBe('down');
      expect(result.error).toContain('timeout');
    });

    it('should throw NotFoundException for unknown service key', async () => {
      await expect(controller.checkServiceByKey('unknown')).rejects.toThrow();
    });

    it('should never throw 500/502 when a known service is down', async () => {
      mockHttpService.axiosRef.get.mockRejectedValueOnce(new Error('ECONNREFUSED'));

      const result = await controller.checkServiceByKey('guardrail');

      expect(result.status).toBe('down');
      expect(result.service).toBe('Guardrail');
      expect(result.error).toBeDefined();
    });

    it('should accept all five valid service keys', async () => {
      for (const key of ['text', 'nlp', 'stt', 'guardrail', 'harness']) {
        mockHttpService.axiosRef.get.mockResolvedValueOnce(textHealthy);
        const result = await controller.checkServiceByKey(key);
        expect(result.status).toBeDefined();
      }
    });

    it('should include timestamp in response', async () => {
      mockHttpService.axiosRef.get.mockResolvedValueOnce(textHealthy);

      const result = await controller.checkServiceByKey('text');

      expect(result.timestamp).toBeDefined();
      expect(new Date(result.timestamp).getTime()).not.toBeNaN();
    });
  });
});
