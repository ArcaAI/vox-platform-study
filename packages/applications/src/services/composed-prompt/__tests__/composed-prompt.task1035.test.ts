/**
 * OD-9 — the composed-prompt incident record.
 *
 *  - the recorder is FIRE-AND-FORGET: `record()` returns before anything is written, never throws,
 *    and drops (not queues) once too many writes are in flight;
 *  - both messages are Vault-Transit ciphertext — the plaintext never reaches the repository —
 *    and without a Transit-capable provider nothing is written;
 *  - reads are audited, the list carries METADATA only, another tenant's id is a 404;
 *  - the purge HARD-deletes past each tenant's own retention.
 */
import { NotFoundException } from '@nestjs/common';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SysEventType } from '@arcaai/domains';
import { COMPOSED_PROMPT_MAX_IN_FLIGHT, ComposedPromptRecorder, composedPromptDigest } from '../composed-prompt.recorder';
import { ComposedPromptService } from '../composed-prompt.service';

const TENANT = 'tenant-a';
const clsStore: Record<string, unknown> = {};
const cls = {
  get: vi.fn((key: string) => clsStore[key]),
  set: vi.fn((key: string, value: unknown) => {
    clsStore[key] = value;
  }),
  run: vi.fn(async (_options: unknown, work: () => unknown) => work()),
};
const events = { emit: vi.fn() };
const secrets = {
  encrypt: vi.fn(async (plaintext: Buffer) => `vault:v3:${plaintext.toString('base64')}`),
  decrypt: vi.fn(async (ciphertext: string) => Buffer.from(ciphertext.split(':')[2] ?? '', 'base64')),
  getPhiTransitKeyName: () => 'hope-phi',
};
const repository = {
  encryptText: vi.fn(async (_s: unknown, plaintext: string) =>
    plaintext.length === 0 ? { ciphertext: Buffer.alloc(0), keyVersion: null } : { ciphertext: Buffer.from(`ct:${plaintext.length}`), keyVersion: 3 },
  ),
  decryptText: vi.fn(async (_s: unknown, ciphertext: Buffer) => `plain:${ciphertext.toString()}`),
  create: vi.fn(async (entity: unknown) => entity),
  findById: vi.fn(),
  findPage: vi.fn(),
  findTenantIdsWithRecordsBefore: vi.fn(),
  hardDeleteBefore: vi.fn(),
};
const input = {
  tenantId: TENANT,
  consultationId: 'c-1',
  agentSlug: 'casenote-finalization',
  phase: 'finalize',
  provider: 'azure',
  locality: 'cloud' as const,
  system: 'SYSTEM about Ada Lovelace',
  user: 'USER transcript',
};

const recorder = (withSecrets = true) => new ComposedPromptRecorder(repository as never, events as never, cls as never, (withSecrets ? secrets : undefined) as never);

beforeEach(() => {
  vi.clearAllMocks();
  for (const key of Object.keys(clsStore)) delete clsStore[key];
  clsStore.tenantId = TENANT;
  clsStore.user = { id: 'admin-1', roles: ['SUPER_ADMIN'] };
});

describe('ComposedPromptRecorder', () => {
  it('encrypts BOTH messages and persists only ciphertext, a digest and metadata, in the record`s tenant', async () => {
    const saved = await recorder().write(input);

    expect(repository.encryptText).toHaveBeenCalledWith(secrets, 'SYSTEM about Ada Lovelace');
    expect(repository.encryptText).toHaveBeenCalledWith(secrets, 'USER transcript');
    const persisted = repository.create.mock.calls[0]![0] as Record<string, unknown>;
    expect(persisted).toMatchObject({
      tenantId: TENANT,
      consultationId: 'c-1',
      agentSlug: 'casenote-finalization',
      phase: 'finalize',
      provider: 'azure',
      locality: 'cloud',
      keyVersion: 3,
      sha256: composedPromptDigest('SYSTEM about Ada Lovelace', 'USER transcript'),
    });
    expect(JSON.stringify(persisted)).not.toContain('Ada Lovelace');
    expect(saved).not.toBeNull();
    // The event carries metadata, never a message.
    expect(events.emit).toHaveBeenCalledWith(SysEventType.ResourceCreated, expect.objectContaining({ resourceType: 'ComposedPromptRecord' }));
    expect(JSON.stringify(events.emit.mock.calls)).not.toContain('Ada Lovelace');
  });

  it('writes NOTHING without a Transit-capable secrets provider — there is no plaintext column', async () => {
    expect(await recorder(false).write(input)).toBeNull();
    expect(repository.create).not.toHaveBeenCalled();
  });

  it('record() returns before the write, and a failing write never escapes', async () => {
    repository.create.mockRejectedValueOnce(new Error('db down'));
    const instance = recorder();

    expect(() => instance.record(input)).not.toThrow();
    expect(repository.encryptText).not.toHaveBeenCalled();
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));
    expect(repository.encryptText).toHaveBeenCalled();
  });

  it('DROPS a record once too many writes are in flight, rather than queueing', async () => {
    repository.create.mockImplementation(() => new Promise(() => undefined));
    const instance = recorder();
    for (let i = 0; i < COMPOSED_PROMPT_MAX_IN_FLIGHT + 5; i++) instance.record(input);
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));

    expect(repository.encryptText.mock.calls.length).toBe(COMPOSED_PROMPT_MAX_IN_FLIGHT * 2);
    repository.create.mockImplementation(async (entity: unknown) => entity);
  });
});

describe('ComposedPromptService', () => {
  const entity = (over: Record<string, unknown> = {}) => ({
    id: 'r-1',
    tenantId: TENANT,
    consultationId: 'c-1',
    agentSlug: 'casenote-finalization',
    phase: 'finalize',
    provider: 'azure',
    locality: 'cloud',
    systemCiphertext: Buffer.from('S'),
    userCiphertext: Buffer.from('U'),
    sha256: 'abc',
    createdAt: new Date('2026-10-01T00:00:00Z'),
    ...over,
  });
  const settings = { resolve: vi.fn((_key: string, tenantId: string) => ({ value: tenantId === 'tenant-b' ? 7 : 30 })) };
  const service = () => new ComposedPromptService(repository as never, recorder() as never, events as never, cls as never, secrets as never, settings as never);

  it('lists METADATA only, for the caller`s tenant, and audits the read', async () => {
    repository.findPage.mockResolvedValue({ data: [entity()], count: 1 });

    const page = await service().list({ consultationId: 'c-1' });

    expect(repository.findPage).toHaveBeenCalledWith(TENANT, { consultationId: 'c-1' }, 1, 20);
    expect(page.data[0]).toEqual({
      id: 'r-1',
      consultationId: 'c-1',
      agentSlug: 'casenote-finalization',
      phase: 'finalize',
      provider: 'azure',
      locality: 'cloud',
      sha256: 'abc',
      createdAt: '2026-10-01T00:00:00.000Z',
    });
    expect(page.data[0]).not.toHaveProperty('system');
    expect(events.emit).toHaveBeenCalledWith(SysEventType.ResourceViewed, expect.objectContaining({ forceAuditLog: true }));
  });

  it('decrypts one record of the caller`s tenant, audited', async () => {
    repository.findById.mockResolvedValue(entity());

    const detail = await service().getDecrypted('r-1');

    expect(detail).toMatchObject({ id: 'r-1', system: 'plain:S', user: 'plain:U' });
    expect(events.emit).toHaveBeenCalledWith(SysEventType.ResourceViewed, expect.objectContaining({ resourceId: 'r-1', forceAuditLog: true }));
  });

  it('answers 404 for another tenant`s record, never decrypting it', async () => {
    repository.findById.mockResolvedValue(entity({ tenantId: 'tenant-z' }));

    await expect(service().getDecrypted('r-1')).rejects.toBeInstanceOf(NotFoundException);
    expect(repository.decryptText).not.toHaveBeenCalled();
  });

  it('the purge HARD-deletes past EACH tenant`s own retention', async () => {
    const svc = service();
    svc.now = () => new Date('2026-10-31T00:00:00Z');
    repository.findTenantIdsWithRecordsBefore.mockResolvedValue([TENANT, 'tenant-b']);
    repository.hardDeleteBefore.mockResolvedValue(2);

    const outcome = await svc.purgeExpired();

    expect(repository.hardDeleteBefore).toHaveBeenCalledWith(TENANT, new Date('2026-10-01T00:00:00Z'));
    expect(repository.hardDeleteBefore).toHaveBeenCalledWith('tenant-b', new Date('2026-10-24T00:00:00Z'));
    expect(outcome).toEqual({ tenants: 2, deleted: 4 });
  });

  it('accepts the harness`s record without awaiting the write', () => {
    const svc = service();
    expect(() =>
      svc.acceptInternal({ phase: 'workflow', provider: 'lm-studio', locality: 'local', system: 's', user: 'u' } as never, TENANT),
    ).not.toThrow();
    expect(repository.create).not.toHaveBeenCalled();
  });
});
