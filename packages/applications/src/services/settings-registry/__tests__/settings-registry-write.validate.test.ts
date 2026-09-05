/**
 * Settings-registry write lane — the descriptor-declared INVARIANT hook.
 *
 * `dataType` can say "an array of strings". It cannot say "this entry must come before that
 * one", and an ordered list is exactly where that gap bites. The hook is
 * `SettingDescriptor.validate`, and the point of these tests is that it is DESCRIPTOR-DRIVEN
 * exactly like every other guard in this lane: the write service names no key. They prove it by
 * patching `validate` onto an UNRELATED descriptor and watching the same enforcement point fire.
 *
 * (The hook's first exemplar, the `consultation.endpoint.actions` ordering invariant, retired
 * with that key in TASK-882 — the endpoint stage is read off the assigned graph now. The hook
 * itself stays in use: `mcp-egress.descriptors.ts` declares one.)
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { HOPE_SETTINGS_REGISTRY } from '../registry';
import { SettingsRegistryWriteService } from '../settings-registry-write.service';

const appSettings = { getFromCache: vi.fn(), getValueFromCache: vi.fn(), refreshCache: vi.fn().mockResolvedValue(undefined) };
const globalSettings = { update: vi.fn(), create: vi.fn() };
const globalSettingRepository = { findFirst: vi.fn() };

const SUPER_ADMIN = { id: 'user-1', roles: ['SUPER_ADMIN'] };
const cls = {
  get: vi.fn((k: string) => (k === 'user' ? SUPER_ADMIN : k === 'tenantId' ? 'tenant-1' : undefined)),
  set: vi.fn(),
  run: vi.fn(async (fn: () => unknown) => fn()),
};

function buildService() {
  return new SettingsRegistryWriteService(
    appSettings as never,
    globalSettings as never,
    { emit: vi.fn() } as never,
    cls as never,
    globalSettingRepository as never,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  globalSettingRepository.findFirst.mockResolvedValue(null);
  globalSettings.create.mockResolvedValue({ id: 'row-1', version: 1 });
  globalSettings.update.mockResolvedValue({ id: 'row-1', version: 2 });
});

describe('SettingsRegistryWriteService — the validate hook is generic, not per-key', () => {
  const OTHER_KEY = 'rateLimit.maxRequests';

  afterEach(() => {
    delete HOPE_SETTINGS_REGISTRY.getOrThrow(OTHER_KEY).validate;
  });

  it('leaves a descriptor that declares no invariant completely unaffected', async () => {
    const svc = buildService();
    expect(HOPE_SETTINGS_REGISTRY.getOrThrow(OTHER_KEY).validate).toBeUndefined();
    await expect(svc.write(OTHER_KEY, 10)).resolves.toBeDefined();
  });

  it('enforces whatever invariant a descriptor declares — the key is never named in the service', async () => {
    HOPE_SETTINGS_REGISTRY.getOrThrow(OTHER_KEY).validate = (value) => (value === 13 ? 'thirteen is not a rate limit' : undefined);
    const svc = buildService();

    await expect(svc.write(OTHER_KEY, 13)).rejects.toThrow(/thirteen is not a rate limit/);
    await expect(svc.write(OTHER_KEY, 12)).resolves.toBeDefined();
  });
});
