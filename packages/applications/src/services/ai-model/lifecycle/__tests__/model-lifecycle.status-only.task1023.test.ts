/**
 * The tenant-visible registry view derives each row's one-word status through
 * the UNGATED status-only residency read — never the platform-gated catalogue.
 */
import { describe, expect, it, vi } from 'vitest';
import { AiDeploymentKind, AiModelAvailability } from '@arcaai/domains';
import { ModelLifecycleService } from '../model-lifecycle.service';
import type { LifecycleRow } from '../model-lifecycle.derive';

const NOW = Date.parse('2026-09-30T12:00:00Z');

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

function snapshot(models: Array<{ service: string; aiModelId: string | null; slug: string | null; state: string }>) {
  return {
    reportedAt: '2026-09-30T11:59:58Z',
    services: ['stt', 'nlp'].map((service) => ({ service, models: models.filter((m) => m.service === service).map(({ service: _s, ...m }) => m) })),
  };
}

describe('ModelLifecycleService.statusForRows', () => {
  it('a model loaded on a service → SERVING, read through getLifecycleStates, never getCatalogue', async () => {
    const getCatalogue = vi.fn();
    const getLifecycleStates = vi.fn(async () => snapshot([{ service: 'nlp', aiModelId: 'm-1', slug: 'medical-ner', state: 'loaded' }]));
    const svc = new ModelLifecycleService({ getCatalogue, getLifecycleStates } as never);

    const out = await svc.statusForRows([row(), row({ id: 'm-2', slug: 'other' })], NOW);

    expect(out.get('m-1')).toBe('SERVING');
    expect(out.get('m-2')).toBe('DOWNLOADED');
    expect(getCatalogue).not.toHaveBeenCalled();
    expect(getLifecycleStates).toHaveBeenCalledTimes(1);
  });

  it('matches by slug when the service reports no aiModelId', async () => {
    const getLifecycleStates = vi.fn(async () => snapshot([{ service: 'nlp', aiModelId: null, slug: 'medical-ner', state: 'loading' }]));
    const svc = new ModelLifecycleService({ getLifecycleStates } as never);
    expect((await svc.statusForRows([row()], NOW)).get('m-1')).toBe('LOADING');
  });

  it('a residency failure never fails the list — registry facts alone', async () => {
    const svc = new ModelLifecycleService({ getLifecycleStates: vi.fn().mockRejectedValue(new Error('agents down')) } as never);
    expect((await svc.statusForRows([row()], NOW)).get('m-1')).toBe('DOWNLOADED');
  });

  it('cloud rows need no residency read', async () => {
    const getLifecycleStates = vi.fn();
    const svc = new ModelLifecycleService({ getLifecycleStates } as never);
    const out = await svc.statusForRows([row({ deploymentKind: AiDeploymentKind.CLOUD })], NOW);
    expect(getLifecycleStates).not.toHaveBeenCalled();
    expect(out.get('m-1')).toBe('NOT_APPLICABLE');
  });
});
