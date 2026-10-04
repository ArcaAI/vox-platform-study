/**
 * TASK-1036 OD-15 lane B3b — sandbox runs accept tenant media ATTACHMENTS and a live RECORDING.
 *
 *  - `attachments: [{ mediaId }]` — each a Media row of THIS tenant (foreign / unknown → 404) whose
 *    MIME type is on the attachment allow-list (400 SANDBOX_ATTACHMENT_MIME_UNSUPPORTED). Forwarded
 *    by reference (`{ mediaId, mime, name, size }`) — never bytes, never the storage URI.
 *  - `recording: { sttSessionId }` — an STT streaming session of THIS tenant (404 otherwise). The run
 *    creates a SANDBOX consultation and binds the session to it; a session already bound to a real
 *    (non-sandbox) consultation is 409 SANDBOX_RECORDING_BOUND_ELSEWHERE. The run carries the
 *    consultation as its server-resolved subject and records it on its own row (`metaData`), so the
 *    declared-read route accepts the run.
 *  - JSON `input` keeps working exactly as before.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { validate } from 'class-validator';
import { plainToInstance } from 'class-transformer';
import { WorkflowSandboxRunService } from '../workflow-sandbox-run.service';
import { StartSandboxRunRequest } from '../dto';

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
  jobs.findAll.mockResolvedValue([{ id: 'job-1', tenantId: 'tenant-1', streamSessionId: 'stt-1', jobType: 'STREAMING', consultationId: null }]);
  jobs.update.mockImplementation(async (_id: string, e: unknown) => e);
  consultations.create.mockImplementation(async (e: { id: string }) => e);
});

describe('attachments', () => {
  it('forwards tenant media by reference, MIME normalised', async () => {
    await build().startRun('def-1', { attachments: [{ mediaId: 'm-pdf' }, { mediaId: 'm-jpg' }] });

    expect(startCall().payload.attachments).toEqual([
      { mediaId: 'm-pdf', mime: 'application/pdf', name: 'labs.pdf', size: 2048 },
      { mediaId: 'm-jpg', mime: 'image/jpeg', name: 'x.jpg', size: 10 },
    ]);
    expect(JSON.stringify(startCall())).not.toContain('s3://secret');
  });

  it('404 for a foreign or unknown media id (404-over-403), before anything is written', async () => {
    await expect(build().startRun('def-1', { attachments: [{ mediaId: 'm-foreign' }] })).rejects.toBeInstanceOf(NotFoundException);
    await expect(build().startRun('def-1', { attachments: [{ mediaId: 'nope' }] })).rejects.toBeInstanceOf(NotFoundException);
    expect(runs.recordRunStarted).not.toHaveBeenCalled();
  });

  it('400 SANDBOX_ATTACHMENT_MIME_UNSUPPORTED outside the allow-list', async () => {
    const error = await build()
      .startRun('def-1', { attachments: [{ mediaId: 'm-zip' }] })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(BadRequestException);
    expect(((error as BadRequestException).getResponse() as { code: string }).code).toBe('SANDBOX_ATTACHMENT_MIME_UNSUPPORTED');
  });

  it('merges with JSON input', async () => {
    await build().startRun('def-1', { input: { message: 'hi' }, attachments: [{ mediaId: 'm-pdf' }] });
    expect(startCall().payload).toMatchObject({ message: 'hi', attachments: [expect.objectContaining({ mediaId: 'm-pdf' })] });
  });
});

describe('recording', () => {
  it('creates a sandbox consultation, binds the session to it, and runs against it', async () => {
    await build().startRun('def-1', { recording: { sttSessionId: 'stt-1' } });

    expect(jobs.findAll).toHaveBeenCalledWith({ filters: { tenantId: 'tenant-1', streamSessionId: 'stt-1', jobType: 'STREAMING' } });
    const created = consultations.create.mock.calls[0][0];
    expect(created).toMatchObject({ tenantId: 'tenant-1', doctorId: 'admin-1' });
    expect(created.metadata).toMatchObject({ sandbox: { workflowDefinitionId: 'def-1', sttSessionId: 'stt-1' } });
    expect(jobs.update.mock.calls[0][1].consultationId).toBe(created.id);

    expect(startCall().subject).toEqual({ consultationId: created.id, userId: 'admin-1' });
    expect(startCall().payload.recording).toEqual({ sttSessionId: 'stt-1' });
    expect(runs.recordRunStarted.mock.calls[0][0]).toMatchObject({ isSandbox: true, metaData: { consultationId: created.id } });
  });

  it('reuses the sandbox consultation the session is already bound to', async () => {
    jobs.findAll.mockResolvedValue([{ id: 'job-1', tenantId: 'tenant-1', streamSessionId: 'stt-1', jobType: 'STREAMING', consultationId: 'c-sbx' }]);
    consultations.findByIdOrNull.mockResolvedValue({ id: 'c-sbx', tenantId: 'tenant-1', metadata: { sandbox: { workflowDefinitionId: 'def-1' } } });

    await build().startRun('def-1', { recording: { sttSessionId: 'stt-1' } });

    expect(consultations.create).not.toHaveBeenCalled();
    expect(startCall().subject.consultationId).toBe('c-sbx');
  });

  it('409 SANDBOX_RECORDING_BOUND_ELSEWHERE for a session on a real consultation', async () => {
    jobs.findAll.mockResolvedValue([{ id: 'job-1', tenantId: 'tenant-1', streamSessionId: 'stt-1', jobType: 'STREAMING', consultationId: 'c-real' }]);
    consultations.findByIdOrNull.mockResolvedValue({ id: 'c-real', tenantId: 'tenant-1', metadata: null });

    const error = await build()
      .startRun('def-1', { recording: { sttSessionId: 'stt-1' } })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ConflictException);
    expect(((error as ConflictException).getResponse() as { code: string }).code).toBe('SANDBOX_RECORDING_BOUND_ELSEWHERE');
    expect(runs.recordRunStarted).not.toHaveBeenCalled();
  });

  it('404 for an unknown or foreign session', async () => {
    jobs.findAll.mockResolvedValue([]);
    await expect(build().startRun('def-1', { recording: { sttSessionId: 'stt-x' } })).rejects.toBeInstanceOf(NotFoundException);
    jobs.findAll.mockResolvedValue([{ id: 'job-1', tenantId: 'tenant-2', streamSessionId: 'stt-1', jobType: 'STREAMING', consultationId: null }]);
    await expect(build().startRun('def-1', { recording: { sttSessionId: 'stt-1' } })).rejects.toBeInstanceOf(NotFoundException);
    expect(consultations.create).not.toHaveBeenCalled();
  });
});

describe('StartSandboxRunRequest validation', () => {
  it('accepts the new fields and refuses malformed ones', async () => {
    const ok = plainToInstance(StartSandboxRunRequest, { attachments: [{ mediaId: 'm' }], recording: { sttSessionId: 's' } });
    expect(await validate(ok, { whitelist: true, forbidNonWhitelisted: true })).toHaveLength(0);
    const bad = plainToInstance(StartSandboxRunRequest, { attachments: [{ mediaId: '' }], recording: {} });
    expect((await validate(bad)).length).toBeGreaterThan(0);
    const extra = plainToInstance(StartSandboxRunRequest, { attachments: [{ mediaId: 'm', bytes: 'x' }] });
    expect((await validate(extra, { whitelist: true, forbidNonWhitelisted: true })).length).toBeGreaterThan(0);
  });
});
