/**
 * TASK-1021 (D-13) — the seeded vLLM row (`arcaai-whisper-large-ml-en-vllm`, `provider: 'vllm'`)
 * is usable exactly when the SYSTEM `stt/vllm` connection is ENABLED. Its bucket measurement is
 * deliberately MISSING here: were the row classified platform-self-host, the bucket would decide
 * instead and both verdicts below would read `weights-not-available`.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AiModelService } from '../aiModel.service';

const SYSTEM_TENANT_ID = '00000000-0000-0000-0000-000000000000';
const TENANT_ID = 'tenant-1';

/** The seeded row, with only the fields the catalogue reads. */
const VLLM_ROW = {
  id: '80000000-0000-0000-0001-000000000026',
  slug: 'arcaai-whisper-large-ml-en-vllm',
  name: 'ArcaAI Whisper Large ML-EN Code-Switch (vLLM)',
  description: null,
  tenantId: SYSTEM_TENANT_ID,
  provider: 'vllm',
  taskType: 'AUTOMATIC_SPEECH_RECOGNITION',
  deploymentKind: 'SELF_HOSTED',
  availability: 'MISSING',
  isPlatformDefaultFor: [],
  resourceStatus: 'ENABLED',
  tags: [],
  metaData: { asr: { quantization: 'none', maxModelLen: 448 }, serving: { vramGiB: 5, maxNumSeqs: 64 } },
  bucketPrefix: null,
  primaryObject: null,
  sourceUri: 'taphuynh/whisper-turbo-ml-en-codeswitch-fullft-2607.29.1-fp16',
  sourceRevision: 'main',
  wireModelId: null,
  checksum: null,
  version: 1,
  format: 'SAFETENSOR',
  libraryName: 'vllm',
  servedBy: 'vllm',
};

const cls = {
  get: vi.fn((key: string) => (key === 'user' ? { id: 'u-1', roles: ['TENANT_ADMIN'] } : key === 'tenantId' ? TENANT_ID : null)),
  set: vi.fn(),
};
const repository = { findAll: vi.fn(async () => [VLLM_ROW]), findById: vi.fn(), findBySlug: vi.fn(), count: vi.fn() };
const tenants = { findById: vi.fn(async () => ({ id: TENANT_ID, plan: 'ENTERPRISE' })) };

/** The SYSTEM `stt/vllm` connection, enabled or not; the cascade resolves it only when enabled. */
function connections(enabled: boolean) {
  const systemRow = {
    id: 'sys-stt-vllm',
    tenantId: SYSTEM_TENANT_ID,
    service: 'stt',
    provider: 'vllm',
    enabled,
    encryptedApiKey: new Uint8Array([1]),
  };
  return {
    list: vi.fn(async () => []),
    findRow: vi.fn(async () => null),
    findDefaultRow: vi.fn(async (service: string, provider: string, tenantId: string) =>
      service === 'stt' && provider === 'vllm' && tenantId === SYSTEM_TENANT_ID ? systemRow : null,
    ),
    resolveConnection: vi.fn(async (service: string, provider: string) =>
      enabled && service === 'stt' && provider === 'vllm'
        ? { service, provider, encryptedApiKey: systemRow.encryptedApiKey, source: 'system' }
        : null,
    ),
  };
}

function build(enabled: boolean): AiModelService {
  return new (AiModelService as unknown as new (...args: unknown[]) => AiModelService)(
    repository,
    { baseClient: {} },
    { emit: vi.fn() },
    cls,
    connections(enabled),
    tenants,
  );
}

describe('TASK-1021 — the seeded vLLM row follows the SYSTEM stt/vllm connection', () => {
  beforeEach(() => vi.clearAllMocks());

  it('is engine-served and USABLE while the connection is enabled', async () => {
    const model = (await build(true).getCatalogue()).models.find((m) => m.id === VLLM_ROW.id)!;
    expect(model.providerClass).toBe('engine-served');
    expect(model.usable).toBe(true);
    expect(model.unusableReason).toBeNull();
  });

  it('is UNUSABLE (no-enabled-connection) once the platform disables the connection', async () => {
    const model = (await build(false).getCatalogue()).models.find((m) => m.id === VLLM_ROW.id)!;
    expect(model.providerClass).toBe('engine-served');
    expect(model.usable).toBe(false);
    expect(model.unusableReason).toBe('no-enabled-connection');
  });
});
