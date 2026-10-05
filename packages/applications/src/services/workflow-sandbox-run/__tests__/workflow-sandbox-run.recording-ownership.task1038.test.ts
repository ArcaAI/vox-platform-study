/**
 * TASK-1038 E2 (fix 12) — a sandbox run may record only on an STT session that is the CALLER's.
 *
 * `recording: { sttSessionId }` used to accept any streaming session of the tenant, and then
 * RE-BOUND that session's job row to a new sandbox consultation — so a tenant admin could pull a
 * colleague's live clinical audio into a test run, or a finished session's transcript. Now, before
 * anything is written:
 *   - the session's job row must have been created by the requesting principal (`createdBy`);
 *     anyone else's session is the same 404 as an unknown one (404-over-403);
 *   - the session must be LIVE (`PROCESSING` / `QUEUED`, not completed) — 409
 *     `SANDBOX_RECORDING_NOT_LIVE` otherwise;
 *   - a session already bound to a sandbox consultation must be bound to one of THIS definition —
 *     409 `SANDBOX_RECORDING_BOUND_ELSEWHERE` otherwise;
 *   - nothing is mutated (no consultation, no job re-bind) on any refusal.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ConflictException, NotFoundException } from '@nestjs/common';
import { WorkflowSandboxRunService } from '../workflow-sandbox-run.service';

const cls = { get: vi.fn(), set: vi.fn() };
const events = { emit: vi.fn() };
const definitions = { getCompiledConfigForSandboxRun: vi.fn() };
const fixtures = { findById: vi.fn() };
const harness = { startWorkflowRun: vi.fn() };
const runs = { recordRunStarted: vi.fn() };
const s3 = { putFile: vi.fn() };
const media = { findByIdOrNull: vi.fn() };
const jobs = { findAll: vi.fn(), update: vi.fn() };
const consultations = { findByIdOrNull: vi.fn(), create: vi.fn() };

function build() {
  return new WorkflowSandboxRunService(
    definitions as never,
    fixtures as never,
    harness as never,
    runs as never,
    events as never,
    cls as never,
    s3 as never,
    media as never,
    jobs as never,
    consultations as never,
  );
}

const startCall = () => harness.startWorkflowRun.mock.calls[0]?.[0] as Record<string, any>;

beforeEach(() => {
  vi.clearAllMocks();
  cls.get.mockImplementation((key: string) =>
    key === 'tenantId' ? 'tenant-1' : key === 'user' ? { id: 'admin-1', roles: ['TENANT_ADMIN'] } : undefined,
  );
  definitions.getCompiledConfigForSandboxRun.mockResolvedValue({
    compiledConfig: { formatVersion: 1, stages: [], gates: [] },
    workflowVersionId: 'def-1',
    workflowSlug: 'scribe',
    workflowVersionNumber: 2,
    definitionName: 'Scribe',
  });
  harness.startWorkflowRun.mockResolvedValue({ status: 'started' });
  s3.putFile.mockResolvedValue(undefined);
  media.findByIdOrNull.mockImplementation(async (id: string) =>
    id === 'm-pdf'
      ? { id, tenantId: 'tenant-1', mimeType: 'application/pdf', name: 'labs.pdf', size: 2048, uri: 's3://secret' }
      : id === 'm-jpg'
        ? { id, tenantId: 'tenant-1', mimeType: 'IMAGE/JPG', name: 'x.jpg', size: 10, uri: 's3://secret' }
        : id === 'm-zip'
          ? { id, tenantId: 'tenant-1', mimeType: 'application/zip', name: 'x.zip', size: 10, uri: 's3://secret' }
          : id === 'm-foreign'
            ? { id, tenantId: 'tenant-2', mimeType: 'application/pdf', name: 'x.pdf', size: 10, uri: 's3://secret' }
            : null,
  );
  jobs.findAll.mockResolvedValue([
    {
      id: 'job-1',
      tenantId: 'tenant-1',
      streamSessionId: 'stt-1',
      jobType: 'STREAMING',
      status: 'PROCESSING',
      createdBy: 'admin-1',
      consultationId: null,
    },
  ]);
  jobs.update.mockImplementation(async (_id: string, e: unknown) => e);
  consultations.create.mockImplementation(async (e: { id: string }) => e);
});

const job = (over: Record<string, unknown> = {}) => ({
  id: 'job-1',
  tenantId: 'tenant-1',
  streamSessionId: 'stt-1',
  jobType: 'STREAMING',
  status: 'PROCESSING',
  completedAt: null,
  createdBy: 'admin-1',
  consultationId: null,
  ...over,
});

function expectNothingWritten() {
  expect(consultations.create).not.toHaveBeenCalled();
  expect(jobs.update).not.toHaveBeenCalled();
  expect(runs.recordRunStarted).not.toHaveBeenCalled();
  expect(harness.startWorkflowRun).not.toHaveBeenCalled();
}

describe('sandbox recording — ownership, liveness, binding', () => {
  it('the caller’s own live session is accepted (and bound)', async () => {
    jobs.findAll.mockResolvedValue([job()]);
    await build().startRun('def-1', { recording: { sttSessionId: 'stt-1' } });
    expect(jobs.update).toHaveBeenCalledTimes(1);
  });

  it('a session another user created is 404, and nothing is mutated', async () => {
    jobs.findAll.mockResolvedValue([job({ createdBy: 'colleague-7' })]);
    await expect(build().startRun('def-1', { recording: { sttSessionId: 'stt-1' } })).rejects.toBeInstanceOf(NotFoundException);
    expectNothingWritten();
  });

  it('a session with no recorded creator is 404', async () => {
    jobs.findAll.mockResolvedValue([job({ createdBy: null })]);
    await expect(build().startRun('def-1', { recording: { sttSessionId: 'stt-1' } })).rejects.toBeInstanceOf(NotFoundException);
    expectNothingWritten();
  });

  it('a finished session is 409 SANDBOX_RECORDING_NOT_LIVE', async () => {
    jobs.findAll.mockResolvedValue([job({ status: 'COMPLETED', completedAt: new Date() })]);
    const error = await build()
      .startRun('def-1', { recording: { sttSessionId: 'stt-1' } })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ConflictException);
    expect(((error as ConflictException).getResponse() as { code: string }).code).toBe('SANDBOX_RECORDING_NOT_LIVE');
    expectNothingWritten();
  });

  it('a session bound to ANOTHER definition’s sandbox consultation is 409 SANDBOX_RECORDING_BOUND_ELSEWHERE', async () => {
    jobs.findAll.mockResolvedValue([job({ consultationId: 'c-sbx-other' })]);
    consultations.findByIdOrNull.mockResolvedValue({
      id: 'c-sbx-other',
      tenantId: 'tenant-1',
      metadata: { sandbox: { workflowDefinitionId: 'def-OTHER' } },
    });
    const error = await build()
      .startRun('def-1', { recording: { sttSessionId: 'stt-1' } })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ConflictException);
    expect(((error as ConflictException).getResponse() as { code: string }).code).toBe('SANDBOX_RECORDING_BOUND_ELSEWHERE');
    expectNothingWritten();
  });

  it('a session already bound to THIS definition’s sandbox consultation is reused', async () => {
    jobs.findAll.mockResolvedValue([job({ consultationId: 'c-sbx' })]);
    consultations.findByIdOrNull.mockResolvedValue({ id: 'c-sbx', tenantId: 'tenant-1', metadata: { sandbox: { workflowDefinitionId: 'def-1' } } });
    await build().startRun('def-1', { recording: { sttSessionId: 'stt-1' } });
    expect(startCall().subject.consultationId).toBe('c-sbx');
    expect(jobs.update).not.toHaveBeenCalled();
  });
});
