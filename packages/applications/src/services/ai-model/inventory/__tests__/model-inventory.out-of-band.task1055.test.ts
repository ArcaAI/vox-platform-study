/**
 * TASK-1055 §10.7 follow-up 3 — rows published OUTSIDE the publisher's flat layout.
 *
 * Two layouts reach the bucket without a `bucketPrefix` on the row: the HuggingFace cache tree written
 * by the deployment repo's `out-of-band/hope-models-publish.yaml`, and the LM Studio GGUF serving tier
 * (`<dir>-gguf/<version>/`, linked into LM Studio by `link-models`). Before this, every such row read
 * MISSING "no bucketPrefix", including rows that load fine, so availability could not tell a real gap.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AiDeploymentKind, AiModelAvailability, AiModelSource, ModelTaskType, SYSTEM_TENANT_ID } from '@arcaai/domains';
import { ModelInventoryService } from '../model-inventory.service';

function row(over: Record<string, unknown> = {}) {
  const state: Record<string, unknown> = {
    id: 'row-1',
    tenantId: SYSTEM_TENANT_ID,
    slug: 'silero-vad',
    source: AiModelSource.HUGGINGFACE,
    sourceUri: 'onnx-community/silero-vad',
    libraryName: 'onnxruntime',
    computeType: 'float32',
    deploymentKind: AiDeploymentKind.SELF_HOSTED,
    bucketPrefix: null,
    manifestDigest: null,
    availability: AiModelAvailability.UNKNOWN,
    version: 1,
    ...over,
  };
  return {
    ...state,
    get isCloud() {
      return state.deploymentKind === AiDeploymentKind.CLOUD;
    },
    markAvailability: vi.fn(),
  } as never as Record<string, unknown> & { markAvailability: ReturnType<typeof vi.fn> };
}

const HF = 'hf/hub/models--';

describe('ModelInventoryService — out-of-band layouts (TASK-1055 FU-3)', () => {
  const s3 = { listFiles: vi.fn(), getFile: vi.fn() };
  const repo = { findAll: vi.fn(), update: vi.fn(async (_id: string, e: unknown) => e) };
  const db = { baseClient: {} };
  let service: ModelInventoryService;

  beforeEach(() => {
    vi.clearAllMocks();
    service = new ModelInventoryService(repo as never, s3 as never, db as never);
  });

  async function verdictFor(r: ReturnType<typeof row>, keys: string[], refsMain: Record<string, string> = {}) {
    s3.listFiles.mockResolvedValue(keys.map((key) => ({ key })));
    s3.getFile.mockImplementation(async (_bucket: string, key: string) => {
      if (key in refsMain) return Buffer.from(refsMain[key]);
      throw new Error(`unexpected read ${key}`);
    });
    repo.findAll.mockResolvedValue([r]);
    const report = await service.runInventory();
    return report.rows[0];
  }

  it('an HF-sourced row present in the HF cache tree is AVAILABLE, with the refs/main revision and the mounted path', async () => {
    const v = await verdictFor(
      row(),
      [`${HF}onnx-community--silero-vad/refs/main`, `${HF}onnx-community--silero-vad/snapshots/abc123/onnx/model.onnx`],
      { [`${HF}onnx-community--silero-vad/refs/main`]: 'abc123\n' },
    );

    expect(v.availability).toBe(AiModelAvailability.AVAILABLE);
    expect(v.detail).toEqual(
      expect.objectContaining({
        layout: 'hf-cache',
        revision: 'abc123',
        path: '/mnt/models-bucket/hf/hub/models--onnx-community--silero-vad/snapshots/abc123',
      }),
    );
  });

  it('an HF-sourced row absent from the HF cache is MISSING and says where it looked', async () => {
    const v = await verdictFor(row(), [`${HF}other--repo/refs/main`, `${HF}other--repo/snapshots/r/x.bin`]);

    expect(v.availability).toBe(AiModelAvailability.MISSING);
    expect(String(v.detail.reason)).toContain('hf/hub/models--onnx-community--silero-vad/refs/main');
  });

  it('refs/main with an EMPTY snapshot tree is MISSING (a name-only offline load would fail)', async () => {
    const v = await verdictFor(row(), [`${HF}onnx-community--silero-vad/refs/main`], {
      [`${HF}onnx-community--silero-vad/refs/main`]: 'abc123',
    });

    expect(v.availability).toBe(AiModelAvailability.MISSING);
  });

  it('a whisper.cpp row declaring q8_0 whose snapshot holds only an f16 file is MISSING, naming the quant and the files seen', async () => {
    const repoDir = `${HF}taphuynh--whisper-turbo-ml-en-codeswitch-fullft-2607.29.1-GGUF`;
    const v = await verdictFor(
      row({
        slug: 'arcaai-whisper-large-ml-en-gguf-q8_0',
        sourceUri: 'taphuynh/whisper-turbo-ml-en-codeswitch-fullft-2607.29.1-GGUF',
        libraryName: 'whisper.cpp',
        computeType: 'q8_0',
      }),
      [`${repoDir}/refs/main`, `${repoDir}/snapshots/r1/ggml-whisper-turbo-ml-en-codeswitch-f16.bin`],
      { [`${repoDir}/refs/main`]: 'r1' },
    );

    expect(v.availability).toBe(AiModelAvailability.MISSING);
    expect(String(v.detail.reason)).toContain('q8_0');
    expect(String(v.detail.reason)).toContain('ggml-whisper-turbo-ml-en-codeswitch-f16.bin');
  });

  it('the same whisper.cpp row is AVAILABLE once a q8_0 file is in the snapshot', async () => {
    const repoDir = `${HF}taphuynh--whisper-turbo-ml-en-codeswitch-fullft-2607.29.1-GGUF`;
    const v = await verdictFor(
      row({
        sourceUri: 'taphuynh/whisper-turbo-ml-en-codeswitch-fullft-2607.29.1-GGUF',
        libraryName: 'whisper.cpp',
        computeType: 'q8_0',
      }),
      [
        `${repoDir}/refs/main`,
        `${repoDir}/snapshots/r1/ggml-whisper-turbo-ml-en-codeswitch-f16.bin`,
        `${repoDir}/snapshots/r1/ggml-whisper-turbo-ml-en-codeswitch-Q8_0.bin`,
      ],
      { [`${repoDir}/refs/main`]: 'r1' },
    );

    expect(v.availability).toBe(AiModelAvailability.AVAILABLE);
    expect(v.detail).toEqual(expect.objectContaining({ layout: 'hf-cache', revision: 'r1' }));
  });

  it('an LM Studio row whose GGUF is on the serving tier is AVAILABLE (gemma-4-e2b-it-qat ↔ gemma-4-e2b-it-qat-gguf/)', async () => {
    const v = await verdictFor(
      row({
        slug: 'lms-gemma-4-e2b-it-qat',
        source: AiModelSource.LOCAL,
        sourceUri: 'gemma-4-e2b-it-qat',
        libraryName: 'llama.cpp',
        servedBy: 'lmstudio',
        provider: 'lm-studio',
        computeType: 'q4_0',
        taskType: ModelTaskType.TEXT_GENERATION,
      }),
      ['gemma-4-e2b-it-qat-gguf/v1/gemma-4-e2b-it-qat-q4_0.gguf', 'gemma-4-e2b-it-qat-gguf/v1/mmproj.gguf'],
    );

    expect(v.availability).toBe(AiModelAvailability.AVAILABLE);
    expect(v.detail).toEqual(expect.objectContaining({ layout: 'gguf-tier', prefix: 'gemma-4-e2b-it-qat-gguf/' }));
  });

  it('an LM Studio embedding row maps through the text-embedding- prefix LM Studio prepends', async () => {
    const v = await verdictFor(
      row({
        source: AiModelSource.LOCAL,
        sourceUri: 'text-embedding-nomic-embed-text-v1.5',
        libraryName: 'llama.cpp',
        provider: 'lm-studio',
        computeType: null,
        taskType: ModelTaskType.FEATURE_EXTRACTION,
      }),
      ['nomic-embed-text-v1.5-gguf/v1/model.gguf'],
    );

    expect(v.availability).toBe(AiModelAvailability.AVAILABLE);
    expect(v.detail).toEqual(expect.objectContaining({ layout: 'gguf-tier', prefix: 'nomic-embed-text-v1.5-gguf/' }));
  });

  it('an LM Studio row whose GGUF is NOT on the serving tier is MISSING (qwen3guard-gen-0.6b)', async () => {
    const v = await verdictFor(
      row({
        slug: 'qwen3guard-gen-0.6b',
        source: AiModelSource.LOCAL,
        sourceUri: 'qwen3guard-gen-0.6b',
        libraryName: 'llama.cpp',
        servedBy: 'lmstudio',
        provider: 'lm-studio',
        computeType: null,
        taskType: ModelTaskType.GUARDRAIL,
      }),
      ['gemma-4-e2b-it-qat-gguf/v1/gemma.gguf'],
    );

    expect(v.availability).toBe(AiModelAvailability.MISSING);
    expect(String(v.detail.reason)).toContain('not on the LM Studio serving tier');
  });

  it('a row WITH a bucketPrefix keeps the manifest path even when an HF-cache copy exists', async () => {
    const v = await verdictFor(row({ bucketPrefix: 'silero-vad/v1/' }), [
      `${HF}onnx-community--silero-vad/refs/main`,
      `${HF}onnx-community--silero-vad/snapshots/abc/model.onnx`,
    ]);

    expect(v.availability).toBe(AiModelAvailability.MISSING);
    expect(String(v.detail.reason)).toContain('manifest.json not found under silero-vad/v1/');
  });
});
