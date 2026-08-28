/**
 * Settings-registry write lane — the descriptor-declared INVARIANT hook.
 *
 * `dataType` can say "an array of strings". It cannot say "this entry must come before that
 * one", and for the consultation endpoint sequence that gap is a clinical-safety hole:
 * `harness.finalize` WRITES the note, `summary.finalize` LOCKS every document of the
 * consultation. Saved in that order the consultation locks an empty record and then has nowhere
 * to put the note — silent loss of the consultation record, from a settings write that the
 * membership check happily accepted.
 *
 * The hook is `SettingDescriptor.validate`, and the point of these tests is that it is
 * DESCRIPTOR-DRIVEN exactly like every other guard in this lane: the write service must contain
 * no `if (key === 'consultation.endpoint.actions')`. The last two cases prove that by patching
 * `validate` onto an UNRELATED descriptor and watching the same enforcement point fire.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ArgumentInvalidException } from '@arcaai/exceptions';
import { HOPE_SETTINGS_REGISTRY } from '../registry';
import { SettingsRegistryWriteService } from '../settings-registry-write.service';
import { CONSULTATION_ENDPOINT_ACTIONS_KEY } from '../../consultation/loop/endpoint-sequence';

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

describe('SettingsRegistryWriteService — consultation endpoint ORDERING invariant', () => {
  it('REFUSES a sequence that locks the documents before the note is written', async () => {
    const svc = buildService();
    await expect(
      svc.write(CONSULTATION_ENDPOINT_ACTIONS_KEY, ['livedoc.stop', 'summary.finalize', 'harness.finalize']),
    ).rejects.toBeInstanceOf(ArgumentInvalidException);
    expect(globalSettings.create).not.toHaveBeenCalled();
  });

  it('says WHY, naming both steps, so the admin can act on the refusal', async () => {
    const svc = buildService();
    await expect(svc.write(CONSULTATION_ENDPOINT_ACTIONS_KEY, ['summary.finalize', 'harness.finalize'])).rejects.toThrow(
      /harness\.finalize[\s\S]*summary\.finalize|summary\.finalize[\s\S]*harness\.finalize/,
    );
  });

  it('accepts the platform default order', async () => {
    const svc = buildService();
    await expect(
      svc.write(CONSULTATION_ENDPOINT_ACTIONS_KEY, ['livedoc.stop', 'session.timeout', 'harness.finalize', 'summary.finalize', 'feedback.capture']),
    ).resolves.toBeDefined();
  });

  // CONDITIONAL on purpose. An admin who drops `harness.finalize` entirely is making a
  // legitimate choice (the realtime lane writes its own sections); only the inverted
  // BOTH-present case is a refusal.
  it('accepts a sequence that locks documents with no note-generation step at all', async () => {
    const svc = buildService();
    await expect(svc.write(CONSULTATION_ENDPOINT_ACTIONS_KEY, ['livedoc.stop', 'summary.finalize'])).resolves.toBeDefined();
  });

  it('accepts a sequence that writes the note and never locks', async () => {
    const svc = buildService();
    await expect(svc.write(CONSULTATION_ENDPOINT_ACTIONS_KEY, ['harness.finalize', 'feedback.capture'])).resolves.toBeDefined();
  });
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
