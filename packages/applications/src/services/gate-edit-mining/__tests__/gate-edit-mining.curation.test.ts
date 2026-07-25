/**
 * GateEditMiningService — human curation gate (TASK-553 F-24).
 *
 * The mined few-shot corpus reaches EVERY generation's prompt. It is
 * PHI-redacted at write, but until now nothing human ever approved a row before
 * the model saw it. This adds the missing gate — and, just as importantly, keeps
 * it OFF by default: flipping straight to `enforce` on an uncurated corpus would
 * silently empty the few-shot block, a quality regression indistinguishable from
 * a retrieval outage.
 *
 * So the tests below assert BOTH directions:
 *  * `off` (the default, and any degraded governance read) ⇒ the retrieval query
 *    is byte-identical to the pre-gate one, with no curation predicate at all.
 *  * `enforce` ⇒ only curator-APPROVED rows are eligible.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NotFoundException } from '@nestjs/common';
import { ExemplarCurationStatus } from '@arcaai/domains';
import { GateEditMiningService } from '../gate-edit-mining.service';
import { AGENTIC_FEWSHOT_CURATION_MODE_KEY } from '../../settings-registry/descriptors/agentic-fewshot.descriptors';

const TENANT = 'tenant-1';
const OTHER_TENANT = 'tenant-2';

const row = (overrides: Record<string, unknown> = {}) => ({
  id: 'ex-1',
  tenantId: TENANT,
  redactedAfter: 'REDACTED-NOTE',
  qualitySignal: 'APPROVED_CLEAN',
  curationStatus: ExemplarCurationStatus.PENDING,
  version: 4,
  ...overrides,
});

function build(opts: { mode?: string; resolverThrows?: boolean; wired?: boolean } = {}) {
  const repository = {
    create: vi.fn(),
    update: vi.fn(async (id: string, entity: unknown) => ({ id, ...(entity as object) })),
    updateWithVersion: vi.fn(async (id: string, entity: unknown) => ({ id, ...(entity as object) })),
    findById: vi.fn(async () => row()),
    findByConsultation: vi.fn(),
    findTopForRetrieval: vi.fn(async () => [row()]),
    findForCorpusExport: vi.fn(),
  };
  const cls = {
    get: vi.fn((k: string) => (k === 'tenantId' ? TENANT : k === 'user' ? { id: 'user-1' } : undefined)),
    set: vi.fn(),
    run: vi.fn(async (cb: () => unknown) => cb()),
  };
  const eventEmitter = { emit: vi.fn() };
  const effectiveSettings = {
    resolveEffective: vi.fn(async (key: string) => {
      if (opts.resolverThrows) throw new Error('settings backend down');
      return { key, tier: 'global-kv', value: opts.mode ?? 'off', sourceScope: 'global-kv' };
    }),
  };

  const service = new GateEditMiningService(
    repository as never,
    eventEmitter as never,
    cls as never,
    { redact: vi.fn(async (t: string) => t) } as never,
    (opts.wired ?? true) ? (effectiveSettings as never) : undefined,
  );

  return { service, repository, eventEmitter, effectiveSettings };
}

describe('GateEditMiningService — curation gate on retrieval', () => {
  beforeEach(() => vi.clearAllMocks());

  it('applies NO curation predicate in the default off mode (regression lock)', async () => {
    const { service, repository } = build({ mode: 'off' });

    await service.retrieveExemplars({ tenantId: TENANT, departmentId: 'dept-1', limit: 3 });

    expect(repository.findTopForRetrieval).toHaveBeenCalledWith(expect.not.objectContaining({ curationStatus: expect.anything() }));
  });

  it('filters to curator-APPROVED rows in enforce mode', async () => {
    const { service, repository } = build({ mode: 'enforce' });

    await service.retrieveExemplars({ tenantId: TENANT, departmentId: 'dept-1', limit: 3 });

    expect(repository.findTopForRetrieval).toHaveBeenCalledWith(
      expect.objectContaining({ curationStatus: ExemplarCurationStatus.APPROVED }),
    );
  });

  it('degrades to off (today’s behaviour) when the governance read fails', async () => {
    const { service, repository } = build({ resolverThrows: true });

    const rows = await service.retrieveExemplars({ tenantId: TENANT, limit: 3 });

    expect(repository.findTopForRetrieval).toHaveBeenCalledWith(expect.not.objectContaining({ curationStatus: expect.anything() }));
    expect(rows).toHaveLength(1);
  });

  it('degrades to off when the settings facade is not wired at all', async () => {
    const { service, repository } = build({ wired: false });

    await service.retrieveExemplars({ tenantId: TENANT, limit: 3 });

    expect(repository.findTopForRetrieval).toHaveBeenCalledWith(expect.not.objectContaining({ curationStatus: expect.anything() }));
  });
});

describe('GateEditMiningService — curation write', () => {
  beforeEach(() => vi.clearAllMocks());

  it('records the curator verdict and broadcasts a sys-event', async () => {
    const { service, repository, eventEmitter } = build();

    const result = await service.curateExemplar({ id: 'ex-1', tenantId: TENANT, status: ExemplarCurationStatus.APPROVED });

    expect(result).toEqual(expect.objectContaining({ id: 'ex-1', curationStatus: ExemplarCurationStatus.APPROVED }));
    expect(repository.updateWithVersion).toHaveBeenCalledWith('ex-1', expect.anything(), 4);
    expect(eventEmitter.emit).toHaveBeenCalled();
  });

  it('returns 404 (never 403) for an exemplar owned by another tenant', async () => {
    const { service, repository } = build();
    repository.findById.mockResolvedValue(row({ tenantId: OTHER_TENANT }));

    await expect(service.curateExemplar({ id: 'ex-1', tenantId: TENANT, status: ExemplarCurationStatus.APPROVED })).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(repository.updateWithVersion).not.toHaveBeenCalled();
  });

  it('reads the curation mode under the governed registry key', async () => {
    const { service, effectiveSettings } = build({ mode: 'enforce' });

    await service.retrieveExemplars({ tenantId: TENANT, limit: 1 });

    expect(effectiveSettings.resolveEffective).toHaveBeenCalledWith(AGENTIC_FEWSHOT_CURATION_MODE_KEY, { tenantId: TENANT });
  });
});
