/**
 * TASK-1019 R6 — one lifecycle status per registry row (D-9), every branch.
 *
 * `derivePublishStatus` is spied through (the real util runs, stale rule included) so
 * the tests can also prove the OPTIONS reach it.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AiDeploymentKind, AiModelAvailability } from '@arcaai/domains';

vi.mock('../../publish/model-download-meta.util', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../publish/model-download-meta.util')>();
  return { ...actual, derivePublishStatus: vi.fn(actual.derivePublishStatus) };
});

import { derivePublishStatus } from '../../publish/model-download-meta.util';
import { deriveModelLifecycle, indexResidencyCatalogue, type LifecycleRow } from '../model-lifecycle.derive';
import { ModelLifecycleService } from '../model-lifecycle.service';

const NOW = Date.parse('2026-09-29T10:00:00.000Z');
const OPTS = { now: NOW, staleAfterMs: 300_000 };

function row(over: Partial<LifecycleRow> = {}): LifecycleRow {
  return {
    id: 'm-1',
    slug: 'medical-ner',
    metaData: null,
    availability: AiModelAvailability.AVAILABLE,
    deploymentKind: AiDeploymentKind.SELF_HOSTED,
    servedBy: 'nlp',
    provider: 'built-in',
    ...over,
  };
}

function catalogue(models: Array<{ service: string; aiModelId?: string | null; slug?: string; status: string; error?: unknown }>) {
  const services = ['stt', 'stt-worker', 'lm-studio', 'nlp'].map((service) => ({
    service,
    models: models
      .filter((m) => m.service === service)
      .map((m) => ({
        aiModelId: m.aiModelId === undefined ? 'm-1' : m.aiModelId,
        slug: m.slug ?? 'medical-ner',
        status: m.status,
        residency: m.status === 'loaded' ? { device: 'gpu0', bytes: 1024, inFlight: 2, requestsPerMin: 7 } : null,
        ...(m.error ? { error: m.error } : {}),
      })),
  }));
  return { reportedAt: '2026-09-29T09:59:30.000Z', services } as never;
}

const idx = (models: Parameters<typeof catalogue>[0]) => indexResidencyCatalogue(catalogue(models));

describe('deriveModelLifecycle — D-9 table', () => {
  beforeEach(() => vi.mocked(derivePublishStatus).mockClear());

  it('UNREGISTERING wins over everything while the unregister job is open', () => {
    const lc = deriveModelLifecycle(
      row({
        metaData: {
          unregister: {
            jobId: 'j',
            // TASK-1023 OD-6: inside the stale window — an older open unregister is UNREGISTER_FAILED.
            startedAt: '2026-09-29T09:58:00Z',
            deleteWeights: true,
            purge: false,
            finishedAt: null,
            error: null,
            weights: 'deleting',
          },
          download: { jobId: 'd', startedAt: '2026-09-29T09:59:00Z', finishedAt: null, error: null },
        },
      }),
      idx([{ service: 'nlp', status: 'loaded' }]),
      OPTS,
    );
    expect(lc.status).toBe('UNREGISTERING');
    expect(lc.unregister).toEqual({ weights: 'deleting', error: null });
  });

  it('a failed unregister no longer reads UNREGISTERING', () => {
    const lc = deriveModelLifecycle(
      row({ metaData: { unregister: { jobId: 'j', startedAt: '2026-09-29T09:00:00Z', finishedAt: null, error: 'boom', weights: 'deleting' } } }),
      null,
      OPTS,
    );
    expect(lc.status).toBe('DOWNLOADED');
    expect(lc.unregister).toEqual({ weights: 'deleting', error: 'boom' });
  });

  it('DOWNLOADING carries the progress bytes', () => {
    const lc = deriveModelLifecycle(
      row({
        availability: AiModelAvailability.MISSING,
        metaData: {
          download: {
            jobId: 'd',
            startedAt: '2026-09-29T09:59:00Z',
            finishedAt: null,
            error: null,
            bytesDone: 10,
            bytesTotal: 40,
            heartbeatAt: '2026-09-29T09:59:50Z',
          },
        },
      }),
      null,
      OPTS,
    );
    expect(lc.status).toBe('DOWNLOADING');
    expect(lc.download).toEqual({ bytesDone: 10, bytesTotal: 40, error: null });
  });

  it('DOWNLOAD_FAILED carries the recorded error', () => {
    const lc = deriveModelLifecycle(
      row({ metaData: { download: { jobId: 'd', startedAt: '2026-09-29T09:00:00Z', finishedAt: '2026-09-29T09:01:00Z', error: 'HTTP 404' } } }),
      null,
      OPTS,
    );
    expect(lc.status).toBe('DOWNLOAD_FAILED');
    expect(lc.download?.error).toBe('HTTP 404');
  });

  it('a stale heartbeat derives DOWNLOAD_FAILED / STALLED — the stale options reach derivePublishStatus', () => {
    const lc = deriveModelLifecycle(
      row({
        availability: AiModelAvailability.MISSING,
        metaData: { download: { jobId: 'd', startedAt: '2026-09-29T09:00:00Z', finishedAt: null, error: null, heartbeatAt: '2026-09-29T09:01:00Z' } },
      }),
      null,
      OPTS,
    );
    expect(derivePublishStatus).toHaveBeenCalledWith(expect.objectContaining({ jobId: 'd' }), AiModelAvailability.MISSING, {
      now: new Date(NOW),
      staleAfterMs: 300_000,
    });
    expect(lc.status).toBe('DOWNLOAD_FAILED');
    expect(lc.download?.error).toBe('STALLED');
  });

  it('a cloud row is NOT_APPLICABLE', () => {
    expect(deriveModelLifecycle(row({ deploymentKind: AiDeploymentKind.CLOUD, availability: AiModelAvailability.MISSING }), null, OPTS).status).toBe(
      'NOT_APPLICABLE',
    );
  });

  it('NOT_DOWNLOADED when the bucket lacks the weights and no service holds them', () => {
    const lc = deriveModelLifecycle(row({ availability: AiModelAvailability.MISSING }), idx([{ service: 'nlp', status: 'not_loaded' }]), OPTS);
    expect(lc.status).toBe('NOT_DOWNLOADED');
  });

  it('LOAD_FAILED carries the per-service error', () => {
    const error = { code: 'CUDA_OOM', message: 'out of memory', at: '2026-09-29T09:58:00Z' };
    const lc = deriveModelLifecycle(row(), idx([{ service: 'nlp', status: 'failed', error }]), OPTS);
    expect(lc.status).toBe('LOAD_FAILED');
    expect(lc.services).toEqual([expect.objectContaining({ service: 'nlp', state: 'failed', error })]);
  });

  it('LOADING while any service is loading', () => {
    expect(deriveModelLifecycle(row(), idx([{ service: 'nlp', status: 'loading' }]), OPTS).status).toBe('LOADING');
  });

  it('SERVING when resident on at least one observed service — even with MISSING bucket availability', () => {
    const lc = deriveModelLifecycle(
      row({ availability: AiModelAvailability.MISSING }),
      idx([
        { service: 'stt', status: 'loaded' },
        { service: 'stt-worker', status: 'not_loaded' },
      ]),
      OPTS,
    );
    expect(lc.status).toBe('SERVING');
    expect(lc.services).toEqual([
      { service: 'stt', state: 'loaded', device: 'gpu0', bytes: 1024, inFlight: 2, requestsPerMin: 7, error: null },
      { service: 'stt-worker', state: 'not_loaded', device: null, bytes: null, inFlight: null, requestsPerMin: null, error: null },
    ]);
    expect(lc.observedAt).toBe('2026-09-29T09:59:30.000Z');
  });

  it('matches the catalogue by slug when the entry carries no aiModelId', () => {
    expect(deriveModelLifecycle(row(), idx([{ service: 'nlp', status: 'loaded', aiModelId: null }]), OPTS).status).toBe('SERVING');
  });

  it('DOWNLOADED when idle on an observed service', () => {
    expect(deriveModelLifecycle(row(), idx([{ service: 'nlp', status: 'not_loaded' }]), OPTS).status).toBe('DOWNLOADED');
  });

  it('NOT_OBSERVED for a vLLM-served row (outside the residency ledger)', () => {
    const lc = deriveModelLifecycle(row({ servedBy: 'vllm', slug: 'whisper-vllm', id: 'm-9' }), idx([]), OPTS);
    expect(lc.status).toBe('NOT_OBSERVED');
    expect(lc.services).toEqual([]);
  });

  it('a tts-served row is OBSERVED since TASK-1055 wave 3 put tts under residency control', () => {
    expect(deriveModelLifecycle(row({ servedBy: 'tts', slug: 'kokoro', id: 'm-9' }), idx([]), OPTS).status).toBe('DOWNLOADED');
  });

  it('with no residency view the row still gets a status, observedAt null', () => {
    const lc = deriveModelLifecycle(row(), null, OPTS);
    expect(lc).toEqual({ status: 'DOWNLOADED', services: [], download: null, unregister: null, observedAt: null });
  });
});

describe('ModelLifecycleService.forRows', () => {
  it('reads the residency catalogue ONCE per call and passes the stale option from the descriptor', async () => {
    const getCatalogue = vi.fn().mockResolvedValue(catalogue([{ service: 'nlp', status: 'loaded' }]));
    const settings = {
      getValueWithDefault: vi.fn((key: string, fallback: unknown) => (key === 'modelRegistry.download.staleAfterSeconds' ? 60 : fallback)),
    };
    const svc = new ModelLifecycleService({ getCatalogue } as never, settings as never);
    vi.mocked(derivePublishStatus).mockClear();

    const out = await svc.forRows([row(), row({ id: 'm-2', slug: 'other' })], NOW);

    expect(getCatalogue).toHaveBeenCalledTimes(1);
    expect(out.get('m-1')?.status).toBe('SERVING');
    expect(out.get('m-2')?.status).toBe('DOWNLOADED');
    // 60 s is lifted to the effective window (final review I10a): 30·2^(3−1)+60 = 180 s at the default 3 attempts.
    expect(derivePublishStatus).toHaveBeenCalledWith(null, AiModelAvailability.AVAILABLE, { now: new Date(NOW), staleAfterMs: 180_000 });
  });

  it('a catalogue failure does not fail the list — registry-only status, observedAt null', async () => {
    const svc = new ModelLifecycleService({ getCatalogue: vi.fn().mockRejectedValue(new Error('403 working tenant')) } as never);
    const out = await svc.forRows([row()], NOW);
    expect(out.get('m-1')).toEqual({ status: 'DOWNLOADED', services: [], download: null, unregister: null, observedAt: null });
  });

  it('never reads the catalogue for rows that cannot use it (cloud)', async () => {
    const getCatalogue = vi.fn();
    const svc = new ModelLifecycleService({ getCatalogue } as never);
    const out = await svc.forRows([row({ deploymentKind: AiDeploymentKind.CLOUD })], NOW);
    expect(getCatalogue).not.toHaveBeenCalled();
    expect(out.get('m-1')?.status).toBe('NOT_APPLICABLE');
  });
});
