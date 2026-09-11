/**
 * TASK-950 (decision 2, fast win) — the acting clinician READS BACK.
 *
 * Lane I made `recordRunStarted` stamp `{ actingUserId }` into `WorkflowRun._metadata`. That made
 * the answer queryable in SQL but not readable through any API: `WorkflowRunEntity` had no
 * `metaData` accessor, so every read path that goes through the DTO mapper dropped it on the
 * floor. This file pins the other half — the two response surfaces that now carry it.
 *
 * ## Why the extraction is narrowed, and why it lives in ONE place
 *
 * `_metadata` is a pass-through bag (`RecordRunStartedInput.metaData` stores whatever the caller
 * passed, verbatim). Nothing guarantees `actingUserId` is present, and nothing guarantees it is a
 * string — a future caller may stash something else under that key. So the read narrows to
 * `string` and answers `null` for everything else, and it does that in `WorkflowRunDtoMapper`
 * alone: `WorkflowExposureDtoMapper.toStatusResponse` takes the already-extracted id, so the run
 * response and the status response can never disagree about what counts as a valid value.
 *
 * ## Why `null` and not "absent"
 *
 * On the WRITE side an omitted bag stays omitted, because `{}` is a different claim from "nothing
 * to record". On the READ side there is no such distinction to preserve: every reason the value
 * is missing — a human caller, a consultation-bound run, a schema with no identity field, a bag
 * that never carried the key — answers the reader's question the same way. One `null`.
 */
import { describe, it, expect } from 'vitest';
import { WorkflowRunDtoMapper } from '../workflow-run.dto.mapper';
import { WorkflowExposureDtoMapper } from '../../workflow-exposure/workflow-exposure.dto.mapper';

const ACTING_USER = '70000000-0000-0000-0000-0000000009e5';
const STARTED_AT = new Date('2026-09-11T00:00:00.000Z');

/** A run row as the entity presents it — only the fields `toResponse` reads. */
const runEntity = (overrides: Record<string, unknown> = {}) =>
  ({
    id: 'run-row-1',
    tenantId: 'tenant-1',
    workflowVersionId: 'def-1',
    workflowSlug: 'triage_flow',
    workflowVersionNumber: 1,
    definitionName: 'Triage Flow',
    sessionId: 'workflow-interpreter-run-1',
    runId: 'run-1',
    trigger: 'api invoke',
    status: 'RUNNING',
    isSandbox: false,
    startedAt: STARTED_AT,
    endedAt: null,
    durationMs: null,
    nodeCount: null,
    failedNodeCount: 0,
    degradedNodeCount: 0,
    firstErrorCode: null,
    resultRef: null,
    metaData: { actingUserId: ACTING_USER },
    createdAt: STARTED_AT,
    updatedAt: STARTED_AT,
    version: 1,
    ...overrides,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  }) as any;

const upstream = {
  runId: 'run-1',
  status: 'RUNNING',
  stages: [{ stageIndex: 0 }] as Record<string, unknown>[],
  startedAt: STARTED_AT.toISOString(),
  endedAt: null,
};

describe('TASK-950 — WorkflowRunDtoMapper surfaces actingUserId', () => {
  it('reads the id out of the row’s `_metadata`', () => {
    const dto = WorkflowRunDtoMapper.toResponse(runEntity());

    expect(dto.actingUserId).toBe(ACTING_USER);
  });

  it('answers null when `_metadata` is absent — the run recorded nothing', () => {
    expect(WorkflowRunDtoMapper.toResponse(runEntity({ metaData: undefined })).actingUserId).toBeNull();
  });

  it('answers null when `_metadata` is an empty column', () => {
    expect(WorkflowRunDtoMapper.toResponse(runEntity({ metaData: null })).actingUserId).toBeNull();
  });

  it('answers null when the bag carries other keys but no actingUserId', () => {
    expect(WorkflowRunDtoMapper.toResponse(runEntity({ metaData: { somethingElse: 7 } })).actingUserId).toBeNull();
  });

  it('answers null for a non-string value — the bag is untyped, so the read narrows', () => {
    // `_metadata` is stored verbatim; a caller could put anything under this key. Passing a
    // number (or an object) straight through would hand the API a field that claims to be a
    // user id and is not.
    expect(WorkflowRunDtoMapper.toResponse(runEntity({ metaData: { actingUserId: 42 } })).actingUserId).toBeNull();
    expect(WorkflowRunDtoMapper.toResponse(runEntity({ metaData: { actingUserId: null } })).actingUserId).toBeNull();
    expect(WorkflowRunDtoMapper.toResponse(runEntity({ metaData: { actingUserId: { id: ACTING_USER } } })).actingUserId).toBeNull();
  });

  it('leaves every other field of the response untouched', () => {
    const dto = WorkflowRunDtoMapper.toResponse(runEntity());

    expect(dto).toMatchObject({
      id: 'run-row-1',
      workflowSlug: 'triage_flow',
      status: 'RUNNING',
      resultRef: null,
      startedAt: STARTED_AT.toISOString(),
    });
  });
});

describe('TASK-950 — WorkflowExposureDtoMapper.toStatusResponse carries actingUserId', () => {
  it('surfaces the id the run read model supplied', () => {
    const status = WorkflowExposureDtoMapper.toStatusResponse('triage_flow', 1, upstream, null, ACTING_USER);

    expect(status.actingUserId).toBe(ACTING_USER);
  });

  it('defaults to null when the caller supplies nothing', () => {
    // Same provenance rule as `resultRef`: both come from the durable run row, never from
    // Temporal, so a caller with no row to read from reports an honest absence.
    const status = WorkflowExposureDtoMapper.toStatusResponse('triage_flow', 1, upstream);

    expect(status.actingUserId).toBeNull();
    expect(status.resultRef).toBeNull();
  });

  it('composes with the run mapper — the extracted id is what the status response reports', () => {
    const run = WorkflowRunDtoMapper.toResponse(runEntity());

    const status = WorkflowExposureDtoMapper.toStatusResponse(
      run.workflowSlug,
      run.workflowVersionNumber,
      upstream,
      run.resultRef,
      run.actingUserId ?? null,
    );

    expect(status.actingUserId).toBe(ACTING_USER);
  });

  it('composes to null when the run recorded nothing', () => {
    const run = WorkflowRunDtoMapper.toResponse(runEntity({ metaData: null }));

    const status = WorkflowExposureDtoMapper.toStatusResponse(
      run.workflowSlug,
      run.workflowVersionNumber,
      upstream,
      run.resultRef,
      run.actingUserId ?? null,
    );

    expect(status.actingUserId).toBeNull();
  });
});
