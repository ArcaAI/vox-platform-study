/**
 * TASK-790 W1 — the exposure plane's palette boundary (TASK-789 finding C-8).
 *
 * `POST /workflows/:slug/invoke` forwards caller-controlled `dto.input` verbatim into
 * `InterpreterInput.payload` with `sandbox: false`. The interpreter's `external_write`
 * suppression (`interpreter/workflow.py:228`) reads `if inp.sandbox and spec.external_write:`,
 * so it does NOT fire on this plane — a consultation-palette node reached this way calls the
 * same `persist_draft` activity `HarnessDocWorkflow` uses, writing real `ContextItem` rows.
 *
 * The route is API-key-reachable by design (no `@ForbidApiKey`), so the boundary has to be
 * server-side and structural.
 *
 * Note the second describe block below: the boundary CANNOT be keyed on the definition's
 * declared `paletteKey` alone. Nothing in `validate()`/`compile()` requires a graph's nodes to
 * belong to its declared palette — a `summarization`-declared graph carrying
 * `consultation.persistDraft` compiles shape-clean (verified against the real engine). The
 * check must walk the COMPILED NODE TYPES.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { NotFoundException } from '@nestjs/common';
import { WorkflowExposureService } from '../workflow-exposure.service';

const mockClsService = { get: vi.fn(), set: vi.fn() };
const mockEventEmitter = { emit: vi.fn() };
const mockWorkflowDefinitionRepository = { findPublishedBySlug: vi.fn(), findActivePublishedByTenant: vi.fn() };
const mockHarnessGateway = { startWorkflowRun: vi.fn(), getWorkflowRun: vi.fn(), cancelWorkflowRun: vi.fn() };
const mockWorkflowRunService = { getRun: vi.fn(), recordRunStarted: vi.fn(), recordRunFinished: vi.fn() };
const mockConfigService = { getConfigValue: vi.fn((key: string) => (key === 'WORKFLOW_EXPOSURE_ENABLED' ? true : undefined)) };
const mockS3Service = { putFile: vi.fn().mockResolvedValue(undefined) };
const mockRedisCache = { get: vi.fn().mockResolvedValue(null), setex: vi.fn().mockResolvedValue(undefined) };
const mockEntitlements = { isEnforcementEnabled: vi.fn(() => false), assertMeterQuota: vi.fn() };

const compiledWith = (...nodeTypes: string[]) => ({
  formatVersion: 1,
  stages: [{ stageIndex: 0, nodes: nodeTypes.map((type, i) => ({ nodeId: `n${i}`, type, activity: `interpreter.${type}`, config: {} })) }],
  gates: [],
});

const SUMMARIZATION_CONFIG = compiledWith('core.start', 'input.context_binding', 'generate.text', 'core.end');
/** The C-8 chain: `consultation.persistDraft` -> `persist_draft` activity -> real ContextItem rows. */
const CONSULTATION_CONFIG = compiledWith('core.start', 'consultation.consentGate', 'consultation.persistDraft', 'core.end');
/** The smuggling variant — declares an approved palette, carries a consultation write node. */
const SMUGGLED_CONFIG = compiledWith('core.start', 'generate.text', 'consultation.persistDraft', 'core.end');

const definition = (overrides: Record<string, unknown> = {}) => ({
  id: overrides.id ?? 'def-1',
  tenantId: 'tenant-1',
  slug: overrides.slug ?? 'discharge_summary',
  name: overrides.name ?? 'Discharge Summary',
  description: null,
  paletteKey: overrides.paletteKey ?? 'summarization',
  versionNumber: 1,
  compiledConfig: overrides.compiledConfig ?? SUMMARIZATION_CONFIG,
});

function build() {
  mockClsService.get.mockImplementation((key: string) => (key === 'tenantId' ? 'tenant-1' : undefined));
  return new WorkflowExposureService(
    mockWorkflowDefinitionRepository as any,
    mockHarnessGateway as any,
    mockWorkflowRunService as any,
    mockConfigService as any,
    mockEventEmitter as any,
    mockClsService as any,
    mockS3Service as any,
    mockRedisCache as any,
    mockEntitlements as any,
  );
}

describe('TASK-790 W1 — exposure-plane palette boundary (C-8)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockConfigService.getConfigValue.mockImplementation((key: string) => (key === 'WORKFLOW_EXPOSURE_ENABLED' ? true : undefined));
    mockRedisCache.get.mockResolvedValue(null);
    mockEntitlements.isEnforcementEnabled.mockReturnValue(false);
    mockWorkflowRunService.recordRunStarted.mockResolvedValue(undefined);
    mockHarnessGateway.startWorkflowRun.mockResolvedValue({ runId: 'run-1', workflowId: 'w', temporalRunId: 't', status: 'started' });
  });

  describe('a consultation-palette definition is not an exposure product', () => {
    it('refuses invoke with 404 and never reaches the harness dispatcher', async () => {
      mockWorkflowDefinitionRepository.findPublishedBySlug.mockResolvedValue(
        definition({ paletteKey: 'consultation', compiledConfig: CONSULTATION_CONFIG }),
      );
      const service = build();

      await expect(service.invoke('discharge_summary', { input: { consultationId: 'c-1' } }, {})).rejects.toBeInstanceOf(NotFoundException);

      // The whole point: no run row, no dispatcher call, so no `persist_draft`.
      expect(mockHarnessGateway.startWorkflowRun).not.toHaveBeenCalled();
      expect(mockWorkflowRunService.recordRunStarted).not.toHaveBeenCalled();
    });

    it('omits it from list() so the catalogue and the invoke gate agree', async () => {
      mockWorkflowDefinitionRepository.findActivePublishedByTenant.mockResolvedValue([
        definition({ slug: 'summary_ok' }),
        definition({ slug: 'consult_bad', paletteKey: 'consultation', compiledConfig: CONSULTATION_CONFIG }),
      ]);
      const service = build();

      const result = await service.list();

      expect(result.data.map((row) => row.slug)).toEqual(['summary_ok']);
    });
  });

  describe('the boundary is over COMPILED NODE TYPES, not the declared paletteKey', () => {
    it('refuses a summarization-declared graph carrying a consultation write node', async () => {
      mockWorkflowDefinitionRepository.findPublishedBySlug.mockResolvedValue(
        definition({ paletteKey: 'summarization', compiledConfig: SMUGGLED_CONFIG }),
      );
      const service = build();

      await expect(service.invoke('discharge_summary', { input: { consultationId: 'c-1' } }, {})).rejects.toBeInstanceOf(NotFoundException);
      expect(mockHarnessGateway.startWorkflowRun).not.toHaveBeenCalled();
    });
  });

  describe('an approved palette still invokes', () => {
    it('starts the run for a genuine summarization definition', async () => {
      mockWorkflowDefinitionRepository.findPublishedBySlug.mockResolvedValue(definition());
      const service = build();

      const response = await service.invoke('discharge_summary', { input: { text: 'hi' } }, {});

      expect(response.status).toBe('started');
      expect(mockHarnessGateway.startWorkflowRun).toHaveBeenCalledTimes(1);
    });
  });
});

/**
 * TASK-790 (M-2) — an invoker can retrieve what the run actually produced.
 *
 * `getRunStatus` read Temporal state only, so `output.deliver`'s real external write was
 * unrecoverable. The read model now carries the delivered output; the status route surfaces it.
 */
describe('TASK-790 M-2 — getRunStatus reads back the delivered output', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockConfigService.getConfigValue.mockImplementation((key: string) => (key === 'WORKFLOW_EXPOSURE_ENABLED' ? true : undefined));
    mockHarnessGateway.getWorkflowRun.mockResolvedValue({
      runId: 'run-1',
      status: 'COMPLETED',
      stages: [],
      startedAt: '2026-08-22T00:00:00Z',
      endedAt: '2026-08-22T00:01:00Z',
    });
    mockWorkflowRunService.recordRunFinished.mockResolvedValue(undefined);
  });

  it('surfaces the run row resultRef on the status response', async () => {
    const delivered = { resultRef: { bucket: 'harness-claim-check', key: 'sha256/abc', sizeBytes: 4096 } };
    mockWorkflowRunService.getRun.mockResolvedValue({
      runId: 'run-1',
      tenantId: 'tenant-1',
      workflowSlug: 'discharge_summary',
      workflowVersionId: 'def-1',
      workflowVersionNumber: 1,
      sessionId: 'workflow-interpreter-run-1',
      status: 'COMPLETED',
      resultRef: delivered,
    });

    const result = await build().getRunStatus('discharge_summary', 'run-1');

    expect(result.resultRef).toEqual(delivered);
  });

  it('is null for a run that delivered nothing', async () => {
    mockWorkflowRunService.getRun.mockResolvedValue({
      runId: 'run-1',
      tenantId: 'tenant-1',
      workflowSlug: 'discharge_summary',
      workflowVersionId: 'def-1',
      workflowVersionNumber: 1,
      sessionId: 'workflow-interpreter-run-1',
      status: 'COMPLETED',
      resultRef: null,
    });

    const result = await build().getRunStatus('discharge_summary', 'run-1');

    expect(result.resultRef).toBeNull();
  });
});
