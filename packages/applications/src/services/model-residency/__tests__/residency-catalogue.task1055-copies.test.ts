import { describe, expect, it } from 'vitest';
import { type CatalogueBuildInput, type CatalogueModelRow, type CatalogueResidentEntry, buildResidencyCatalogue } from '../residency-catalogue';

/**
 * TASK-1055 §8b D4 — an stt / nlp model held as SEPARATE copies on several devices (Medical NER on
 * GPU 0 and GPU 1). The catalogue row lists every copy in `residency.deviceBytes` (so the console
 * offers "All copies / Only GPU N"), `residency.device` stays the first copy, and each device's
 * `models[]` carries the copy it holds with that copy's bytes.
 */

const MiB = 1024 * 1024;
const GiB = 1024 * MiB;

const ner: CatalogueModelRow = { id: 'ner', name: 'Medical NER', slug: 'medical-ner', sourceUri: 's3://models/medical-ner', servedBy: 'nlp', format: 'GLINER' };

function copy(o: Partial<CatalogueResidentEntry>): CatalogueResidentEntry {
  return {
    service: 'nlp', instance: 'hope-nlp-0', modelRef: 's3://models/medical-ner', aiModelId: 'ner', aiModelName: 'Medical NER', device: 'gpu0',
    state: 'loaded', bytes: 736 * MiB, bytesSource: 'measured', inFlight: 0, requestsPerMin: null, p50LatencyMs: null, loadedAt: null,
    lastUsedAt: null, loadSeconds: 6, ttlSeconds: null, adminPinned: false, ...o,
  };
}
const gpu = (id: string, used: number, total = 16 * GiB) => ({
  id, kind: 'gpu' as const, name: 'RTX', totalBytes: total, usedBytes: used, freeBytes: total - used, utilisationPercent: 1,
});
const usage = { get: () => ({ agentCount: 0, tenantCount: 0, liveConsultation: false, uses: [], consumers: { agents: 0, fallbacks: 0, routingPolicies: 0, pipelineStages: 0, workflowNodes: 0 } }) } as never;

function input(o: Partial<CatalogueBuildInput> = {}): CatalogueBuildInput {
  return {
    now: Date.now(), mode: 'shadow', reportedAt: 't', freshness: { maxAgeSeconds: 1, staleServices: [], oldestReportAt: null } as never,
    headroomPercent: 15, devices: [gpu('gpu0', 7 * GiB), gpu('gpu1', 3 * GiB)], staleServices: [], entries: [], failed: [], loading: [],
    catalogue: [ner], modelById: () => undefined, usage,
    classify: () => ({ class: 'ON_DEMAND', classSource: 'default', policy: null }),
    observedBytes: () => undefined, observedLoadSeconds: () => null, recommendations: [], ...o,
  };
}
const nlpRow = (r: ReturnType<typeof buildResidencyCatalogue>) => r.services.find((s) => s.service === 'nlp')!.models.find((m) => m.aiModelId === 'ner')!;
const deviceModels = (r: ReturnType<typeof buildResidencyCatalogue>, id: string) => r.devices.find((d) => d.id === id)!.models;

describe('D4 — one model, separate copies on two GPUs', () => {
  const entries = [copy({ device: 'gpu0', bytes: 736 * MiB }), copy({ device: 'gpu1', bytes: 737 * MiB })];

  it('residency.deviceBytes lists each copy (gpuN + its bytes); device = the first copy; bytes = all copies', () => {
    const row = nlpRow(buildResidencyCatalogue(input({ entries })));
    expect(row.status).toBe('loaded');
    expect(row.residency).toMatchObject({ device: 'gpu0', bytes: 1473 * MiB, bytesSource: 'measured' });
    expect(row.residency!.deviceBytes).toEqual([
      { device: 'gpu0', bytes: 736 * MiB },
      { device: 'gpu1', bytes: 737 * MiB },
    ]);
  });

  it('copies reported second-card first still list in device order; device stays the first REPORTED copy', () => {
    const row = nlpRow(buildResidencyCatalogue(input({ entries: [entries[1], entries[0]] })));
    expect(row.residency!.device).toBe('gpu1');
    expect(row.residency!.deviceBytes!.map((d) => d.device)).toEqual(['gpu0', 'gpu1']);
  });

  it('each device lists the copy it holds with that copy`s bytes; the unattributed formula is unchanged', () => {
    const r = buildResidencyCatalogue(input({ entries }));
    expect(deviceModels(r, 'gpu0')).toEqual([{ service: 'nlp', modelRef: 's3://models/medical-ner', name: 'Medical NER', bytes: 736 * MiB, bytesSource: 'measured' }]);
    expect(deviceModels(r, 'gpu1')).toEqual([{ service: 'nlp', modelRef: 's3://models/medical-ner', name: 'Medical NER', bytes: 737 * MiB, bytesSource: 'measured' }]);
    const gpu0 = r.devices.find((d) => d.id === 'gpu0')!;
    expect(gpu0.unattributedBytes).toBe(7 * GiB - 736 * MiB);
  });

  it('a copy the service reports no size for is listed with its estimated footprint', () => {
    const row = nlpRow(
      buildResidencyCatalogue(
        input({
          catalogue: [{ ...ner, memorySizeMb: 700 }],
          entries: [entries[0], copy({ device: 'gpu1', bytes: null, bytesSource: 'unknown' })],
        }),
      ),
    );
    expect(row.residency!.deviceBytes).toEqual([
      { device: 'gpu0', bytes: 736 * MiB },
      { device: 'gpu1', bytes: 700 * MiB },
    ]);
  });

  it('a host-memory copy beside a GPU copy is listed under its pool id', () => {
    const cpu = { id: 'cpu:nlp', kind: 'cpu' as const, name: 'nlp host memory', totalBytes: 32 * GiB, usedBytes: 4 * GiB, freeBytes: 28 * GiB, utilisationPercent: null };
    const r = buildResidencyCatalogue(input({ devices: [gpu('gpu0', 7 * GiB), cpu], entries: [entries[0], copy({ device: 'cpu:nlp', bytes: 800 * MiB })] }));
    expect(nlpRow(r).residency!.deviceBytes).toEqual([
      { device: 'cpu:nlp', bytes: 800 * MiB },
      { device: 'gpu0', bytes: 736 * MiB },
    ]);
    expect(deviceModels(r, 'cpu:nlp')).toEqual([{ service: 'nlp', modelRef: 's3://models/medical-ner', name: 'Medical NER', bytes: 800 * MiB, bytesSource: 'measured' }]);
  });
});

describe('D4 — unchanged shapes', () => {
  it('one copy with no per-card bytes: no deviceBytes key', () => {
    const row = nlpRow(buildResidencyCatalogue(input({ entries: [copy({ device: 'gpu0' })] })));
    expect(row.residency!.device).toBe('gpu0');
    expect('deviceBytes' in row.residency!).toBe(false);
  });

  it('one LM Studio split instance keeps the per-card bytes it reported', () => {
    const granite: CatalogueModelRow = { id: 'g', name: 'Granite', slug: 'g', sourceUri: 's3://g', servedBy: 'lm-studio', provider: 'lm-studio', wireModelId: 'granite', format: 'GGUF' };
    const split = copy({
      service: 'lm-studio', modelRef: 'granite', aiModelId: 'g', device: 'multi', bytes: 6 * GiB,
      deviceBytes: [{ device: 'gpu0', bytes: 2 * GiB }, { device: 'gpu1', bytes: 4 * GiB }],
    });
    const r = buildResidencyCatalogue(input({ catalogue: [granite], entries: [split] }));
    const row = r.services.find((s) => s.service === 'lm-studio')!.models[0];
    expect(row.residency).toMatchObject({ device: 'multi', deviceBytes: [{ device: 'gpu0', bytes: 2 * GiB }, { device: 'gpu1', bytes: 4 * GiB }] });
  });
});
