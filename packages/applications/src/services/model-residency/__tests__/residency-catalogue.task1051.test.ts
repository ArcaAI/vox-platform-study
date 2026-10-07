import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  type CatalogueBuildInput,
  type CatalogueFailedEntry,
  type CatalogueModelRow,
  type CatalogueResidentEntry,
  buildResidencyCatalogue,
} from '../residency-catalogue';

/** TASK-1051 lane B2 — identity, kind, budget, device accounting, runsOn, standing suggestions. */

const MiB = 1024 * 1024;
const GiB = 1024 * MiB;

function row(o: Partial<CatalogueModelRow> & { id: string }): CatalogueModelRow {
  return { name: o.id, slug: o.id, sourceUri: `s3://${o.id}`, servedBy: 'stt', format: 'WHISPER_CPP', ...o };
}
function entry(o: Partial<CatalogueResidentEntry>): CatalogueResidentEntry {
  return {
    service: 'stt', instance: 'pod', modelRef: 'x', aiModelId: null, aiModelName: null, device: 'cuda:0', state: 'loaded', bytes: null,
    bytesSource: 'unknown', inFlight: null, requestsPerMin: null, p50LatencyMs: null, loadedAt: null, lastUsedAt: null, loadSeconds: null,
    ttlSeconds: null, adminPinned: false, ...o,
  };
}
const gpu = (id: string, used: number, total = 16 * GiB) => ({
  id, kind: 'gpu' as const, name: 'RTX', totalBytes: total, usedBytes: used, freeBytes: total - used, utilisationPercent: 1,
});
const usage = { get: () => ({ agentCount: 0, tenantCount: 0, liveConsultation: false, uses: [], consumers: { agents: 0, fallbacks: 0, routingPolicies: 0, pipelineStages: 0, workflowNodes: 0 } }) } as never;

function input(o: Partial<CatalogueBuildInput> = {}): CatalogueBuildInput {
  return {
    now: Date.now(), mode: 'shadow', reportedAt: 't', freshness: { maxAgeSeconds: 1, staleServices: [], oldestReportAt: null } as never,
    headroomPercent: 15, devices: [gpu('gpu0', 4 * GiB)], staleServices: [], entries: [], failed: [], loading: [], catalogue: [],
    modelById: () => undefined, usage,
    classify: () => ({ class: 'ON_DEMAND', classSource: 'default', policy: null }),
    observedBytes: () => undefined, observedLoadSeconds: () => null, recommendations: [], ...o,
  };
}
const models = (r: ReturnType<typeof buildResidencyCatalogue>, s: string) => r.services.find((x) => x.service === s)!.models;

describe('identity + F1 matching', () => {
  it('claims an LM Studio entry reported with a quant suffix: one row, loaded, no orphan', () => {
    const m = row({ id: 'g', servedBy: 'lm-studio', provider: 'lm-studio', wireModelId: 'gemma-4-e2b-it-qat' });
    const e = entry({ service: 'lm-studio', modelRef: 'gemma-4-e2b-it-qat@q4_0', device: 'multi' });
    const rows = models(buildResidencyCatalogue(input({ catalogue: [m], entries: [e] })), 'lm-studio');
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe('loaded');
    expect(rows[0].identity).toEqual({ matched: true, runtimeKeys: ['gemma-4-e2b-it-qat'], reportedKey: 'gemma-4-e2b-it-qat@q4_0', candidates: [] });
  });

  it('claims a failure by normalised key too', () => {
    const m = row({ id: 'g', servedBy: 'lm-studio', provider: 'lm-studio', wireModelId: 'gemma' });
    const f: CatalogueFailedEntry = { service: 'lm-studio', modelRef: 'gemma@q4', aiModelId: null, aiModelName: null, error: { code: 'E', message: 'm', at: null } };
    const rows = models(buildResidencyCatalogue(input({ catalogue: [m], failed: [f] })), 'lm-studio');
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe('failed');
  });

  it('unmatched resident row lists ranked candidates', () => {
    const m = row({ id: 'g', servedBy: 'lm-studio', provider: 'lm-studio', wireModelId: 'gemma-4-e2b-it-qat' });
    const e = entry({ service: 'lm-studio', modelRef: 'gemma-4-e4b-it', device: 'multi' });
    const rows = models(buildResidencyCatalogue(input({ catalogue: [m], entries: [e] })), 'lm-studio');
    const orphan = rows.find((r) => r.aiModelId === null)!;
    expect(orphan.identity.matched).toBe(false);
    expect(orphan.identity.runtimeKeys).toEqual([]);
    expect(orphan.identity.reportedKey).toBe('gemma-4-e4b-it');
    expect(orphan.identity.candidates[0]).toMatchObject({ aiModelId: 'g', strength: 'weak' });
  });

  it('a not-loaded catalogue row is matched with no reportedKey', () => {
    const rows = models(buildResidencyCatalogue(input({ catalogue: [row({ id: 'a', slug: 'a' })] })), 'stt');
    expect(rows[0].identity).toEqual({ matched: true, runtimeKeys: ['a'], reportedKey: null, candidates: [] });
  });
});

describe('kind (F3)', () => {
  it('pyrnnoise is builtin', () => {
    const r = models(buildResidencyCatalogue(input({ catalogue: [row({ id: 'dn', libraryName: 'pyrnnoise' })] })), 'stt')[0];
    expect(r).toMatchObject({ kind: 'builtin', status: 'not_loaded', error: null, residency: null, budgetBytes: null, actions: [] });
    expect(r.keepPolicy).toEqual({
      kind: 'on_demand', label: 'Not applicable', reason: 'Built into pyrnnoise — nothing to load', source: 'default', policyId: null, policyVersion: null, idleTtlSeconds: null,
    });
  });
  it('a cloud library is remote, case-insensitively', () => {
    const r = models(buildResidencyCatalogue(input({ catalogue: [row({ id: 's', libraryName: 'Sarvam', memorySizeMb: 100 })] })), 'stt')[0];
    expect(r).toMatchObject({ kind: 'remote', budgetBytes: null, actions: [] });
    expect(r.keepPolicy.reason).toBe('Cloud API — nothing to hold in memory');
  });
  it('CloudASR / ModelNotCacheServedError failures are not "failed"', () => {
    const f = (code: string): CatalogueFailedEntry => ({ service: 'stt', modelRef: 'a', aiModelId: null, aiModelName: null, error: { code, message: 'm', at: null } });
    const a = models(buildResidencyCatalogue(input({ catalogue: [row({ id: 'a', slug: 'a' })], failed: [f('CloudASRUnavailable')] })), 'stt')[0];
    const b = models(buildResidencyCatalogue(input({ catalogue: [row({ id: 'a', slug: 'a' })], failed: [f('ModelNotCacheServedError')] })), 'stt')[0];
    expect(a).toMatchObject({ kind: 'remote', status: 'not_loaded', error: null });
    expect(b).toMatchObject({ kind: 'builtin', status: 'not_loaded', error: null });
  });
  it('an ordinary row is resident', () => {
    expect(models(buildResidencyCatalogue(input({ catalogue: [row({ id: 'a', slug: 'a' })] })), 'stt')[0].kind).toBe('resident');
  });
});

describe('budgetBytes', () => {
  it('catalogue estimate x1.2 when unmeasured, measured as is, null when unknown', () => {
    const r = buildResidencyCatalogue(
      input({
        catalogue: [row({ id: 'a', slug: 'a', memorySizeMb: 1000 }), row({ id: 'b', slug: 'b' }), row({ id: 'c', slug: 'c', memorySizeMb: 5 })],
        observedBytes: (_s, ref) => (ref === 'c' ? 700 * MiB : undefined),
      }),
    );
    const by = Object.fromEntries(models(r, 'stt').map((m) => [m.slug, m.budgetBytes]));
    expect(by).toEqual({ a: Math.ceil(1000 * MiB * 1.2), b: null, c: 700 * MiB });
  });
});

describe('devices (F5)', () => {
  it('splits a multi LM Studio model by usedBytes and does the four numbers', () => {
    const m = row({ id: 'g', servedBy: 'lm-studio', provider: 'lm-studio', wireModelId: 'gemma', memorySizeMb: 1000 });
    const w = row({ id: 'w', slug: 'w' });
    const entries = [
      entry({ service: 'lm-studio', modelRef: 'gemma@q4', device: 'multi' }),
      entry({ service: 'stt', modelRef: 'w', device: 'gpu0', bytes: 2 * GiB, bytesSource: 'measured' }),
    ];
    const r = buildResidencyCatalogue(input({ catalogue: [m, w], entries, devices: [gpu('gpu0', 6 * GiB), gpu('gpu1', 2 * GiB)] }));
    const [d0, d1] = r.devices;
    const share = (d: typeof d0) => d.models.find((x) => x.service === 'lm-studio')!;
    const total = 1000 * MiB;
    expect(share(d0).bytesSource).toBe('estimated');
    expect(share(d0).bytes! + share(d1).bytes!).toBe(total);
    expect(Math.abs(share(d0).bytes! - total * 0.75)).toBeLessThanOrEqual(1);
    expect(d0.models.find((x) => x.service === 'stt')).toMatchObject({ bytes: 2 * GiB, bytesSource: 'measured' });
    expect(d0.headroomBytes).toBe(Math.floor(16 * GiB * 0.15));
    expect(d0.overHeadroom).toBe(false);
    expect(d0.attributedBytes).toBe(2 * GiB + share(d0).bytes!);
    expect(d0.unattributedBytes).toBe(6 * GiB - d0.attributedBytes);
    expect(d1.unattributedBytes).toBe(2 * GiB - share(d1).bytes!);
  });
  it('flags overHeadroom and floors unattributed at 0; unknown bytes stay null', () => {
    const r = buildResidencyCatalogue(
      input({ devices: [gpu('gpu0', 15 * GiB)], entries: [entry({ modelRef: 'zz', device: 'gpu0' })] }),
    );
    expect(r.devices[0].overHeadroom).toBe(true);
    expect(r.devices[0].models[0]).toMatchObject({ bytes: null, bytesSource: 'unknown' });
    expect(r.devices[0].unattributedBytes).toBe(15 * GiB);
  });
  it('a not-measured entry with a catalogue size is estimated', () => {
    const r = buildResidencyCatalogue(
      input({ catalogue: [row({ id: 'a', slug: 'a', memorySizeMb: 100 })], entries: [entry({ modelRef: 'a', device: 'gpu0' })] }),
    );
    expect(r.devices[0].models[0]).toMatchObject({ bytes: 100 * MiB, bytesSource: 'estimated' });
  });
});

describe('runsOn (F6)', () => {
  it('is derived from where entries sit, else the static default', () => {
    const cpuNlp = buildResidencyCatalogue(input({ entries: [entry({ service: 'nlp', modelRef: 'n', device: 'cpu:nlp' })] }));
    expect(cpuNlp.services.find((s) => s.service === 'nlp')!.runsOn).toBe('cpu');
    const gpuNlp = buildResidencyCatalogue(input({ entries: [entry({ service: 'nlp', modelRef: 'n', device: 'cuda:0' })] }));
    expect(gpuNlp.services.find((s) => s.service === 'nlp')!.runsOn).toBe('gpu');
    const cpuStt = buildResidencyCatalogue(input({ entries: [entry({ modelRef: 'n', device: 'cpu' })] }));
    expect(cpuStt.services.find((s) => s.service === 'stt')!.runsOn).toBe('cpu');
    expect(buildResidencyCatalogue(input()).services.find((s) => s.service === 'nlp')!.runsOn).toBe('cpu');
  });
});

describe('suggestions (F4)', () => {
  const rec = (id: string, at: string, o: object = {}) => ({
    id, at, action: 'unload' as const, service: 'nlp', modelRef: 'm', reason: 'idle_ttl_expired' as const, mode: 'shadow' as const, applied: false,
    firstSeenAt: '2026-01-01T00:00:00Z', repeats: 3, ...o,
  });
  it('projects firstSeenAt/repeats/reason and keeps the most recent per key', () => {
    const r = buildResidencyCatalogue(input({ recommendations: [rec('old', '2026-01-02T00:00:00Z'), rec('new', '2026-01-03T00:00:00Z')] }));
    expect(r.suggestions).toHaveLength(1);
    expect(r.suggestions[0]).toMatchObject({ id: 'new', firstSeenAt: '2026-01-01T00:00:00Z', repeats: 3, reason: 'idle_ttl_expired' });
  });
  it('caps at 20', () => {
    const many = Array.from({ length: 30 }, (_, i) => rec(`r${i}`, '2026-01-02T00:00:00Z', { modelRef: `m${i}` }));
    expect(buildResidencyCatalogue(input({ recommendations: many })).suggestions).toHaveLength(20);
  });
});

describe('usage', () => {
  it('EMPTY_USAGE carries zero consumers', () => {
    const u = models(buildResidencyCatalogue(input({ entries: [entry({ modelRef: 'zz' })] })), 'stt')[0].usage;
    expect(u.consumers).toEqual({ agents: 0, fallbacks: 0, routingPolicies: 0, pipelineStages: 0, workflowNodes: 0 });
  });
});

describe('fixture key sets', () => {
  const R = JSON.parse(readFileSync(resolve(__dirname, '../../../../../../tests/contracts/model-residency-catalogue.fixture.json'), 'utf8')).response;
  const keys = (o: object) => Object.keys(o).sort();
  it('devices, device models, models, identity and suggestions carry exactly the fixture keys', () => {
    const m = row({ id: 'a', slug: 'a', memorySizeMb: 10 });
    const out = buildResidencyCatalogue(
      input({
        catalogue: [m],
        entries: [entry({ modelRef: 'a', device: 'gpu0', bytes: 1, bytesSource: 'measured' })],
        recommendations: [{ id: 'i', at: '2026-01-01T00:00:00Z', action: 'unload', service: 'nlp', modelRef: 'x', reason: 'idle_ttl_expired', mode: 'shadow', applied: false }],
      }),
    );
    expect(keys(out.devices[0])).toEqual(keys(R.devices[0]));
    expect(keys(out.devices[0].models[0])).toEqual(keys(R.devices[0].models[0]));
    const model = models(out, 'stt')[0];
    expect(keys(model)).toEqual(keys(R.services[0].models[0]));
    expect(keys(model.identity)).toEqual(keys(R.services[0].models[0].identity));
    expect(keys(model.usage)).toEqual(keys(R.services[0].models[0].usage));
    expect(keys(out.suggestions[0])).toEqual(keys(R.suggestions[0]));
  });
});
