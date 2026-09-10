/**
 * TASK-946 D3 — a consultation-dispatched run gets a completion watcher.
 *
 * Measured 2026-09-10: the interpreter run for consultation `01a08a8d-651c…` closed FAILED and
 * emitted `workflow.run.completed` on its Redis Stream; nothing consumed it, because
 * `WorkflowRunCompletionService.watch` was attached ONLY by the workflows-plane controller. The
 * `WorkflowRun` row stayed `RUNNING` and the consultation stayed `DRAINING` for eight hours.
 *
 * These tests pin the attach: it happens AFTER the run actually started (never for a dispatch
 * that was skipped or failed), it carries the consultation id so the terminal handler can close
 * the consultation, and a watcher that throws never turns a started run into a reported failure.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ConsultationWorkflowDispatchService } from '../consultation-workflow-dispatch.service';

const TENANT = '50000000-0000-0000-0000-000000000001';
const CONSULTATION = 'c-1';
const DEPARTMENT = 'd-1';
const USER = 'u-1';

const publishedDefinition = {
  id: 'wd-1',
  slug: 'arcaai-consultation-v1',
  versionNumber: 3,
  name: 'ArcaAI Consultation',
  paletteKey: 'core',
  compiledConfig: { formatVersion: 1, stages: [], checksum: 'abc' },
};

function makeDeps() {
  return {
    assignments: { resolve: vi.fn().mockResolvedValue({ workflowDefinitionSlug: publishedDefinition.slug, source: 'department' }) },
    definitionRepository: { findPublishedBySlug: vi.fn().mockResolvedValue(publishedDefinition) },
    consultationRepository: { findById: vi.fn().mockResolvedValue({ id: CONSULTATION, metadata: null }), update: vi.fn().mockResolvedValue({}) },
    workflowRunService: { recordRunStarted: vi.fn().mockResolvedValue({}) },
    harnessGateway: { startWorkflowRun: vi.fn().mockResolvedValue({ status: 'RUNNING' }) },
    s3Service: { putFile: vi.fn().mockResolvedValue(undefined) },
    runCompletion: { watch: vi.fn().mockReturnValue(true) },
  };
}

function makeService(deps: ReturnType<typeof makeDeps>) {
  return new ConsultationWorkflowDispatchService(
    deps.assignments as never,
    deps.definitionRepository as never,
    deps.consultationRepository as never,
    deps.workflowRunService as never,
    deps.harnessGateway as never,
    deps.s3Service as never,
    undefined, // sttPipelineResolver
    undefined, // visitTypes
    deps.runCompletion as never,
  );
}

const input = { consultationId: CONSULTATION, tenantId: TENANT, departmentId: DEPARTMENT, userId: USER };

describe('ConsultationWorkflowDispatchService — run-completion watcher (TASK-946 D3)', () => {
  let deps: ReturnType<typeof makeDeps>;
  beforeEach(() => {
    deps = makeDeps();
  });

  it('attaches a watcher with the tenant, the run id and the consultation id', async () => {
    const result = await makeService(deps).dispatchForConsultation(input);

    expect(result.dispatched).toBe(true);
    expect(deps.runCompletion.watch).toHaveBeenCalledWith(TENANT, result.runId, CONSULTATION);
  });

  it('attaches only AFTER the run started — a skipped dispatch watches nothing', async () => {
    deps.assignments.resolve.mockResolvedValue({ workflowDefinitionSlug: null, source: 'platform-default' });

    const result = await makeService(deps).dispatchForConsultation(input);

    expect(result.dispatched).toBe(false);
    expect(deps.runCompletion.watch).not.toHaveBeenCalled();
  });

  it('does not watch a dispatch that failed to start', async () => {
    deps.harnessGateway.startWorkflowRun.mockRejectedValue(new Error('harness unreachable'));

    const result = await makeService(deps).dispatchForConsultation(input);

    expect(result.dispatched).toBe(false);
    expect(deps.runCompletion.watch).not.toHaveBeenCalled();
  });

  it('a throwing watcher never turns a STARTED run into a reported dispatch failure', async () => {
    deps.runCompletion.watch.mockImplementation(() => {
      throw new Error('redis down');
    });

    const result = await makeService(deps).dispatchForConsultation(input);

    expect(result.dispatched).toBe(true);
    expect(result.runId).toBeTruthy();
  });

  it('dispatches normally when no watcher is wired at all (@Optional port)', async () => {
    const service = new ConsultationWorkflowDispatchService(
      deps.assignments as never,
      deps.definitionRepository as never,
      deps.consultationRepository as never,
      deps.workflowRunService as never,
      deps.harnessGateway as never,
      deps.s3Service as never,
    );

    const result = await service.dispatchForConsultation(input);

    expect(result.dispatched).toBe(true);
  });
});
