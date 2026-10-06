/**
 * TASK-1048 (OD-2) — `AgentResolverService.resolveModelBySlug`: the platform default
 * speaker-embedding model is resolved EXACTLY like an agent-named auxiliary slug — the caller's
 * own row first, then the SYSTEM catalogue — through the same mapping `materialiseModels` uses,
 * and additionally refused when the row is not of the task the caller needs.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SYSTEM_TENANT_ID } from '@arcaai/domains';
import { AgentResolverService } from '../agent-resolver.service';

const TENANT = '50000000-0000-0000-0000-000000000001';
const aiModelRepository = { findById: vi.fn(), findBySlug: vi.fn() };

const embeddingRow = (over: Record<string, unknown> = {}) => ({
  id: 'emb-1',
  tenantId: SYSTEM_TENANT_ID,
  slug: 'wespeaker-voxceleb-resnet34',
  taskType: 'SPEAKER_EMBEDDING',
  sourceUri: 'pyannote/wespeaker-voxceleb-resnet34-LM',
  sourceRevision: null,
  localPath: null,
  checksum: null,
  format: 'PYTORCH',
  computeType: null,
  provider: null,
  ...over,
});

const make = () => new AgentResolverService({} as never, {} as never, aiModelRepository as never, {} as never);

beforeEach(() => {
  vi.clearAllMocks();
  aiModelRepository.findBySlug.mockResolvedValue(null);
});

describe('AgentResolverService.resolveModelBySlug (TASK-1048)', () => {
  it('falls back to the SYSTEM catalogue row and returns it in the resolved-model shape, under the requested role', async () => {
    aiModelRepository.findBySlug.mockImplementation(async (tenantId: string) => (tenantId === SYSTEM_TENANT_ID ? embeddingRow() : null));
    const model = await make().resolveModelBySlug('wespeaker-voxceleb-resnet34', TENANT, { role: 'embedding', taskType: 'SPEAKER_EMBEDDING' });
    expect(aiModelRepository.findBySlug).toHaveBeenNthCalledWith(1, TENANT, 'wespeaker-voxceleb-resnet34');
    expect(aiModelRepository.findBySlug).toHaveBeenNthCalledWith(2, SYSTEM_TENANT_ID, 'wespeaker-voxceleb-resnet34');
    expect(model).toMatchObject({
      role: 'embedding',
      slug: 'wespeaker-voxceleb-resnet34',
      sourceUri: 'pyannote/wespeaker-voxceleb-resnet34-LM',
      format: 'PYTORCH',
      tenantId: SYSTEM_TENANT_ID,
    });
  });

  it("prefers the tenant's own row of that slug", async () => {
    aiModelRepository.findBySlug.mockImplementation(async (tenantId: string) =>
      tenantId === TENANT ? embeddingRow({ tenantId: TENANT, sourceUri: 'own/weights' }) : embeddingRow(),
    );
    const model = await make().resolveModelBySlug('wespeaker-voxceleb-resnet34', TENANT, { role: 'embedding', taskType: 'SPEAKER_EMBEDDING' });
    expect(model?.tenantId).toBe(TENANT);
    expect(model?.sourceUri).toBe('own/weights');
  });

  it('answers null for a slug no tier holds', async () => {
    expect(await make().resolveModelBySlug('nope', TENANT, { role: 'embedding', taskType: 'SPEAKER_EMBEDDING' })).toBeNull();
  });

  it('answers null for a row of another task — a slug is not a model of the kind the caller needs', async () => {
    aiModelRepository.findBySlug.mockResolvedValue(embeddingRow({ taskType: 'AUTOMATIC_SPEECH_RECOGNITION' }));
    expect(await make().resolveModelBySlug('wespeaker-voxceleb-resnet34', TENANT, { role: 'embedding', taskType: 'SPEAKER_EMBEDDING' })).toBeNull();
  });
});
