/**
 * TASK-950 (decision 2, fast win) — `WorkflowRun._metadata` becomes READABLE.
 *
 * `WorkflowRunService.recordRunStarted` has been writing `{ actingUserId }` into the row's
 * `_metadata` since lane I, but the entity carried no `metaData` field, so the value was
 * queryable in SQL (`_metadata->>'actingUserId'`) and invisible to every read path that goes
 * through the entity. `IBaseEntity.metaData` is declared and never wired on the abstract
 * `BaseEntity`, so the fix is the same local wiring `PromptTemplateEntity`, `AiModelEntity` and
 * `PasswordResetTokenEntity` already carry.
 *
 * What this file locks in:
 *   1. the factory accepts `metaData` and, unlike every other optional prop, does NOT coerce an
 *      omitted one to `null` — absence has to stay absence, because lane I's own service test
 *      (`workflow-run.acting-user.task950.test.ts`) pins `toObject().metaData === undefined` for
 *      a caller that recorded nothing;
 *   2. the entity exposes it through the standard `setProperty` change-tracking getter/setter
 *      pair, so an edit lands in `changes` like any other field;
 *   3. the mapper round-trips it in BOTH directions while never writing `_version` — the OCC
 *      guard `03-domain-layer.md` requires intact on every mapper this ticket touches.
 */
import { describe, it, expect } from 'vitest';

import { WorkflowRunFactory } from '../../../../factories/generated/core/WorkflowRunFactory';
import { WorkflowRunEntityMapper } from '../../../../mappers/generated/core/WorkflowRunEntityMapper';
import { WorkflowRun } from '../../../../models/generated/core/WorkflowRunModel';
import { WorkflowRunStatus } from '../../../../enums/generated/WorkflowRunStatus';

const TENANT = '50000000-0000-0000-0000-000000000000';
const ACTING_USER = '70000000-0000-0000-0000-0000000009e5';
const STARTED_AT = new Date('2026-09-11T00:00:00.000Z');

const makeEntity = (metaData?: Record<string, unknown>) =>
  WorkflowRunFactory.CreateRun({
    tenantId: TENANT,
    workflowVersionId: 'def-1',
    workflowSlug: 'triage_flow',
    workflowVersionNumber: 1,
    definitionName: 'Triage Flow',
    sessionId: 'workflow-interpreter-run-1',
    runId: 'run-1',
    trigger: 'api invoke',
    startedAt: STARTED_AT,
    ...(metaData === undefined ? {} : { metaData }),
  });

const runRow = (overrides: Partial<WorkflowRun> = {}): WorkflowRun =>
  new WorkflowRun({
    id: 'wfr-950-1',
    tenantId: TENANT,
    workflowVersionId: 'def-1',
    workflowSlug: 'triage_flow',
    workflowVersionNumber: 1,
    definitionName: 'Triage Flow',
    sessionId: 'workflow-interpreter-run-1',
    runId: 'run-1',
    trigger: 'api invoke',
    status: WorkflowRunStatus.RUNNING,
    isSandbox: false,
    startedAt: STARTED_AT,
    endedAt: null,
    durationMs: null,
    nodeCount: null,
    failedNodeCount: 0,
    degradedNodeCount: 0,
    firstErrorCode: null,
    resultRef: null,
    createdBy: null,
    updatedBy: null,
    createdAt: STARTED_AT,
    updatedAt: STARTED_AT,
    version: 1,
    metaData: { actingUserId: ACTING_USER },
    ...overrides,
  } as WorkflowRun);

describe('TASK-950 — WorkflowRunFactory.CreateRun(metaData)', () => {
  it('carries metaData through the factory and exposes it via the getter', () => {
    const entity = makeEntity({ actingUserId: ACTING_USER });

    expect(entity.metaData).toEqual({ actingUserId: ACTING_USER });
  });

  it('stores the bag VERBATIM — `_metadata` is a pass-through, not a schema', () => {
    const entity = makeEntity({ actingUserId: ACTING_USER, somethingElse: 7 });

    expect(entity.metaData).toEqual({ actingUserId: ACTING_USER, somethingElse: 7 });
  });

  it('leaves metaData ABSENT when omitted — deliberately not defaulted to null', () => {
    // The three states have to stay distinguishable: omitted ("nothing to record"), `{}`
    // ("measured, found nothing") and a populated bag. `?? null` here would collapse the first
    // into a stored fact nobody asserted, and would break lane I's `toObject()` assertion.
    const entity = makeEntity();

    expect(entity.metaData).toBeUndefined();
    expect((entity.toObject() as { metaData?: unknown }).metaData).toBeUndefined();
  });

  it('keeps an explicitly empty bag distinguishable from an omitted one', () => {
    const entity = makeEntity({});

    expect(entity.metaData).toEqual({});
  });
});

describe('TASK-950 — WorkflowRunEntity.metaData change tracking', () => {
  it('records a tracked change when metaData is assigned via the setter', () => {
    const entity = makeEntity();

    entity.metaData = { actingUserId: ACTING_USER };

    expect(entity.metaData).toEqual({ actingUserId: ACTING_USER });
    expect(entity.changes).toMatchObject({ metaData: { actingUserId: ACTING_USER } });
  });

  it('tracks nothing while metaData is untouched (setProperty is the only writer)', () => {
    const entity = makeEntity({ actingUserId: ACTING_USER });

    expect(entity.changes).not.toHaveProperty('metaData');
  });
});

describe('TASK-950 — WorkflowRunEntityMapper.metaData round trip', () => {
  const mapper = new WorkflowRunEntityMapper();

  it('toDomainEntity carries metaData from the persisted row onto the entity', () => {
    const entity = mapper.toDomainEntity(runRow());

    expect(entity.metaData).toEqual({ actingUserId: ACTING_USER });
  });

  it('toPersistence (full insert path) round-trips metaData and never writes `version`', () => {
    const entity = mapper.toDomainEntity(runRow());

    const persisted = mapper.toPersistence(entity);

    expect(persisted.metaData).toEqual({ actingUserId: ACTING_USER });
    // WorkflowRun IS OCC-written, so its mapper strips the DB-owned `_version` on BOTH paths.
    expect(persisted).not.toHaveProperty('version');
  });

  it('toPersistenceChanges (update path) carries an edited metaData and never writes `version`', () => {
    const entity = mapper.toDomainEntity(runRow());

    entity.metaData = { actingUserId: ACTING_USER, revised: true };
    const changes = mapper.toPersistenceChanges(entity);

    expect(changes.metaData).toEqual({ actingUserId: ACTING_USER, revised: true });
    expect(changes).not.toHaveProperty('version');
  });

  it('round-trips a null metaData (an empty column) without inventing a bag', () => {
    const entity = mapper.toDomainEntity(runRow({ metaData: null }));

    expect(entity.metaData).toBeNull();
    expect(mapper.toPersistence(entity).metaData).toBeNull();
  });

  it('round-trips a factory-built entity that recorded nothing — the INSERT carries no bag', () => {
    // `BaseDataModel` coerces the absent value to `null` at the model boundary, which is exactly
    // what the column held before this change: the write path is unaltered by the read-back.
    const persisted = mapper.toPersistence(makeEntity());

    expect(persisted.metaData).toBeNull();
  });
});
