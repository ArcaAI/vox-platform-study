/**
 * The readiness routes on `AiServiceAdminController` (TASK-890 §3.12, OD-L):
 * "the platform admin must be able to monitor the readiness of all inference
 * services".
 *
 * Two routes, one read plane: `GET readiness` serves the LAST observation, and
 * `POST readiness/refresh` takes one now. Both inherit the controller's
 * class-level `manage:all` + `@ForbidApiKey()` — a platform-infrastructure
 * document, JWT/service-account only — and the refresh carries its own throttle
 * because it costs an engine probe.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { PATH_METADATA } from '@nestjs/common/constants';
import { API_KEY_FORBIDDEN } from '@arcaai/applications';
import { THROTTLER_LIMIT } from '@nestjs/throttler/dist/throttler.constants';
import { AiServiceAdminController } from '../ai-service-admin.controller';

const SNAPSHOT = {
  checkedAt: '2026-09-06T10:00:00.000Z',
  engines: [
    {
      provider: 'lm-studio',
      providerClass: 'engine-served',
      baseUrlHost: 'lmstudio:1234',
      status: 'up',
      latencyMs: 8,
      loadedCount: 1,
      listedCount: 3,
      detail: null,
    },
    {
      provider: 'ollama',
      providerClass: 'engine-served',
      baseUrlHost: null,
      status: 'down',
      latencyMs: null,
      loadedCount: 0,
      listedCount: 0,
      detail: 'refused',
    },
  ],
  services: [{ key: 'stt', healthy: true, lastSeenAt: '2026-09-06T09:59:50.000Z' }],
  models: {
    'm-1': {
      id: 'm-1',
      slug: 'a',
      taskType: 'TEXT_GENERATION',
      provider: 'lm-studio',
      providerClass: 'engine-served',
      readiness: 'ready',
      detail: null,
    },
  },
};

function makeController() {
  const readiness = {
    getSnapshot: vi.fn().mockResolvedValue(SNAPSHOT),
    sweep: vi.fn().mockResolvedValue(SNAPSHOT),
  };
  const controller = new AiServiceAdminController({} as never, {} as never, readiness as never);
  return { controller, readiness };
}

beforeEach(() => vi.clearAllMocks());

describe('readiness routes — authorization metadata', () => {
  it('inherits the controller’s platform gate: admin/ai-services behind manage:all', () => {
    expect(Reflect.getMetadata(PATH_METADATA, AiServiceAdminController)).toBe('admin/ai-services');
    expect(Reflect.getMetadata('required_permissions', AiServiceAdminController)).toEqual([{ action: 'manage', subject: 'all' }]);
  });

  it('is API-key forbidden at the class level — an engine-topology document is not on the business plane', () => {
    expect(Reflect.getMetadata(API_KEY_FORBIDDEN, AiServiceAdminController)).toBe(true);
  });

  it('mounts the two routes at readiness and readiness/refresh', () => {
    const proto = AiServiceAdminController.prototype as unknown as Record<string, unknown>;
    expect(Reflect.getMetadata(PATH_METADATA, proto.readiness as never)).toBe('readiness');
    expect(Reflect.getMetadata(PATH_METADATA, proto.refreshReadiness as never)).toBe('readiness/refresh');
  });

  it('throttles the refresh — it costs a real engine probe — and leaves the read alone', () => {
    const proto = AiServiceAdminController.prototype as unknown as Record<string, unknown>;
    const limits = Reflect.getMetadata(`${THROTTLER_LIMIT}default`, proto.refreshReadiness as never);
    expect(limits).toBeDefined();
    expect(Reflect.getMetadata(`${THROTTLER_LIMIT}default`, proto.readiness as never)).toBeUndefined();
  });
});

describe('readiness routes — delegation', () => {
  it('serves the stored observation without probing anything', async () => {
    const { controller, readiness } = makeController();

    const response = await controller.readiness();

    expect(readiness.getSnapshot).toHaveBeenCalledTimes(1);
    expect(readiness.sweep).not.toHaveBeenCalled();
    expect(response.checkedAt).toBe(SNAPSHOT.checkedAt);
    expect(response.engines).toHaveLength(2);
    expect(response.services).toHaveLength(1);
    // The map becomes a list on the wire.
    expect(response.models).toEqual([SNAPSHOT.models['m-1']]);
  });

  it('answers an honest empty document — not a 404 — when nothing has been observed yet', async () => {
    const { controller, readiness } = makeController();
    readiness.getSnapshot.mockResolvedValueOnce(null);

    const response = await controller.readiness();

    expect(response).toEqual({ checkedAt: null, engines: [], services: [], models: [] });
  });

  it('refresh runs one sweep now and returns it', async () => {
    const { controller, readiness } = makeController();

    const response = await controller.refreshReadiness();

    expect(readiness.sweep).toHaveBeenCalledTimes(1);
    expect(response.checkedAt).toBe(SNAPSHOT.checkedAt);
  });
});
