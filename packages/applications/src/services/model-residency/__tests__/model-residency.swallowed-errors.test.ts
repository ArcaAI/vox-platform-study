import { describe, expect, it, vi } from 'vitest';
import { DataNotFoundException } from '@arcaai/exceptions';
import { ModelResidencyService } from '../model-residency.service';

type Internals = Record<string, (...args: unknown[]) => Promise<unknown>>;

const build = (deps: { prometheus?: unknown; effectiveSettings?: unknown }) => {
  const logger = { warn: vi.fn(), error: vi.fn() };
  const service = Object.create(ModelResidencyService.prototype) as Record<string, unknown>;
  Object.assign(service, deps, { logger });
  return { service: service as unknown as Internals, logger };
};

describe('ModelResidencyService observation reads (documented best-effort)', () => {
  it('a Prometheus outage degrades to "no reading" but leaves a warn with the Error object', async () => {
    const outage = new Error('prometheus unreachable');
    const { service, logger } = build({ prometheus: { instantVector: vi.fn().mockRejectedValue(outage) } });

    await expect(service.readGpus()).resolves.toEqual([]);
    expect(logger.warn).toHaveBeenCalledWith(expect.objectContaining({ error: outage }));
    expect(logger.error).not.toHaveBeenCalled();
  });

  it('a healthy Prometheus with no samples degrades silently', async () => {
    const { service, logger } = build({ prometheus: { instantVector: vi.fn().mockResolvedValue([]) } });

    await expect(service.readGpus()).resolves.toEqual([]);
    expect(logger.warn).not.toHaveBeenCalled();
  });
});

describe('ModelResidencyService.readSettings', () => {
  it('an absent setting takes its default; a settings-store outage is logged and rethrown', async () => {
    const absent = build({ effectiveSettings: { resolveEffective: vi.fn().mockRejectedValue(new DataNotFoundException('GlobalSetting', 'k')) } });
    await expect(absent.service.readSettings()).resolves.toMatchObject({ enforce: expect.any(Boolean) });
    expect(absent.logger.error).not.toHaveBeenCalled();

    const outage = new Error('settings store down');
    const down = build({ effectiveSettings: { resolveEffective: vi.fn().mockRejectedValue(outage) } });
    await expect(down.service.readSettings()).rejects.toBe(outage);
    expect(down.logger.error).toHaveBeenCalledWith(expect.objectContaining({ error: outage }));
  });
});
