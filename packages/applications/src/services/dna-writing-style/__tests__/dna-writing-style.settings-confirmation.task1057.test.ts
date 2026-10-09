/** TASK-1057 — `dnaSettings.update`: `setDnaEnabled` consults the reason policy and records its stamp. */
import { describe, expect, it, vi } from 'vitest';
import { ActionConfirmationService } from '../../settings-registry/action-confirmation.service';
import { DnaWritingStyleService } from '../dna-writing-style.service';

function build(mode: 'required' | 'not-required') {
  const repository = {
    findByUserKeyNamespace: vi.fn(async () => null),
    create: vi.fn(async (e: unknown) => e),
    softDelete: vi.fn(),
    update: vi.fn(),
  };
  const emit = vi.fn();
  const cls = { get: vi.fn((k: string) => (k === 'tenantId' ? 'tenant-1' : k === 'user' ? { id: 'u1', roles: ['DOCTOR'] } : undefined)) };
  const svc = Object.create(DnaWritingStyleService.prototype) as Record<string, unknown>;
  Object.assign(svc, {
    userSettingsRepository: repository,
    eventEmitter: { emit },
    clsService: cls,
    resourceType: 'DnaWritingStyleReport',
    getDnaSettings: vi.fn(async () => ({})),
    confirmations: new ActionConfirmationService({ resolve: vi.fn(() => ({ value: mode })) } as never, {} as never, {} as never, {} as never),
  });
  return { service: svc as unknown as DnaWritingStyleService, repository, emit };
}

describe('DnaWritingStyleService.setDnaEnabled — action confirmation (TASK-1057)', () => {
  it('passes without a reason by default and stamps the sys-event', async () => {
    const { service, repository, emit } = build('not-required');
    await service.setDnaEnabled('doc-1', { enabled: false });
    expect(repository.create).toHaveBeenCalled();
    expect(JSON.stringify(emit.mock.calls)).toContain('reason not required');
  });

  it('refuses 400 CONFIRMATION_REQUIRED before any write when required and missing', async () => {
    const { service, repository } = build('required');
    await expect(service.setDnaEnabled('doc-1', { enabled: false })).rejects.toMatchObject({
      response: { code: 'CONFIRMATION_REQUIRED', actionId: 'dnaSettings.update' },
    });
    expect(repository.create).not.toHaveBeenCalled();
    expect(repository.softDelete).not.toHaveBeenCalled();
  });
});
