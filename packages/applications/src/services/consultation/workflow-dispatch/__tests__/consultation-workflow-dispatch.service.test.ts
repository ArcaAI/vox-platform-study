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
  paletteKey: 'core',
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

  it('consults the cascade with the consultation palette, the department and the visit-type selector', async () => {
    await makeService(deps).dispatchForConsultation({
      consultationId: CONSULTATION,
      tenantId: TENANT,
      departmentId: DEPARTMENT,
      userId: USER,
    });

    // TASK-891 — no `parentConsultationId` means this is a NEW visit, so the reserved
    // `visit-type:new-visit` tag rides on the same cascade call the department already used.
    expect(deps.assignments.resolve).toHaveBeenCalledWith(TENANT, 'core', DEPARTMENT, ['visit-type:new-visit']);
  });

  // TASK-891 — plumbing for OD-2/OD-3: the reserved `visit-type:<key>` tag lets a
  // `WorkflowAssignment` row narrow itself to new-visit or revisit within a tier, without
  // reintroducing a tenant-managed visit-type catalogue (OD-3).
  describe('TASK-891 — visit-type selector tag on the consultation-palette cascade', () => {
    it('tags a follow-up consultation visit-type:revisit', async () => {
      await makeService(deps).dispatchForConsultation({
        consultationId: CONSULTATION,
        tenantId: TENANT,
        departmentId: DEPARTMENT,
        userId: USER,
        parentConsultationId: 'parent-1',
      });

      expect(deps.assignments.resolve).toHaveBeenCalledWith(TENANT, 'core', DEPARTMENT, ['visit-type:revisit']);
    });

    it('tags a consultation with no parent link visit-type:new-visit', async () => {
      await makeService(deps).dispatchForConsultation({
        consultationId: CONSULTATION,
        tenantId: TENANT,
        departmentId: DEPARTMENT,
        userId: USER,
        parentConsultationId: null,
      });

      expect(deps.assignments.resolve).toHaveBeenCalledWith(TENANT, 'core', DEPARTMENT, ['visit-type:new-visit']);
    });

    // Regression: a caller that omits `parentConsultationId` altogether (every call site
    // before this ticket) must resolve EXACTLY what it resolves today. The field is optional
    // precisely so an absent parent link degrades to "not a follow-up" — never to "the visit
    // type could not be determined" — which is the one case this ticket must never invent a
    // new failure mode for.
    it('treats an omitted parentConsultationId the same as no parent link — visit-type:new-visit, not a failure', async () => {
      await makeService(deps).dispatchForConsultation({
        consultationId: CONSULTATION,
        tenantId: TENANT,
        departmentId: DEPARTMENT,
        userId: USER,
      });

      expect(deps.assignments.resolve).toHaveBeenCalledWith(TENANT, 'core', DEPARTMENT, ['visit-type:new-visit']);
    });

    it('does NOT tag the STT-palette resolution — visit type is a consultation/document-template axis, not an ASR axis', async () => {
      await makeService(deps).dispatchForConsultation({
        consultationId: CONSULTATION,
        tenantId: TENANT,
        departmentId: DEPARTMENT,
        userId: USER,
        parentConsultationId: 'parent-1',
      });

      // The STT lane only resolves when `sttPipelineResolver` is wired (see the
      // selection.task813 suite, which wires it and asserts this exact 3-arg call). This
      // service's own fixture leaves it `@Optional()` and unset, so `resolveSttPipelineId`
      // short-circuits before calling `resolve` at all — asserted here so a future change that
      // starts tagging that lane cannot ride in unnoticed.
      expect(deps.assignments.resolve).not.toHaveBeenCalledWith(TENANT, 'stt', DEPARTMENT, expect.anything());
    });
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
