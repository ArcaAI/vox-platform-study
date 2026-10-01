import { describe, expect, it, vi } from 'vitest';

import { CheckpointRestorePostCommit, SERVICE_ACCOUNT_TOKEN_PREFIX, type PostCommitContext } from '../post-commit';
import type { ReconcileResult } from '../reconciler';

const TENANT = '1032a000-0000-4000-8000-000000001032';

function result(over: Partial<ReconcileResult> = {}): ReconcileResult {
  return {
    counts: [],
    warnings: [],
    touchedUserIds: [],
    knowledge: { reingest: [], retired: [], chunks: {} },
    retiredConsultationIds: [],
    retiredServiceAccountIds: [],
    ...over,
  };
}

function setup() {
  const calls: string[] = [];
  const redisData = new Map<string, string>([
    [`${SERVICE_ACCOUNT_TOKEN_PREFIX}a`, JSON.stringify({ serviceAccountId: 'sa-retired' })],
    [`${SERVICE_ACCOUNT_TOKEN_PREFIX}b`, JSON.stringify({ serviceAccountId: 'sa-kept' })],
  ]);
  const deps = {
    appSettings: { refreshCache: vi.fn(async () => void calls.push('refresh')) },
    emitter: { emit: vi.fn() },
    jwt: { revokeAllForUser: vi.fn(async () => undefined) },
    redis: {
      keys: vi.fn(async () => [...redisData.keys()]),
      get: vi.fn(async (k: string) => redisData.get(k) ?? null),
      delMany: vi.fn(async (ks: string[]) => ks.forEach((k) => redisData.delete(k))),
      publish: vi.fn(async () => 1),
    },
    queue: { add: vi.fn(async () => ({})) },
    vectors: { deleteByDocument: vi.fn(async ({ knowledgeDocumentId }: { knowledgeDocumentId: string }) => void calls.push(`vectors:${knowledgeDocumentId}`)) },
    secrets: { decryptBatch: vi.fn(async (cts: string[]) => cts.map((c) => Buffer.from(`plain(${c})`))) },
    policy: { invalidateTenant: vi.fn(async () => undefined) },
  };
  const post = new CheckpointRestorePostCommit(
    deps.appSettings as never,
    deps.emitter as never,
    deps.jwt as never,
    deps.redis as never,
    deps.queue as never,
    deps.vectors as never,
    deps.secrets as never,
    deps.policy as never,
  );
  const query = vi.fn(async (sql: string) => {
    calls.push(sql.includes('KnowledgeChunk') ? 'chunks' : sql.includes('WorkflowRun') ? 'runs' : 'sql');
    return [];
  });
  const ctx = (over: Partial<PostCommitContext> = {}): PostCommitContext => ({
    tenantId: TENANT,
    restoreId: 'r1',
    actorId: 'actor',
    categories: ['CONFIG_CONTENT'],
    result: result(),
    query,
    ...over,
  });
  return { post, deps, query, ctx, calls, redisData };
}

describe('CheckpointRestorePostCommit', () => {
  it('re-ingests a restored document from its checkpoint chunks in chunkIndex order, after retiring live chunks and vectors', async () => {
    const t = setup();
    const warnings = await t.post.run(
      t.ctx({
        result: result({
          knowledge: {
            reingest: ['doc1'],
            retired: ['doc0'],
            chunks: { doc1: [{ chunkIndex: 1, encryptedText: 'vault:v1:B' }, { chunkIndex: 0, encryptedText: 'vault:v1:A' }] },
          },
        }),
      }),
    );

    expect(warnings).toEqual([]);
    expect(t.calls.indexOf('chunks')).toBeLessThan(t.calls.indexOf('vectors:doc1'));
    expect(t.deps.vectors.deleteByDocument).toHaveBeenCalledWith({ tenantId: TENANT, knowledgeDocumentId: 'doc0' });
    expect(t.deps.secrets.decryptBatch).toHaveBeenCalledWith(['vault:v1:A', 'vault:v1:B'], 'hope-phi');
    expect(t.deps.queue.add).toHaveBeenCalledWith(
      'IngestKnowledgeDocument',
      expect.objectContaining({ knowledgeDocumentId: 'doc1', tenantId: TENANT, text: 'plain(vault:v1:A)\n\nplain(vault:v1:B)' }),
      expect.objectContaining({ attempts: 3 }),
    );
    expect(t.query.mock.calls.find(([sql]) => sql.includes('KnowledgeChunk'))![1]).toEqual([TENANT, ['doc0', 'doc1'], 'actor']);
  });

  it('settings: refreshes the cache and emits ResourceUpdated(GlobalSetting) for the cross-instance fan-out', async () => {
    const t = setup();
    await t.post.run(t.ctx());
    expect(t.deps.appSettings.refreshCache).toHaveBeenCalled();
    expect(t.deps.emitter.emit).toHaveBeenCalledWith('SysEvent.ResourceUpdated', expect.objectContaining({ resourceType: 'GlobalSetting', tenantId: TENANT }));
    expect(t.deps.redis.publish).toHaveBeenCalledWith('rate-limit-rules:invalidate', expect.any(String));
  });

  it('purges only the exchanged tokens of retired service accounts; a purge failure is a warning', async () => {
    const t = setup();
    await t.post.run(t.ctx({ categories: ['USERS_ACCESS'], result: result({ retiredServiceAccountIds: ['sa-retired'] }) }));
    expect([...t.redisData.keys()]).toEqual([`${SERVICE_ACCOUNT_TOKEN_PREFIX}b`]);

    const u = setup();
    u.deps.redis.keys.mockRejectedValueOnce(new Error('redis down'));
    const warnings = await u.post.run(u.ctx({ categories: ['USERS_ACCESS'], result: result({ retiredServiceAccountIds: ['sa-retired'] }) }));
    expect(warnings.map((w) => w.code)).toEqual(['SERVICE_ACCOUNT_TOKEN_PURGE_FAILED']);
  });

  it('revokes sessions of touched members and cancels running workflow runs of retired consultations', async () => {
    const t = setup();
    await t.post.run(t.ctx({ categories: ['USERS_ACCESS', 'CLINICAL'], result: result({ touchedUserIds: ['u1', 'u2'], retiredConsultationIds: ['c1'] }) }));
    expect(t.deps.jwt.revokeAllForUser.mock.calls).toEqual([['u1'], ['u2']]);
    expect(t.deps.policy.invalidateTenant).toHaveBeenCalledWith(TENANT);
    const run = t.query.mock.calls.find(([sql]) => sql.includes('WorkflowRun'))!;
    expect(run[0]).toContain(`"status" = 'CANCELED'`);
    expect(run[1]).toEqual([TENANT, ['c1'], 'tenant-restore:r1']);
  });
});
