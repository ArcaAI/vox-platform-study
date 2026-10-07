import { AgentTask, ResourceStatusType, SYSTEM_TENANT_ID, WorkflowDefinitionStatus } from '@arcaai/domains';
import { describe, expect, it, vi } from 'vitest';
import { ImplicitLivePathReader } from '../implicit-live-path';

/**
 * TASK-1051 review finding 2 — the pin set and `usage.liveConsultation` are ONE membership:
 *  - only a SYSTEM self-hosted catalogue row enters the residency live path (a tenant's own BYO
 *    row is served by the tenant's connection, never pinned/loaded on the platform's runtimes);
 *  - a pin entry names EVERY catalogue id that shares its (service, ref) key, so classify can
 *    never answer ON_DEMAND for a row the usage index calls live.
 * Review finding 8 — the reader reports whether its last snapshot is trustworthy (`status()`).
 */
const T1 = '50000000-0000-0000-0000-000000000001';
const PUBLISHED = { status: WorkflowDefinitionStatus.PUBLISHED, isActive: true, resourceStatus: ResourceStatusType.ENABLED };
type Row = Record<string, unknown>;

function reader(state: { agents: Row[]; assignments: Row[]; models: Row[]; routing?: Row[] }) {
  const repo = (rows: () => Row[]) => ({ findAll: vi.fn(async () => rows()) });
  const repos = {
    assignments: repo(() => state.assignments),
    agents: repo(() => state.agents),
    aiModels: repo(() => state.models),
    fallbacks: repo(() => []),
    routing: repo(() => state.routing ?? []),
    workflows: repo(() => []),
    workflowAssignments: repo(() => []),
  };
  const livePath = new ImplicitLivePathReader(
    repos.assignments as never,
    repos.agents as never,
    repos.aiModels as never,
    repos.fallbacks as never,
    repos.routing as never,
    repos.workflows as never,
    repos.workflowAssignments as never,
  );
  return { livePath, repos };
}

const selfHosted = (over: Row): Row => ({ tenantId: SYSTEM_TENANT_ID, deploymentKind: 'SELF_HOSTED', provider: null, wireModelId: null, ...over });

describe('ImplicitLivePathReader — review finding 2', () => {
  it('a tenant BYO row never enters the live path, even when a live agent names it; its usage is not live', async () => {
    const { livePath } = reader({
      agents: [{ ...PUBLISHED, id: 'a1', tenantId: T1, slug: 'byo', name: 'BYO', task: AgentTask.TEXT_GENERATION, modelId: 'm-byo' }],
      assignments: [{ tenantId: T1, agentSlug: 'byo', task: AgentTask.TEXT_GENERATION }],
      models: [
        selfHosted({
          id: 'm-byo',
          tenantId: T1,
          slug: 'byo-llm',
          sourceUri: 'x',
          servedBy: 'lmstudio',
          provider: 'lm-studio',
          wireModelId: 'my-llm',
        }),
      ],
    });
    const snapshot = await livePath.readSnapshot(1_000);
    expect(snapshot.livePath).toEqual([]);
    expect(snapshot.pinnedModelIds.has('m-byo')).toBe(false);
    expect(snapshot.uses.get('m-byo')?.every((u) => !u.liveConsultation)).toBe(true);
  });

  it('a SYSTEM row that is not SELF_HOSTED never pins', async () => {
    const { livePath } = reader({
      agents: [{ ...PUBLISHED, id: 'a1', tenantId: T1, slug: 's', name: 'S', task: AgentTask.TEXT_GENERATION, modelId: 'm-cloud' }],
      assignments: [{ tenantId: T1, agentSlug: 's', task: AgentTask.TEXT_GENERATION }],
      models: [
        selfHosted({
          id: 'm-cloud',
          slug: 'c',
          sourceUri: 'x',
          servedBy: 'lmstudio',
          provider: 'lm-studio',
          wireModelId: 'c',
          deploymentKind: 'CLOUD',
        }),
      ],
    });
    expect(await livePath.read(1_000)).toEqual([]);
  });

  it('a pin entry carries every SYSTEM id sharing its (service, ref) key — exactly the pinned ids whose usage is live', async () => {
    const { livePath } = reader({
      agents: [
        { ...PUBLISHED, id: 'a1', tenantId: T1, slug: 'one', name: 'One', task: AgentTask.TEXT_GENERATION, modelId: 'm-a' },
        { ...PUBLISHED, id: 'a2', tenantId: T1, slug: 'two', name: 'Two', task: AgentTask.TEXT_GENERATION, modelId: 'm-b' },
      ],
      assignments: [
        { tenantId: T1, agentSlug: 'one', task: AgentTask.TEXT_GENERATION },
        { tenantId: T1, agentSlug: 'two', task: AgentTask.TEXT_GENERATION },
      ],
      models: [
        selfHosted({ id: 'm-a', slug: 'a', sourceUri: 'x', servedBy: 'lmstudio', provider: 'lm-studio', wireModelId: 'same-wire' }),
        selfHosted({ id: 'm-b', slug: 'b', sourceUri: 'x', servedBy: 'lmstudio', provider: 'lm-studio', wireModelId: 'same-wire' }),
      ],
    });
    const snapshot = await livePath.readSnapshot(1_000);
    expect(snapshot.livePath).toHaveLength(1);
    expect([...snapshot.livePath[0].aiModelIds].sort()).toEqual(['m-a', 'm-b']);
    const live = [...snapshot.uses].filter(([, uses]) => uses.some((u) => u.liveConsultation)).map(([id]) => id);
    expect(live.sort()).toEqual([...snapshot.livePath.flatMap((l) => l.aiModelIds)].sort());
  });
});

describe('ImplicitLivePathReader.status — review finding 8', () => {
  const healthy = () =>
    reader({
      agents: [{ ...PUBLISHED, id: 'a1', tenantId: T1, slug: 'rt', name: 'RT', task: AgentTask.SPEECH_TO_TEXT, modelId: 'm-asr' }],
      assignments: [{ tenantId: T1, agentSlug: 'rt', task: AgentTask.SPEECH_TO_TEXT }],
      models: [selfHosted({ id: 'm-asr', slug: 'whisper', sourceUri: 'x', servedBy: 'stt' })],
    });

  it('is unread before the first read, then names the snapshot time, the live assignments and the consumers counted', async () => {
    const { livePath } = healthy();
    expect(livePath.status()).toEqual({ at: null, error: null, liveAssignments: 0, consumers: 0 });
    await livePath.read(1_000);
    expect(livePath.status()).toEqual({ at: 1_000, error: null, liveAssignments: 1, consumers: 1 });
  });

  it('records a failed refresh (cold or warm) until the next good one', async () => {
    const { livePath, repos } = healthy();
    repos.routing.findAll.mockRejectedValueOnce(new Error('db down'));
    await livePath.read(1_000);
    expect(livePath.status()).toMatchObject({ at: null, error: 'db down' });

    await livePath.read(2_000);
    expect(livePath.status()).toMatchObject({ at: 2_000, error: null });

    livePath.invalidate();
    repos.routing.findAll.mockRejectedValueOnce(new Error('still down'));
    await livePath.read(3_000);
    expect(livePath.status()).toMatchObject({ error: 'still down' });
  });
});
