/** TASK-1057 — `agent.sync` consults the platform reason policy before any copy is written. */
import { BadRequestException } from '@nestjs/common';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AgentService } from '../agent.service';
import { ActionConfirmationService } from '../../settings-registry/action-confirmation.service';

const TENANT = '50000000-0000-0000-0000-000000000000';
const PARTNER = '50000000-0000-0000-0000-000000000077';

const cls = {
  get: vi.fn((key: string) => (key === 'tenantId' ? TENANT : key === 'user' ? { id: 'user-1', roles: [] } : undefined)),
  set: vi.fn(),
  run: vi.fn((optionsOrCallback: unknown, maybeCallback?: unknown) =>
    (typeof optionsOrCallback === 'function' ? optionsOrCallback : (maybeCallback as () => unknown))(),
  ),
};
const events = { emit: vi.fn() };
const fallbackRepository = { findByAgentId: vi.fn(async () => []) };
const databaseService = { baseClient: { $transaction: vi.fn((cb: (tx: unknown) => unknown) => cb({})) } };

const SOURCE = { id: 'agent-1', slug: 'clinic-summarizer', name: 'Clinic summarizer', versionNumber: 3 };

function confirmations(mode?: string) {
  return new ActionConfirmationService({ resolve: vi.fn(() => ({ value: mode })) } as never, {} as never, {} as never, {} as never);
}

function makeService(policy: ActionConfirmationService) {
  const positional: unknown[] = [{}, fallbackRepository, {}, events, cls, databaseService, ...Array.from({ length: 13 }, () => undefined), policy];
  const service = new (AgentService as unknown as new (...args: unknown[]) => AgentService)(...positional);
  const internals = service as unknown as Record<string, unknown>;
  internals.resolveOwnSource = vi.fn(async () => SOURCE);
  internals.assertManagesAgentsIn = vi.fn(async () => undefined);
  internals.assertPortableAcrossTenants = vi.fn(async () => undefined);
  const writeCopy = vi.fn(async (_s: unknown, target: string) => ({
    saved: { id: `copy-${target}`, slug: SOURCE.slug, versionNumber: 1 },
    warnings: [],
  }));
  internals.writeCopy = writeCopy;
  return { service, writeCopy };
}

beforeEach(() => vi.clearAllMocks());

describe('agent.sync', () => {
  it('passes without a reason under the default policy and stamps "not required" on each event', async () => {
    const { service } = makeService(confirmations());
    const broadcast = vi.spyOn(service as never, 'broadcastSysEvent') as unknown as ReturnType<typeof vi.fn>;
    await service.syncToTenants('clinic-summarizer', { targetTenantIds: [PARTNER] });
    expect(broadcast.mock.calls[0][1].data.confirmation).toMatchObject({ actionId: 'agent.sync', required: false, note: 'reason not required' });
  });

  it('refuses 400 CONFIRMATION_REQUIRED before any copy is written when required and missing', async () => {
    const { service, writeCopy } = makeService(confirmations('required'));
    const error = await service.syncToTenants('clinic-summarizer', { targetTenantIds: [PARTNER] }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(BadRequestException);
    expect((error as BadRequestException).getResponse()).toMatchObject({ code: 'CONFIRMATION_REQUIRED', actionId: 'agent.sync' });
    expect(writeCopy).not.toHaveBeenCalled();
    expect(databaseService.baseClient.$transaction).not.toHaveBeenCalled();
  });
});
