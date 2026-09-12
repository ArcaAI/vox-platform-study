/**
 * TASK-959 — `ComputeDeviceResolver`, the ONE reader of
 * `metering.compute.deviceByProvider`.
 *
 * `apps/text` is stateless per call and has no device field on any request or
 * model row, so for the LLM engines the device is SUPPLIED by configuration.
 * That makes this resolver the thing that picks between a GPU rate and a vCPU
 * rate, and the tests below are about the one direction it must never fail in:
 * an unresolvable answer records the CHEAPER unit rather than losing the batch.
 */

import { describe, expect, it, vi } from 'vitest';

import { ComputeDeviceResolver } from '../compute-device.resolver';
import { COMPUTE_DEVICE_BY_PROVIDER_KEY } from '../../settings-registry/descriptors/metering-compute.descriptors';

const TENANT = '50000000-0000-0000-0000-000000000000';

function resolverOver(value: unknown) {
  const resolve = vi.fn().mockReturnValue({ key: COMPUTE_DEVICE_BY_PROVIDER_KEY, value, source: 'system' });
  return { resolver: new ComputeDeviceResolver({ resolve } as never), resolve };
}

describe('ComputeDeviceResolver', () => {
  it('answers the device the map names for that provider', async () => {
    const { resolver, resolve } = resolverOver({ 'lm-studio': 'cuda', 'llama-cpp': 'cpu' });

    await expect(resolver.resolve(TENANT, 'lm-studio')).resolves.toBe('cuda');
    await expect(resolver.resolve(TENANT, 'llama-cpp')).resolves.toBe('cpu');
    // The cascade is walked PER TENANT — a key-only read would serve one
    // tenant's self-hosted server settings to every other tenant.
    expect(resolve).toHaveBeenCalledWith(COMPUTE_DEVICE_BY_PROVIDER_KEY, TENANT);
  });

  it('answers cpu for a provider nobody listed — the cheaper unit, never nothing', async () => {
    const { resolver } = resolverOver({ 'lm-studio': 'cuda' });
    await expect(resolver.resolve(TENANT, 'some-byo-server')).resolves.toBe('cpu');
  });

  it('answers cpu when the stored map is not a map at all', async () => {
    for (const broken of [null, undefined, 'cuda', 42, ['cuda']]) {
      const { resolver } = resolverOver(broken);
      await expect(resolver.resolve(TENANT, 'lm-studio')).resolves.toBe('cpu');
    }
  });

  it('refuses a device spelling outside the closed vocabulary', async () => {
    // `gpu` is the plausible near-miss. Passing it through would be rejected by
    // `validateUsageAttributes` at emit time — AFTER it had already chosen the
    // unit — and take the whole usage batch with it.
    const { resolver } = resolverOver({ vllm: 'gpu' });
    await expect(resolver.resolve(TENANT, 'vllm')).resolves.toBe('cpu');
  });

  it('answers cpu when the settings read itself throws, rather than losing the usage', async () => {
    const resolve = vi.fn().mockImplementation(() => {
      throw new Error('settings cache is cold');
    });
    const resolver = new ComputeDeviceResolver({ resolve } as never);
    await expect(resolver.resolve(TENANT, 'lm-studio')).resolves.toBe('cpu');
  });

  it('resolves the platform lane when there is no tenant in context', async () => {
    const { resolver, resolve } = resolverOver({ vllm: 'cuda' });
    await expect(resolver.resolve(null, 'vllm')).resolves.toBe('cuda');
    expect(resolve).toHaveBeenCalledWith(COMPUTE_DEVICE_BY_PROVIDER_KEY, null);
  });

  it('degrades to cpu when no settings cascade is wired at all', async () => {
    const resolver = new ComputeDeviceResolver(undefined);
    await expect(resolver.resolve(TENANT, 'lm-studio')).resolves.toBe('cpu');
  });
});
