/**
 * TASK-1042 (C8) — `TranscriptionJob._metadata` becomes READABLE and WRITABLE through the entity.
 *
 * A streaming job row now carries the session's owner (`metaData.owner`, stamped at session
 * create) and its run binding (`metaData.boundRun`, written with OCC at run start). The column
 * existed, but the entity carried no `metaData` field, so both values were dropped on read and
 * never reached `toPersistenceChanges` on write — the same gap `WorkflowRunEntity` closed in
 * TASK-950, closed the same way.
 */
import { describe, it, expect } from 'vitest';

import { TranscriptionJobFactory } from '../../../../factories/generated/core/TranscriptionJobFactory';
import { TranscriptionJobEntityMapper } from '../../../../mappers/generated/core/TranscriptionJobEntityMapper';
import { TranscriptionJobType } from '../../../../enums/generated/TranscriptionJobType';

const TENANT = '50000000-0000-0000-0000-000000000000';

const makeJob = (metaData?: Record<string, unknown>) =>
  TranscriptionJobFactory.CreateTranscriptionJob({
    tenantId: TENANT,
    jobType: TranscriptionJobType.STREAMING,
    streamSessionId: 'stt-1',
    ...(metaData === undefined ? {} : { metaData }),
  });

describe('TranscriptionJob metaData (TASK-1042 C8)', () => {
  it('the factory carries metaData onto the entity, and leaves it absent when omitted', () => {
    const owner = { type: 'apiKey', id: 'key-1' };
    expect(makeJob({ owner }).metaData).toEqual({ owner });
    expect(makeJob().metaData).toBeUndefined();
  });

  it('a metaData edit is change-tracked, and the mapper writes it without `version`', () => {
    const job = makeJob({ owner: { type: 'user', id: 'u-1' } });
    job.clearChanges();
    job.metaData = { owner: { type: 'user', id: 'u-1' }, boundRun: { runId: 'run-1' } };
    const changes = TranscriptionJobEntityMapper.getInstance().toPersistenceChanges(job) as Record<string, unknown>;
    expect(changes.metaData).toEqual({ owner: { type: 'user', id: 'u-1' }, boundRun: { runId: 'run-1' } });
    expect(changes).not.toHaveProperty('version');
  });

  it('the mapper round-trips metaData from a stored row', () => {
    const mapper = TranscriptionJobEntityMapper.getInstance();
    const row = mapper.toPersistence(makeJob({ owner: { type: 'serviceAccount', id: 'sa-1' } }));
    expect((row as { metaData?: unknown }).metaData).toEqual({ owner: { type: 'serviceAccount', id: 'sa-1' } });
    expect(mapper.toDomainEntity(row).metaData).toEqual({ owner: { type: 'serviceAccount', id: 'sa-1' } });
  });
});
