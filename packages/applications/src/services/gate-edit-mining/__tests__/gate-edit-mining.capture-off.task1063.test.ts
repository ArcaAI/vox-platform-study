/**
 * TASK-1063 item 4 — `gateEdit.exemplarCapture.enabled` (platform, default OFF).
 * Off: no GateEditExemplar row from gate mining OR feedback mining, and no redaction call.
 * On: unchanged. Reads/exports of existing rows are unaffected.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';

import {
  GATE_EDIT_EXEMPLAR_CAPTURE_ENABLED_DEFAULT,
  GATE_EDIT_EXEMPLAR_CAPTURE_ENABLED_KEY,
} from '../../settings-registry/descriptors/gate-edit-exemplar-capture.descriptors';
import { HOPE_SETTINGS_REGISTRY } from '../../settings-registry/registry';
import { GateEditMiningService } from '../gate-edit-mining.service';

const TENANT = 'tenant-1';
const NOTE = ['Assessment:', 'Cough.', '', 'Plan:', '- Rest.'].join('\n');

const repository = {
  create: vi.fn(async (e: unknown) => e),
  update: vi.fn(async (_i: string, e: unknown) => e),
  findFirst: vi.fn(),
  findByConsultation: vi.fn(async () => null),
  findTopForRetrieval: vi.fn(async () => []),
  findForCorpusExport: vi.fn(async () => []),
};
const cls = { get: vi.fn(), set: vi.fn(), run: vi.fn(async (cb: () => unknown) => cb()) };
const redactor = { redact: vi.fn(async (t: string) => t) };

const settings = (value: unknown, throws = false) => ({
  resolveEffective: vi.fn(async (key: string) => {
    if (throws) throw new Error('down');
    return { key, value, tier: 'global-kv', sourceScope: 'system' };
  }),
});
const build = (s?: unknown) => new GateEditMiningService(repository as never, { emit: vi.fn() } as never, cls as never, redactor as never, s as never);

const gate = { tenantId: TENANT, consultationId: 'c-1', departmentId: 'd', visitType: 'v', gateDecision: 'PASS', deliveredContent: NOTE, signedContent: NOTE };
const feedback = { tenantId: TENANT, consultationId: 'c-1', rating: 'DOWN', targetKind: 'TEXT', targetContent: 'Cough.' };

beforeEach(() => vi.clearAllMocks());

describe('gateEdit.exemplarCapture.enabled', () => {
  it('is registered as a platform boolean defaulting to false', () => {
    const d = HOPE_SETTINGS_REGISTRY.getOrThrow(GATE_EDIT_EXEMPLAR_CAPTURE_ENABLED_KEY);
    expect(d).toMatchObject({ tier: 'global-kv', dataType: 'boolean', default: false, maxScope: 'system', failMode: 'open-to-default' });
    expect(GATE_EDIT_EXEMPLAR_CAPTURE_ENABLED_DEFAULT).toBe(false);
  });

  it.each([
    ['setting false', settings(false)],
    ['setting unresolvable', settings(true, true)],
    ['no settings service', undefined],
  ])('writes nothing and never redacts when off (%s)', async (_n, s) => {
    const service = build(s);
    await service.mineFromGateDecision(gate as never);
    await service.mineFromFeedback(feedback as never);
    expect(repository.create).not.toHaveBeenCalled();
    expect(repository.update).not.toHaveBeenCalled();
    expect(redactor.redact).not.toHaveBeenCalled();
  });

  it('creates exemplars as before when on', async () => {
    const service = build(settings(true));
    await service.mineFromGateDecision(gate as never);
    await service.mineFromFeedback(feedback as never);
    expect(redactor.redact).toHaveBeenCalled();
    expect(repository.create).toHaveBeenCalledTimes(2);
  });

  it('still reads and exports existing rows when off', async () => {
    const service = build(settings(false));
    await service.retrieveExemplars({ tenantId: TENANT, limit: 3 });
    await service.exportCorpusCandidates({ tenantId: TENANT } as never);
    expect(repository.findTopForRetrieval).toHaveBeenCalled();
    expect(repository.findForCorpusExport).toHaveBeenCalled();
  });
});
