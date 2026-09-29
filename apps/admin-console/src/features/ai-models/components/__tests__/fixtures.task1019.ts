/** Shared fixtures for the TASK-1019 console tests (a URL-branching fetch stub + registry rows carrying a lifecycle). */

import { vi } from 'vitest';
import type { AiModel, HubPreview, ModelLifecycle, ModelLifecycleStatus, PaginatedModels } from '../../api/types';

export const BASE_MODEL: AiModel = {
  id: 'm-1',
  name: 'Whisper ML-EN',
  slug: 'whisper-ml-en',
  description: null,
  category: 'AUDIO',
  taskType: 'AUTOMATIC_SPEECH_RECOGNITION',
  pipelineTag: 'automatic-speech-recognition',
  modelType: 'QUANTIZED_MODEL',
  source: 'HUGGINGFACE',
  sourceUri: 'org/whisper-ml-en',
  sourceRevision: 'main',
  format: 'WHISPER_CPP',
  libraryName: 'whisper.cpp',
  servedBy: 'stt',
  deploymentKind: 'SELF_HOSTED',
  wireModelId: null,
  license: 'mit',
  gated: false,
  baseModel: null,
  languages: ['en'],
  hfRevision: 'abc123',
  bucketPrefix: 'whisper-ml-en/f16-0123456789ab/',
  primaryObject: 'ggml-model-f16.bin',
  manifestDigest: null,
  availability: 'AVAILABLE',
  availabilityCheckedAt: '2026-09-04T09:00:00.000Z',
  availabilityDetail: null,
  isPlatformDefaultFor: [],
  provider: 'built-in',
  architecture: 'whisper',
  memorySizeMb: 1700,
  computeType: 'f16',
  localPath: '/mnt/models-bucket/whisper-ml-en/f16-0123456789ab/ggml-model-f16.bin',
  checksum: null,
  resourceStatus: 'ENABLED',
  version: 4,
  tags: [],
  tenantId: '00000000-0000-0000-0000-000000000000',
  createdAt: '2026-06-01T00:00:00.000Z',
  updatedAt: '2026-07-01T00:00:00.000Z',
  createdBy: null,
  updatedBy: null,
};

export function lifecycle(status: ModelLifecycleStatus, patch: Partial<ModelLifecycle> = {}): ModelLifecycle {
  return { status, services: [], download: null, unregister: null, observedAt: '2026-09-29T10:00:00.000Z', ...patch };
}

export function modelWith(id: string, name: string, status: ModelLifecycleStatus, patch: Partial<AiModel> = {}, lc: Partial<ModelLifecycle> = {}): AiModel {
  return { ...BASE_MODEL, id, name, slug: id, lifecycle: lifecycle(status, lc), ...patch };
}

export const PREVIEW: HubPreview = {
  repoId: 'org/whisper-ml-en',
  revision: 'main',
  commitSha: '0123456789abcdef0123456789abcdef01234567',
  taskType: 'AUTOMATIC_SPEECH_RECOGNITION',
  libraryName: 'whisper.cpp',
  license: 'apache-2.0',
  gated: true,
  languages: ['ml', 'en'],
  baseModel: 'openai/whisper-large-v3',
  totalBytes: 3 * 1024 ** 3,
  fileCount: 4,
  suggestedSlug: 'whisper-ml-en-hf',
  suggestedName: 'Whisper ML-EN (HF)',
  suggestedFormat: 'WHISPER_CPP',
  layout: 'flat',
};

export function envelope(models: AiModel[]): PaginatedModels {
  return { data: models, total: models.length, page: 0, limit: 25, totalPages: models.length ? 1 : 0 };
}

export interface RecordedCall {
  url: string;
  method: string;
  body: unknown;
}

export function stubFetch(handler: (url: string, method: string) => Response | Promise<Response>): RecordedCall[] {
  const calls: RecordedCall[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? 'GET';
      calls.push({ url, method, body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined });
      return handler(url, method);
    }),
  );
  return calls;
}
