/**
 * SUBSTRATE EXCLUSIVITY, read side.
 *
 * The platform has two agentic-loop engines and, until this ticket, nothing
 * stopped them governing the same consultation at once:
 *
 *   Substrate A — `ConsultationLoopWorkflow` + `HarnessDocWorkflow`, started
 *     lazily by `LoopContextSignalService.handleContextAdded`.
 *   Substrate B — the `WorkflowInterpreter` running a tenant-authored
 *     `consultation`-palette graph, dispatched at consultation open.
 *
 * Substrate B's `consultation.persistDraft` node calls the SAME `persist_draft`
 * activity `HarnessDocWorkflow` uses, so with both live one `ContextItem` has
 * two uncoordinated writers.
 *
 * This suite pins the READ half of the gate: `loopAllowedFor` now also asks
 * "does a tenant-authored workflow already govern this consultation?", answered
 * from a DURABLE marker on the consultation row rather than recomputed from a
 * race-prone lookup.
 *
 * THE FAIL-SAFE DIRECTION IS DELIBERATELY THE OPPOSITE OF THE ENTITLEMENT GATE.
 * The entitlement gate fails CLOSED (an unresolvable commercial gate must not
 * hand out a paid feature). This gate fails OPEN — TOWARDS Substrate A — because
 * an indeterminate answer that suppresses A yields a consultation with NO
 * documentation at all, which is a worse clinical outcome than one documented by
 * the default engine. Absent marker, missing row, unwired repository and a
 * THROWING read are therefore all "Substrate A governs".
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { TenantSettingsService } from '../../../settings-registry/tenant-settings.service';
import { LoopContextSignalService } from '../loop-context-signal.service';
import { TENANT_WORKFLOW_GOVERNS_MARKER, withGoverningEngineMarker } from '../../governing-engine';
import type { ContextAddedPayload } from '../../events';

const TENANT = 'tenant-1';
const CONSULTATION = 'consultation-1';

/** A consultation row whose metadata carries the Substrate-B marker. */
const governedRow = (consultationId = CONSULTATION) => ({
  id: consultationId,
  tenantId: TENANT,
  metadata: withGoverningEngineMarker(null, { workflowRunId: 'run-1', workflowDefinitionSlug: 'arcaai-consultation-v1' }),
});

/** A consultation row with client-supplied metadata but no marker. */
const ungovernedRow = (consultationId = CONSULTATION) => ({
  id: consultationId,
  tenantId: TENANT,
  metadata: { scheduling: { room: '4B' } },
});

interface Options {
  /** What `ConsultationRepository.findById` resolves to. */
  row?: unknown;
  /** When set, `findById` REJECTS with this error instead of resolving. */
  findByIdError?: Error;
  /** `false` ⇒ no repository wired at all (the silent-undefined case). */
  wired?: boolean;
}

function buildDeps(options: Options = {}) {
  const harnessGatewayService = {
    signalContextAdded: vi.fn().mockResolvedValue({ signaled: true }),
    signalConsultationEnding: vi.fn().mockResolvedValue({ signaled: true }),
    signalLoopCancel: vi.fn().mockResolvedValue({ signaled: true }),
  };
  const appSettings = { getValueFromCache: () => null, getTenantValueFromCache: () => null };
  const tenantSettings = new TenantSettingsService(appSettings as never);
  const findById = vi.fn(async () => {
    if (options.findByIdError) throw options.findByIdError;
    return options.row ?? ungovernedRow();
  });
  const consultationRepository = (options.wired ?? true) ? { findById } : undefined;

  const service = new LoopContextSignalService(
    harnessGatewayService as never,
    tenantSettings,
    { isFeatureEnabled: vi.fn(async () => true) } as never,
    { get: (key: string) => (key === 'tenantId' ? TENANT : null) } as never,
    consultationRepository as never,
  );
  return { service, harnessGatewayService, findById };
}

function payload(overrides: Partial<ContextAddedPayload> = {}): ContextAddedPayload {
  return {
    consultationId: CONSULTATION,
    tenantId: TENANT,
    timestamp: '2026-08-22T10:00:00.000Z',
    contextItemId: 'ctx-1',
    contextType: 'WORKNOTE',
    ...overrides,
  } as ContextAddedPayload;
}

describe('Substrate exclusivity — LoopContextSignalService stands down for a tenant-authored workflow', () => {
  beforeEach(() => vi.clearAllMocks());

  describe('the gate itself', () => {
    it('SUPPRESSES the Substrate A signal when the consultation carries the tenant-workflow marker', async () => {
      const { service, harnessGatewayService } = buildDeps({ row: governedRow() });

      await service.handleContextAdded(payload());

      expect(harnessGatewayService.signalContextAdded).not.toHaveBeenCalled();
    });

    it('SIGNALS as before when no marker is present — the overwhelming-majority path is unchanged', async () => {
      const { service, harnessGatewayService } = buildDeps({ row: ungovernedRow() });

      await service.handleContextAdded(payload());

      expect(harnessGatewayService.signalContextAdded).toHaveBeenCalledTimes(1);
    });

    it('suppresses the consultation-ending signal too when Substrate B governs', async () => {
      const { service, harnessGatewayService } = buildDeps({ row: governedRow() });

      await service.signalConsultationEnding(CONSULTATION, {});

      expect(harnessGatewayService.signalConsultationEnding).not.toHaveBeenCalled();
    });

    it('suppresses the loop-cancel signal too when Substrate B governs', async () => {
      const { service, harnessGatewayService } = buildDeps({ row: governedRow() });

      await service.signalLoopCancel(CONSULTATION, {});

      expect(harnessGatewayService.signalLoopCancel).not.toHaveBeenCalled();
    });
  });

  describe('fail SAFE — an indeterminate answer runs Substrate A, never nothing', () => {
    it('SIGNALS when the marker read THROWS', async () => {
      const { service, harnessGatewayService } = buildDeps({ findByIdError: new Error('database down') });

      await expect(service.handleContextAdded(payload())).resolves.toBeUndefined();
      expect(harnessGatewayService.signalContextAdded).toHaveBeenCalledTimes(1);
    });

    it('SIGNALS when the consultation row cannot be found', async () => {
      const { service, harnessGatewayService } = buildDeps({ row: null });

      await service.handleContextAdded(payload());

      expect(harnessGatewayService.signalContextAdded).toHaveBeenCalledTimes(1);
    });

    it('SIGNALS when no consultation repository is wired at all', async () => {
      const { service, harnessGatewayService } = buildDeps({ wired: false });

      await service.handleContextAdded(payload());

      expect(harnessGatewayService.signalContextAdded).toHaveBeenCalledTimes(1);
    });
  });

  describe('durability and cost', () => {
    it('reads the DURABLE marker from the consultation row, by consultation id', async () => {
      const { service, findById } = buildDeps({ row: governedRow() });

      await service.handleContextAdded(payload());

      expect(findById).toHaveBeenCalledWith(CONSULTATION);
    });

    it('re-recognises a governed consultation on a LATER signal in a FRESH process', async () => {
      // A restart loses every in-memory hint; only the persisted marker survives.
      const first = buildDeps({ row: governedRow() });
      await first.service.handleContextAdded(payload({ contextItemId: 'ctx-1' }));

      const afterRestart = buildDeps({ row: governedRow() });
      await afterRestart.service.handleContextAdded(payload({ contextItemId: 'ctx-2', timestamp: '2026-08-22T11:00:00.000Z' }));

      expect(afterRestart.harnessGatewayService.signalContextAdded).not.toHaveBeenCalled();
    });

    it('does not re-read the row for every context item of the same consultation', async () => {
      // TRANSCRIPT items are on the ContextAdded bus, so this runs per utterance.
      // The decision is written once at open and never changes, so it is cacheable.
      const { service, findById } = buildDeps({ row: ungovernedRow() });

      for (let i = 0; i < 5; i += 1) {
        await service.handleContextAdded(payload({ contextItemId: `ctx-${i}`, timestamp: `2026-08-22T10:0${i}:00.000Z` }));
      }

      expect(findById).toHaveBeenCalledTimes(1);
    });

    it('never caches an INDETERMINATE answer — a failed read is retried on the next signal', async () => {
      const { service, findById } = buildDeps({ findByIdError: new Error('database down') });

      await service.handleContextAdded(payload({ contextItemId: 'ctx-1' }));
      await service.handleContextAdded(payload({ contextItemId: 'ctx-2', timestamp: '2026-08-22T10:05:00.000Z' }));

      expect(findById).toHaveBeenCalledTimes(2);
    });

    it('decides per consultation, never leaking one consultation decision onto another', async () => {
      const rows: Record<string, unknown> = { 'c-governed': governedRow('c-governed'), 'c-plain': ungovernedRow('c-plain') };
      const findById = vi.fn(async (id: string) => rows[id]);
      const harnessGatewayService = {
        signalContextAdded: vi.fn().mockResolvedValue({ signaled: true }),
        signalConsultationEnding: vi.fn(),
        signalLoopCancel: vi.fn(),
      };
      const tenantSettings = new TenantSettingsService({ getValueFromCache: () => null, getTenantValueFromCache: () => null } as never);
      const service = new LoopContextSignalService(
        harnessGatewayService as never,
        tenantSettings,
        { isFeatureEnabled: vi.fn(async () => true) } as never,
        { get: () => TENANT } as never,
        { findById } as never,
      );

      await service.handleContextAdded(payload({ consultationId: 'c-governed', contextItemId: 'a' }));
      await service.handleContextAdded(payload({ consultationId: 'c-plain', contextItemId: 'b' }));

      expect(harnessGatewayService.signalContextAdded).toHaveBeenCalledTimes(1);
      expect(harnessGatewayService.signalContextAdded).toHaveBeenCalledWith('c-plain', expect.anything());
    });
  });

  describe('the marker constant', () => {
    it('is a stable, greppable value', () => {
      expect(TENANT_WORKFLOW_GOVERNS_MARKER).toBe('tenant-workflow');
    });
  });
});
