/**
 * TASK-1038 (F1) — sandbox attachments and recordings land where the workflow's INPUT SHAPE
 * declares them, never as undeclared top-level keys.
 *
 * The trigger validates the run payload against its bound context schema with
 * `additionalProperties: false`, so the old `payload.attachments` / `payload.recording` keys were
 * refused by `input.validated` on every bound workflow (`default_io` declares `documents` and
 * `images`, not `attachments`). Now, when the trigger is bound:
 *  - each attachment reference goes to the first declared media kind whose schema accepts it
 *    (its MIME type among the kind's declared types; a `ONE` kind takes one) — else 400
 *    `SANDBOX_INPUT_UNDECLARED`, before anything is written;
 *  - the recording goes to the declared streamed-audio kind as `{ sttSessionId }` — else 400;
 *  - the payload that results validates against the trigger's schema.
 * An UNBOUND trigger validates nothing, so the legacy keys stay (the OD-15 tests cover that).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { BadRequestException } from '@nestjs/common';
import { jsonSchemaValueProblems } from '@arcaai/json-schema-subset';
import { payloadSchemaFromDefinition } from '../../consultation-context-schema/context-schema-definition';
import { WorkflowSandboxRunService } from '../workflow-sandbox-run.service';

const base = { phiClass: 'PHI', lifecycle: 'ANY', producedBy: ['CLIENT'] };
const DEFAULT_IO = {
  schemaVersion: '1.0',
  kinds: [
    { ...base, key: 'message', label: 'Message', primitive: 'TEXT', cardinality: 'ONE' },
    { ...base, key: 'documents', label: 'Docs', primitive: 'DOCUMENT', cardinality: 'MANY', constraints: { mimeTypes: ['text/plain', 'application/pdf'] } },
    { ...base, key: 'images', label: 'Images', primitive: 'IMAGE', cardinality: 'MANY', constraints: { mimeTypes: ['image/jpeg', 'image/png'] } },
  ],
};
const WITH_AUDIO = {
  schemaVersion: '1.0',
  kinds: [
    { ...base, key: 'audio_stream', label: 'Audio', primitive: 'STREAM_AUDIO', cardinality: 'ONE' },
    { ...base, key: 'scan', label: 'Scan', primitive: 'IMAGE', cardinality: 'ONE' },
  ],
};

function compiledWith(resolved: Record<string, unknown> | null) {
  const trigger = { id: 'n_trigger', type: 'core.trigger', config: resolved ? { contextSchema: { contextSchemaId: 's', resolved, followsLatest: true } } : {} };
  return { formatVersion: 1, stages: [{ nodes: [trigger] }], gates: [] };
}

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

const build = () =>
  new WorkflowSandboxRunService(
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
const payload = () => (harness.startWorkflowRun.mock.calls[0]?.[0] as { payload: Record<string, unknown> }).payload;
const useDefinition = (definition: unknown) =>
  definitions.getCompiledConfigForSandboxRun.mockResolvedValue({
    compiledConfig: compiledWith(definition ? payloadSchemaFromDefinition(definition) : null),
    workflowVersionId: 'def-1',
    workflowSlug: 'scribe',
    workflowVersionNumber: 2,
    definitionName: 'Scribe',
  });

const MEDIA: Record<string, { mimeType: string; name: string; size: number }> = {
  'm-pdf': { mimeType: 'application/pdf', name: 'labs.pdf', size: 2048 },
  'm-txt': { mimeType: 'text/plain', name: 'note.txt', size: 12 },
  'm-png': { mimeType: 'image/png', name: 'x.png', size: 10 },
  'm-jpg': { mimeType: 'IMAGE/JPG', name: 'y.jpg', size: 11 },
  'm-md': { mimeType: 'text/markdown', name: 'z.md', size: 5 },
};

beforeEach(() => {
  vi.clearAllMocks();
  cls.get.mockImplementation((key: string) => (key === 'tenantId' ? 'tenant-1' : key === 'user' ? { id: 'admin-1' } : undefined));
  harness.startWorkflowRun.mockResolvedValue({ status: 'started' });
  s3.putFile.mockResolvedValue(undefined);
  media.findByIdOrNull.mockImplementation(async (id: string) => (MEDIA[id] ? { id, tenantId: 'tenant-1', uri: 's3://secret', ...MEDIA[id] } : null));
  jobs.findAll.mockResolvedValue([{ id: 'job-1', tenantId: 'tenant-1', streamSessionId: 'stt-1', jobType: 'STREAMING', status: 'PROCESSING', createdBy: 'admin-1', consultationId: null }]);
  jobs.update.mockImplementation(async (_id: string, e: unknown) => e);
  consultations.create.mockImplementation(async (e: { id: string }) => e);
});

describe('bound to default_io', () => {
  beforeEach(() => useDefinition(DEFAULT_IO));

  it('routes each attachment to the declared kind that accepts its MIME type — and the payload validates', async () => {
    await build().startRun('def-1', { input: { message: 'see attached' }, attachments: [{ mediaId: 'm-pdf' }, { mediaId: 'm-png' }, { mediaId: 'm-txt' }, { mediaId: 'm-jpg' }] });

    expect(payload()).toEqual({
      message: 'see attached',
      documents: [
        { mediaId: 'm-pdf', mime: 'application/pdf', name: 'labs.pdf', size: 2048 },
        { mediaId: 'm-txt', mime: 'text/plain', name: 'note.txt', size: 12 },
      ],
      images: [
        { mediaId: 'm-png', mime: 'image/png', name: 'x.png', size: 10 },
        { mediaId: 'm-jpg', mime: 'image/jpeg', name: 'y.jpg', size: 11 },
      ],
    });
    expect(jsonSchemaValueProblems(payloadSchemaFromDefinition(DEFAULT_IO), payload())).toEqual([]);
  });

  it('appends to references the input already carries on a MANY kind', async () => {
    const prior = { mediaId: 'm-0', mime: 'application/pdf' };
    await build().startRun('def-1', { input: { documents: [prior] }, attachments: [{ mediaId: 'm-pdf' }] });
    expect(payload().documents).toEqual([prior, expect.objectContaining({ mediaId: 'm-pdf' })]);
  });

  it('400 SANDBOX_INPUT_UNDECLARED for an allowed attachment type no declared kind accepts — nothing written', async () => {
    const error = await build()
      .startRun('def-1', { attachments: [{ mediaId: 'm-md' }] })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(BadRequestException);
    expect(((error as BadRequestException).getResponse() as { code: string }).code).toBe('SANDBOX_INPUT_UNDECLARED');
    expect(runs.recordRunStarted).not.toHaveBeenCalled();
    expect(harness.startWorkflowRun).not.toHaveBeenCalled();
  });

  it('400 SANDBOX_INPUT_UNDECLARED for a recording when the input shape declares no live audio', async () => {
    const error = await build()
      .startRun('def-1', { recording: { sttSessionId: 'stt-1' } })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(BadRequestException);
    expect(((error as BadRequestException).getResponse() as { code: string }).code).toBe('SANDBOX_INPUT_UNDECLARED');
    expect(consultations.create).not.toHaveBeenCalled();
    expect(runs.recordRunStarted).not.toHaveBeenCalled();
  });

  it('never emits the legacy top-level keys on a bound trigger', async () => {
    await build().startRun('def-1', { attachments: [{ mediaId: 'm-pdf' }] });
    expect(payload()).not.toHaveProperty('attachments');
    expect(payload()).not.toHaveProperty('recording');
  });
});

describe('bound to a schema with live audio and a ONE image kind', () => {
  beforeEach(() => useDefinition(WITH_AUDIO));

  it('puts the recording under the streamed-audio kind and the image under its ONE kind', async () => {
    await build().startRun('def-1', { recording: { sttSessionId: 'stt-1' }, attachments: [{ mediaId: 'm-png' }] });
    expect(payload()).toEqual({ audio_stream: { sttSessionId: 'stt-1' }, scan: { mediaId: 'm-png', mime: 'image/png', name: 'x.png', size: 10 } });
    expect(jsonSchemaValueProblems(payloadSchemaFromDefinition(WITH_AUDIO), payload())).toEqual([]);
  });

  it('a ONE kind takes one reference: a second has nowhere to go (400)', async () => {
    const error = await build()
      .startRun('def-1', { attachments: [{ mediaId: 'm-png' }, { mediaId: 'm-jpg' }] })
      .catch((e: unknown) => e);
    expect(((error as BadRequestException).getResponse() as { code: string }).code).toBe('SANDBOX_INPUT_UNDECLARED');
  });
});

describe('unbound trigger — nothing validates the payload', () => {
  it('keeps the legacy keys', async () => {
    useDefinition(null);
    await build().startRun('def-1', { attachments: [{ mediaId: 'm-pdf' }], recording: { sttSessionId: 'stt-1' } });
    expect(payload()).toMatchObject({ attachments: [expect.objectContaining({ mediaId: 'm-pdf' })], recording: { sttSessionId: 'stt-1' } });
  });
});
