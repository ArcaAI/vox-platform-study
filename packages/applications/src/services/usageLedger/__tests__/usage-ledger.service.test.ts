/**
 * UsageLedgerService.recordUsage — the transactional-outbox WRITE path.
 *
 * What this method is and is not: it does NOT write the ledger. It writes an
 * outbox row inside the CALLER'S transaction, so the business row and the
 * intent to meter it commit or roll back together. Nothing is rated here and
 * nothing is derived here — an emitter that omits a field gets an exception,
 * not a guess, because a guess on this path becomes a wrong invoice with no
 * evidence trail.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ArgumentInvalidException } from '@arcaai/exceptions';
import { AiCapability, AiCostBasis, AiDeploymentKind, AiUsageOutboxStatus, AiUsageUnit } from '@arcaai/domains';

import { UsageLedgerService } from '../usage-ledger.service';
import { UsageIdempotencyKey } from '../idempotency-keys';
import type { UsageEventInput } from '../dto';

const TENANT = '50000000-0000-0000-0000-000000000000';
const OCCURRED_AT = new Date('2026-08-06T10:15:30.000Z');

const mockOutboxRepository = {
  create: vi.fn(),
};

function validInput(overrides: Partial<UsageEventInput> = {}): UsageEventInput {
  return {
    tenantId: TENANT,
    idempotencyKey: 'llm:req-1:INPUT_TOKEN',
    occurredAt: OCCURRED_AT,
    capability: AiCapability.LLM,
    operation: 'generate',
    provider: 'anthropic',
    model: 'claude-sonnet-5',
    deployment: AiDeploymentKind.CLOUD,
    unit: AiUsageUnit.INPUT_TOKEN,
    quantity: 1234,
    requestId: 'req-1',
    consultationId: 'consult-1',
    ...overrides,
  };
}

/** The payload the service handed to the repository, already parsed. */
function writtenPayload(callIndex = 0) {
  return mockOutboxRepository.create.mock.calls[callIndex][0].payload;
}

describe('UsageLedgerService.recordUsage — outbox write', () => {
  let service: UsageLedgerService;

  beforeEach(() => {
    vi.clearAllMocks();
    mockOutboxRepository.create.mockImplementation(async (entity: unknown) => entity);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    service = new UsageLedgerService(mockOutboxRepository as any);
  });

  it('writes ONE claimable outbox row carrying the event', async () => {
    const result = await service.recordUsage(validInput());

    expect(mockOutboxRepository.create).toHaveBeenCalledTimes(1);
    const entity = mockOutboxRepository.create.mock.calls[0][0];
    expect(entity.tenantId).toBe(TENANT);
    expect(entity.status).toBe(AiUsageOutboxStatus.PENDING);
    expect(entity.attempts).toBe(0);
    expect(result).toEqual({ outboxIds: [entity.id], events: 1 });
  });

  it('participates in the CALLER’s transaction when a tx client is supplied', async () => {
    // The whole point of an outbox: usage cannot be recorded for work that
    // rolled back, and work cannot commit with its usage lost.
    const tx = { marker: 'caller-tx' };
    await service.recordUsage(validInput(), tx as never);
    expect(mockOutboxRepository.create).toHaveBeenCalledWith(expect.anything(), tx);
  });

  it('serialises occurredAt as ISO and quantity as a string — JSONB must not eat precision', async () => {
    await service.recordUsage(validInput({ quantity: '12.345678' }));

    const payload = writtenPayload();
    expect(payload.version).toBe(1);
    expect(payload.events).toHaveLength(1);
    expect(payload.events[0].occurredAt).toBe('2026-08-06T10:15:30.000Z');
    // A JSON number would round-trip 12.345678 through a float.
    expect(payload.events[0].quantity).toBe('12.345678');
  });

  it('accepts an ISO string occurredAt from a service boundary that already serialised it', async () => {
    await service.recordUsage(validInput({ occurredAt: '2026-08-06T10:15:30.000Z' }));
    expect(writtenPayload().events[0].occurredAt).toBe('2026-08-06T10:15:30.000Z');
  });

  it('accepts an array and packs it into ONE outbox row', async () => {
    const result = await service.recordUsage([
      validInput({ idempotencyKey: 'llm:req-1:INPUT_TOKEN', unit: AiUsageUnit.INPUT_TOKEN, quantity: 100 }),
      validInput({ idempotencyKey: 'llm:req-1:OUTPUT_TOKEN', unit: AiUsageUnit.OUTPUT_TOKEN, quantity: 50 }),
    ]);

    expect(mockOutboxRepository.create).toHaveBeenCalledTimes(1);
    expect(writtenPayload().events).toHaveLength(2);
    expect(result.events).toBe(2);
  });

  it('writes one outbox row PER TENANT when an array spans tenants', async () => {
    // Defensive: an outbox row carries a single tenantId, and mis-stamping it
    // would attribute one tenant's spend to another.
    await service.recordUsage([validInput(), validInput({ tenantId: '60000000-0000-0000-0000-000000000000' })]);
    expect(mockOutboxRepository.create).toHaveBeenCalledTimes(2);
  });

  it('writes nothing and reports zero for an empty array', async () => {
    expect(await service.recordUsage([])).toEqual({ outboxIds: [], events: 0 });
    expect(mockOutboxRepository.create).not.toHaveBeenCalled();
  });
});

describe('UsageLedgerService.recordUsage — the {common, units} batch shape', () => {
  let service: UsageLedgerService;

  beforeEach(() => {
    vi.clearAllMocks();
    mockOutboxRepository.create.mockImplementation(async (entity: unknown) => entity);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    service = new UsageLedgerService(mockOutboxRepository as any);
  });

  it('expands per-unit idempotency keys from the common BASE key', async () => {
    await service.recordUsage({
      common: {
        tenantId: TENANT,
        idempotencyKey: UsageIdempotencyKey.llmRequest('req-9'),
        occurredAt: OCCURRED_AT,
        capability: AiCapability.LLM,
        operation: 'generate.stream',
        provider: 'anthropic',
        model: 'claude-sonnet-5',
        deployment: AiDeploymentKind.CLOUD,
        requestId: 'req-9',
        consultationId: 'consult-9',
      },
      units: [
        { unit: AiUsageUnit.INPUT_TOKEN, quantity: 100 },
        { unit: AiUsageUnit.OUTPUT_TOKEN, quantity: 50 },
        { unit: AiUsageUnit.CACHE_READ_TOKEN, quantity: 900 },
      ],
    });

    const events = writtenPayload().events;
    expect(events.map((e: { idempotencyKey: string }) => e.idempotencyKey)).toEqual([
      'llm:req-9:INPUT_TOKEN',
      'llm:req-9:OUTPUT_TOKEN',
      'llm:req-9:CACHE_READ_TOKEN',
    ]);
    // Attribution is copied onto every row so cost-per-encounter works without a join.
    expect(events.every((e: { consultationId: string }) => e.consultationId === 'consult-9')).toBe(true);
  });

  it('DROPS zero-quantity units — most requests use no cache and no reasoning tokens', async () => {
    await service.recordUsage({
      common: {
        tenantId: TENANT,
        idempotencyKey: UsageIdempotencyKey.llmRequest('req-10'),
        occurredAt: OCCURRED_AT,
        capability: AiCapability.LLM,
        operation: 'generate',
        provider: 'openai',
        deployment: AiDeploymentKind.CLOUD,
      },
      units: [
        { unit: AiUsageUnit.INPUT_TOKEN, quantity: 10 },
        { unit: AiUsageUnit.CACHE_READ_TOKEN, quantity: 0 },
        { unit: AiUsageUnit.REASONING_TOKEN, quantity: 0 },
      ],
    });

    expect(writtenPayload().events).toHaveLength(1);
  });

  it('writes nothing at all when every unit is zero', async () => {
    await service.recordUsage({
      common: {
        tenantId: TENANT,
        idempotencyKey: UsageIdempotencyKey.llmRequest('req-11'),
        occurredAt: OCCURRED_AT,
        capability: AiCapability.LLM,
        operation: 'generate',
        provider: 'openai',
        deployment: AiDeploymentKind.CLOUD,
      },
      units: [{ unit: AiUsageUnit.INPUT_TOKEN, quantity: 0 }],
    });

    expect(mockOutboxRepository.create).not.toHaveBeenCalled();
  });

  it('lets a unit carry its own attributes on top of the common ones', async () => {
    await service.recordUsage({
      common: {
        tenantId: TENANT,
        idempotencyKey: UsageIdempotencyKey.sttStreamSession('sess-1'),
        occurredAt: OCCURRED_AT,
        capability: AiCapability.STT,
        operation: 'transcribe.stream',
        provider: 'whisper_cpp',
        deployment: AiDeploymentKind.SELF_HOSTED,
        sessionId: 'sess-1',
        attributesJson: { engine: 'whisper_cpp', interrupted: true },
      },
      units: [
        { unit: AiUsageUnit.SESSION_SECOND, quantity: 300 },
        { unit: AiUsageUnit.AUDIO_SECOND, quantity: 240, attributesJson: { channelCount: 2 } },
      ],
    });

    const events = writtenPayload().events;
    expect(events[0].attributesJson).toEqual({ engine: 'whisper_cpp', interrupted: true });
    expect(events[1].attributesJson).toEqual({ engine: 'whisper_cpp', interrupted: true, channelCount: 2 });
  });
});

describe('UsageLedgerService.recordUsage — validation (derives nothing silently)', () => {
  let service: UsageLedgerService;

  beforeEach(() => {
    vi.clearAllMocks();
    mockOutboxRepository.create.mockImplementation(async (entity: unknown) => entity);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    service = new UsageLedgerService(mockOutboxRepository as any);
  });

  it('REJECTS a free-text attributesJson key and writes nothing', async () => {
    // The PHI gate. Nothing partial is written: an emitter fixes its payload
    // and retries with the same idempotency keys.
    await expect(service.recordUsage(validInput({ attributesJson: { chiefComplaint: 'chest pain' } as never }))).rejects.toThrow(
      ArgumentInvalidException,
    );
    expect(mockOutboxRepository.create).not.toHaveBeenCalled();
  });

  it('REJECTS an unknown operation', async () => {
    await expect(service.recordUsage(validInput({ operation: 'summarise' as never }))).rejects.toThrow(/operation/i);
  });

  it('REJECTS a mis-shaped provider id', async () => {
    await expect(service.recordUsage(validInput({ provider: 'Azure' }))).rejects.toThrow(/provider/i);
  });

  it('REJECTS a negative or non-numeric quantity', async () => {
    await expect(service.recordUsage(validInput({ quantity: -1 }))).rejects.toThrow(/quantity/i);
    await expect(service.recordUsage(validInput({ quantity: Number.NaN }))).rejects.toThrow(/quantity/i);
    await expect(service.recordUsage(validInput({ quantity: 'lots' }))).rejects.toThrow(/quantity/i);
  });

  it('REJECTS a blank or whitespace-bearing idempotency key', async () => {
    await expect(service.recordUsage(validInput({ idempotencyKey: '' }))).rejects.toThrow(/idempotencyKey/i);
    await expect(service.recordUsage(validInput({ idempotencyKey: 'llm:req 1' }))).rejects.toThrow(/idempotencyKey/i);
  });

  it('REJECTS an unparseable occurredAt', async () => {
    await expect(service.recordUsage(validInput({ occurredAt: 'yesterday' }))).rejects.toThrow(/occurredAt/i);
    await expect(service.recordUsage(validInput({ occurredAt: new Date('nope') }))).rejects.toThrow(/occurredAt/i);
  });

  it('REJECTS a missing tenantId — usage that cannot be attributed must not be recorded', async () => {
    await expect(service.recordUsage(validInput({ tenantId: '' }))).rejects.toThrow(/tenantId/i);
  });

  it('REJECTS an unknown capability / unit / deployment enum value', async () => {
    await expect(service.recordUsage(validInput({ capability: 'VISION' as never }))).rejects.toThrow(/capability/i);
    await expect(service.recordUsage(validInput({ unit: 'MINUTE' as never }))).rejects.toThrow(/unit/i);
    await expect(service.recordUsage(validInput({ deployment: 'ON_PREM' as never }))).rejects.toThrow(/deployment/i);
  });

  it('reports EVERY violation in one exception so an emitter fixes them in one pass', async () => {
    const failure = await service.recordUsage(validInput({ provider: 'Azure', quantity: -1, operation: 'nope' as never })).catch((err: Error) => err);
    expect(failure).toBeInstanceOf(ArgumentInvalidException);
    expect((failure as Error).message).toMatch(/provider/);
    expect((failure as Error).message).toMatch(/quantity/);
    expect((failure as Error).message).toMatch(/operation/);
  });

  it('names the offending row index when an array element is invalid', async () => {
    const failure = await service.recordUsage([validInput(), validInput({ provider: 'Azure' })]).catch((err: Error) => err);
    expect((failure as Error).message).toMatch(/\[1\]/);
  });

  it('does NOT rewrite costBasis for a BYOK deployment — the emitter owns that flag', async () => {
    // Silently deriving BYOK_NOTIONAL would make a forgotten flag invisible.
    // The factory's default (INTERNAL) over-reports platform spend, which is
    // the safe direction to be wrong in; the warning is how it gets noticed.
    await service.recordUsage(validInput({ deployment: AiDeploymentKind.BYOK }));
    expect(writtenPayload().events[0].costBasis).toBe(AiCostBasis.INTERNAL);
  });

  it('carries an explicit BYOK_NOTIONAL through untouched', async () => {
    await service.recordUsage(validInput({ deployment: AiDeploymentKind.BYOK, costBasis: AiCostBasis.BYOK_NOTIONAL }));
    expect(writtenPayload().events[0].costBasis).toBe(AiCostBasis.BYOK_NOTIONAL);
  });

  it('accepts an unknown-but-well-shaped provider — a new connection must still meter', async () => {
    await expect(service.recordUsage(validInput({ provider: 'brand-new-vendor' }))).resolves.toMatchObject({ events: 1 });
  });
});

/**
 * TASK-643 R3 — the deployment/costBasis consistency guard.
 *
 * OD-2 decided a platform-funded (SYSTEM-credential) call meters as the
 * EXISTING `CLOUD` member rather than a new enum value. That keeps every
 * downstream consumer unchanged, but it costs us the one cheap regression
 * detector we would otherwise have had: a mis-stamped call carries no novel
 * enum member, so "did something unknown appear" can never fire. These
 * warnings are therefore the only in-process guard on the pair, which is why
 * the plan records them as not optional.
 *
 * Both directions are wrong in a way money notices:
 *   BYOK + INTERNAL       → platform spend over-reported (pre-existing warn)
 *   CLOUD/SELF_HOSTED
 *          + BYOK_NOTIONAL → platform spend SILENTLY LOST: the drainer
 *                            contributes 0 to every COGS rollup
 *                            (`usage-outbox.drainer.ts`, `costDelta`)
 */
describe('UsageLedgerService.recordUsage — deployment/costBasis consistency warnings', () => {
  let service: UsageLedgerService;
  let warn: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();
    mockOutboxRepository.create.mockImplementation(async (entity: unknown) => entity);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    service = new UsageLedgerService(mockOutboxRepository as any);
    warn = vi.fn();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (service as any).logger = { warn, log: vi.fn(), error: vi.fn(), debug: vi.fn() };
  });

  it('warns on BYOK + INTERNAL (platform spend over-reported)', async () => {
    await service.recordUsage(validInput({ deployment: AiDeploymentKind.BYOK }));
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toMatchObject({ count: 1, tenantId: TENANT, provider: 'anthropic' });
  });

  it('warns on CLOUD + BYOK_NOTIONAL — the platform-default mis-stamp, where COGS is LOST', async () => {
    await service.recordUsage(validInput({ deployment: AiDeploymentKind.CLOUD, costBasis: AiCostBasis.BYOK_NOTIONAL }));
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0].message)).toMatch(/BYOK_NOTIONAL/);
  });

  it('warns on SELF_HOSTED + BYOK_NOTIONAL', async () => {
    await service.recordUsage(validInput({ deployment: AiDeploymentKind.SELF_HOSTED, costBasis: AiCostBasis.BYOK_NOTIONAL }));
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('stays silent on the two CONSISTENT pairs', async () => {
    await service.recordUsage(validInput({ deployment: AiDeploymentKind.CLOUD, costBasis: AiCostBasis.INTERNAL }));
    await service.recordUsage(validInput({ deployment: AiDeploymentKind.BYOK, costBasis: AiCostBasis.BYOK_NOTIONAL }));
    expect(warn).not.toHaveBeenCalled();
  });

  it('never rewrites the pair — it only reports it', async () => {
    await service.recordUsage(validInput({ deployment: AiDeploymentKind.CLOUD, costBasis: AiCostBasis.BYOK_NOTIONAL }));
    expect(writtenPayload().events[0].deployment).toBe(AiDeploymentKind.CLOUD);
    expect(writtenPayload().events[0].costBasis).toBe(AiCostBasis.BYOK_NOTIONAL);
  });
});
