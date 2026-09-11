/**
 * TASK-950 (decision 2, fast win) — `recordRunStarted` persists the caller's `_metadata`.
 *
 * The run row is the only durable, QUERYABLE record a standalone workflow run leaves behind that
 * sits beside the run itself. The `ResourceCreated` audit event already carries `actingUserId`,
 * but an audit row cannot be joined to "which runs did this clinician's integration start" without
 * a scan; `_metadata->>'actingUserId'` on `WorkflowRun` can.
 *
 * ## What these tests assert, and why they assert it THERE
 *
 * `WorkflowRunEntity` has no `metaData` accessor (see `stampRunMetaData`'s comment for the full
 * finding), so there is no getter to read back and asserting on a private field would pin the
 * mechanism rather than the outcome. The honest assertion point is `entity.toObject()`: that is
 * literally the object `WorkflowRunEntityMapper.toPersistence` maps to the Prisma model, whose
 * `metaData` field is `@map("_metadata")`. If `toObject()` carries it, the INSERT carries it.
 *
 * The three absences are all pinned deliberately, because "record nothing" has to stay
 * distinguishable from "record an empty bag": `_metadata = {}` reads as a run someone measured
 * and found nothing on, which is not what an omitted input means.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { WorkflowRunService } from '../workflow-run.service';

const TENANT = 'tenant-1';
const ACTING_USER = '70000000-0000-0000-0000-0000000009e5';

const mockClsService = { get: vi.fn(), set: vi.fn() };
const mockEventEmitter = { emit: vi.fn() };
const mockRepository = { findByRunKey: vi.fn(), create: vi.fn(), update: vi.fn(), findById: vi.fn() };

function build(): WorkflowRunService {
  mockClsService.get.mockImplementation((key: string) => (key === 'tenantId' ? TENANT : undefined));
  return new WorkflowRunService(mockRepository as never, mockEventEmitter as never, mockClsService as never);
}

const startInput = (metaData?: Record<string, unknown>) => ({
  tenantId: TENANT,
  workflowVersionId: 'def-1',
  workflowSlug: 'triage_flow',
  workflowVersionNumber: 1,
  definitionName: 'Triage Flow',
  sessionId: 'workflow-interpreter-run-1',
  runId: 'run-1',
  trigger: 'api invoke',
  ...(metaData === undefined ? {} : { metaData }),
});

/** The object the mapper maps to the Prisma model — i.e. what the INSERT will actually carry. */
const persistedShape = () => (mockRepository.create.mock.calls.at(-1)?.[0] as { toObject(): Record<string, unknown> }).toObject();

beforeEach(() => {
  vi.clearAllMocks();
  mockRepository.findByRunKey.mockResolvedValue(null);
  // The repository echoes the entity it was handed, as the real one effectively does on create.
  mockRepository.create.mockImplementation(async (entity: unknown) => entity);
});

describe('TASK-950 — WorkflowRun._metadata on recordRunStarted', () => {
  it('persists the caller’s metaData onto the row', async () => {
    await build().recordRunStarted(startInput({ actingUserId: ACTING_USER }));

    expect(mockRepository.create).toHaveBeenCalledTimes(1);
    expect(persistedShape()).toMatchObject({ metaData: { actingUserId: ACTING_USER } });
  });

  it('stores the bag VERBATIM — this input is a pass-through, not a schema', async () => {
    await build().recordRunStarted(startInput({ actingUserId: ACTING_USER, somethingElse: 7 }));

    expect(persistedShape().metaData).toEqual({ actingUserId: ACTING_USER, somethingElse: 7 });
  });

  it('writes NOTHING when the caller omits metaData — the row keeps an absent `_metadata`', async () => {
    await build().recordRunStarted(startInput());

    expect(persistedShape().metaData).toBeUndefined();
  });

  it('writes NOTHING for an empty bag either — `{}` is not a fact worth recording', async () => {
    await build().recordRunStarted(startInput({}));

    expect(persistedShape().metaData).toBeUndefined();
  });

  it('leaves the idempotent re-delivery alone — an existing run is returned, never re-stamped', async () => {
    // The existing row wins by contract (idempotent on tenantId/sessionId/runId). A second
    // delivery carrying metaData must not create a row, and must not rewrite the first one's.
    mockRepository.findByRunKey.mockResolvedValue({
      id: 'run-row-1',
      tenantId: TENANT,
      workflowVersionId: 'def-1',
      workflowSlug: 'triage_flow',
      workflowVersionNumber: 1,
      definitionName: 'Triage Flow',
      sessionId: 'workflow-interpreter-run-1',
      runId: 'run-1',
      trigger: 'api invoke',
      status: 'RUNNING',
      isSandbox: false,
      startedAt: new Date('2026-09-11T00:00:00Z'),
      endedAt: null,
      durationMs: null,
      nodeCount: null,
      failedNodeCount: 0,
      degradedNodeCount: 0,
      firstErrorCode: null,
      resultRef: null,
      createdAt: new Date('2026-09-11T00:00:00Z'),
      updatedAt: new Date('2026-09-11T00:00:00Z'),
      version: 1,
    });

    await build().recordRunStarted(startInput({ actingUserId: ACTING_USER }));

    expect(mockRepository.create).not.toHaveBeenCalled();
    expect(mockRepository.update).not.toHaveBeenCalled();
  });
});
