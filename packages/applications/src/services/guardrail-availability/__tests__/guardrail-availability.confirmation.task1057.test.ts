/** TASK-1057 — `guardrailAvailability.update` consults the platform reason policy and records its stamp. */
import { SYSTEM_TENANT_ID } from '@arcaai/domains';
import { describe, expect, it, vi } from 'vitest';
import { ActionConfirmationService } from '../../settings-registry/action-confirmation.service';
import { GuardrailAvailabilityService } from '../guardrail-availability.service';

const TENANT_A = 'aaaaaaaa-0000-0000-0000-000000000001';

function build(mode: 'required' | 'not-required') {
  const repository = {
    findByTenantId: vi.fn(async () => null),
    create: vi.fn(async (c: { tenantId: string; policies: Record<string, unknown> }) => ({ id: 'r1', version: 1, hasChanges: false, ...c })),
  };
  const emit = vi.fn();
  const user = { id: 'root', tenantId: SYSTEM_TENANT_ID, roles: ['SUPER_ADMIN'] };
  const cls = { get: vi.fn((k: string) => (k === 'user' ? user : k === 'tenantId' ? SYSTEM_TENANT_ID : undefined)) };
  const confirmations = new ActionConfirmationService({ resolve: vi.fn(() => ({ value: mode })) } as never, {} as never, {} as never, {} as never);
  const service = new GuardrailAvailabilityService(repository as never, { emit } as never, cls as never, undefined, confirmations);
  return { service, repository, emit };
}

const BODY = { policies: { directions: { inbound: { enabled: true } } }, expectedVersion: 0 };

describe('GuardrailAvailabilityService — action confirmation (TASK-1057)', () => {
  it('passes without a reason by default and stamps the sys-event', async () => {
    const { service, repository, emit } = build('not-required');
    await service.putForTenant(TENANT_A, BODY);
    expect(repository.create).toHaveBeenCalled();
    expect(JSON.stringify(emit.mock.calls)).toContain('reason not required');
  });

  it('refuses 400 CONFIRMATION_REQUIRED before any write when required and missing', async () => {
    const { service, repository } = build('required');
    await expect(service.putForTenant(TENANT_A, BODY)).rejects.toMatchObject({
      response: { code: 'CONFIRMATION_REQUIRED', actionId: 'guardrailAvailability.update' },
    });
    expect(repository.create).not.toHaveBeenCalled();
  });
});
