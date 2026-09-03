/**
 * consultation-open dispatch of a tenant-authored workflow.
 *
 * These tests pin the two behaviours that make the fix safe:
 *   1. no assignment -> NOTHING is dispatched (Substrate A keeps the consultation, unchanged);
 *   2. an assignment -> a run is started, stamped `trigger: 'consultation open'`, and carries a
 *      real identity payload (without which every consultation node fails its binding).
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ConsultationWorkflowDispatchService } from '../consultation-workflow-dispatch.service';

const TENANT = '50000000-0000-0000-0000-000000000001';
const CONSULTATION = 'c-1';
const DEPARTMENT = 'd-1';
const USER = 'u-1';

function makeDeps(overrides: Record<string, unknown> = {}) {
  return {
    assignments: { resolve: vi.fn().mockResolvedValue({ workflowDefinitionSlug: null, source: 'platform-default' }) },
    definitionRepository: { findPublishedBySlug: vi.fn().mockResolvedValue(null) },
    // the dispatcher now records which engine governs.
    consultationRepository: { findById: vi.fn().mockResolvedValue({ id: CONSULTATION, metadata: null }), update: vi.fn().mockResolvedValue({}) },
    workflowRunService: { recordRunStarted: vi.fn().mockResolvedValue({}) },
    harnessGateway: { startWorkflowRun: vi.fn().mockResolvedValue({ status: 'RUNNING' }) },
    s3Service: { putFile: vi.fn().mockResolvedValue(undefined) },
    ...overrides,
  };
}

function makeService(deps: ReturnType<typeof makeDeps>) {
  const svc = new ConsultationWorkflowDispatchService(
    deps.assignments as never,
    deps.definitionRepository as never,
    deps.consultationRepository as never,
    deps.workflowRunService as never,
    deps.harnessGateway as never,
    deps.s3Service as never,
  );
  // BaseService pulls tenant/user from CLS; these tests drive the explicit input instead.
  return svc;
}

const publishedDefinition = {
  id: 'wd-1',
  slug: 'arcaai-consultation-v1',
  versionNumber: 3,
  name: 'ArcaAI Consultation',
  paletteKey: 'consultation',
  compiledConfig: { formatVersion: 1, stages: [], checksum: 'abc' },
};

describe('ConsultationWorkflowDispatchService', () => {
  let deps: ReturnType<typeof makeDeps>;
  beforeEach(() => {
    deps = makeDeps();
  });

  it('dispatches NOTHING when no assignment resolves — Substrate A keeps the consultation', async () => {
    const result = await makeService(deps).dispatchForConsultation({
      consultationId: CONSULTATION,
      tenantId: TENANT,
      departmentId: DEPARTMENT,
      userId: USER,
    });

    expect(result.dispatched).toBe(false);
    expect(result.source).toBe('platform-default');
    expect(deps.harnessGateway.startWorkflowRun).not.toHaveBeenCalled();
    expect(deps.workflowRunService.recordRunStarted).not.toHaveBeenCalled();
  });

  it('consults the cascade with the consultation palette and the department', async () => {
    await makeService(deps).dispatchForConsultation({
      consultationId: CONSULTATION,
      tenantId: TENANT,
      departmentId: DEPARTMENT,
      userId: USER,
    });

    expect(deps.assignments.resolve).toHaveBeenCalledWith(TENANT, 'consultation', DEPARTMENT);
  });

  it("starts a run stamped trigger 'consultation open' when an assignment resolves", async () => {
    deps.assignments.resolve.mockResolvedValue({ workflowDefinitionSlug: publishedDefinition.slug, source: 'department' });
    deps.definitionRepository.findPublishedBySlug.mockResolvedValue(publishedDefinition);

    const result = await makeService(deps).dispatchForConsultation({
      consultationId: CONSULTATION,
      tenantId: TENANT,
      departmentId: DEPARTMENT,
      userId: USER,
      externalPatientId: 'p-9',
    });

    expect(result.dispatched).toBe(true);
    expect(result.source).toBe('department');
    expect(result.runId).toBeTruthy();

    expect(deps.workflowRunService.recordRunStarted).toHaveBeenCalledWith(
      expect.objectContaining({ trigger: 'consultation open', tenantId: TENANT, workflowSlug: publishedDefinition.slug, isSandbox: false }),
    );
  });

  // lane A moved run identity from `payload` to `subject`. The INTENT of this test is
  // unchanged and is the reason it must keep passing: the three identity values still reach the
  // same `run_identity(...)` readers (the dispatcher re-stamps them into `run_payload`), and
  // without them `input.context_binding` — `critical=True` — fails at the first node. Only the
  // CHANNEL changed, because `payload` is now stripped of identity keys unconditionally so that
  // a caller-composed one can never carry them (finding C-8, link 1).
  it('forwards a real identity subject — without it every consultation node fails its binding', async () => {
    deps.assignments.resolve.mockResolvedValue({ workflowDefinitionSlug: publishedDefinition.slug, source: 'tenant' });
    deps.definitionRepository.findPublishedBySlug.mockResolvedValue(publishedDefinition);

    await makeService(deps).dispatchForConsultation({
      consultationId: CONSULTATION,
      tenantId: TENANT,
      departmentId: null,
      userId: USER,
      externalPatientId: 'p-9',
    });

    const call = deps.harnessGateway.startWorkflowRun.mock.calls[0][0];
    expect(call.sandbox).toBe(false);
    expect(call.subject).toMatchObject({ consultationId: CONSULTATION, userId: USER, externalPatientId: 'p-9' });
    // And it is NOT smuggled through the payload as well — one channel, so the two can never
    // disagree about which consultation a run may write to.
    expect(call.payload).toBeUndefined();
  });

  it('records the run BEFORE dispatching, so a started run is always attributable', async () => {
    deps.assignments.resolve.mockResolvedValue({ workflowDefinitionSlug: publishedDefinition.slug, source: 'tenant' });
    deps.definitionRepository.findPublishedBySlug.mockResolvedValue(publishedDefinition);
    const order: string[] = [];
    deps.workflowRunService.recordRunStarted.mockImplementation(async () => void order.push('record'));
    deps.harnessGateway.startWorkflowRun.mockImplementation(async () => {
      order.push('dispatch');
      return { status: 'RUNNING' };
    });

    await makeService(deps).dispatchForConsultation({ consultationId: CONSULTATION, tenantId: TENANT, userId: USER });

    expect(order).toEqual(['record', 'dispatch']);
  });

  it('never throws when dispatch fails — a clinician must still be able to open the consultation', async () => {
    deps.assignments.resolve.mockResolvedValue({ workflowDefinitionSlug: publishedDefinition.slug, source: 'tenant' });
    deps.definitionRepository.findPublishedBySlug.mockResolvedValue(publishedDefinition);
    deps.harnessGateway.startWorkflowRun.mockRejectedValue(new Error('harness unreachable'));

    const result = await makeService(deps).dispatchForConsultation({ consultationId: CONSULTATION, tenantId: TENANT, userId: USER });

    expect(result.dispatched).toBe(false);
    expect(result.skippedReason).toContain('harness unreachable');
  });

  it('does not dispatch a definition whose palette is not the consultation palette', async () => {
    deps.assignments.resolve.mockResolvedValue({ workflowDefinitionSlug: 'some-stt-graph', source: 'tenant' });
    deps.definitionRepository.findPublishedBySlug.mockResolvedValue({ ...publishedDefinition, paletteKey: 'stt' });

    const result = await makeService(deps).dispatchForConsultation({ consultationId: CONSULTATION, tenantId: TENANT, userId: USER });

    expect(result.dispatched).toBe(false);
    expect(deps.harnessGateway.startWorkflowRun).not.toHaveBeenCalled();
  });
});
