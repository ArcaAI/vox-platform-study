import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { SYSTEM_TENANT_ID } from '@arcaai/domains';
import { describe, expect, it, vi } from 'vitest';
import { ModelResidencyService } from '../model-residency.service';
import { confirmationsStub } from './confirmations.stub';

/**
 * TASK-1060 lane G — the catalogue's `cpu` block: host RAM / CPU for the node, segmented by
 * service, with the models resident on each service's host-memory pool. DISPLAY ONLY: nothing
 * here may change a load, a placement or a refusal.
 *
 * Two sources: Prometheus (node-exporter + cAdvisor + kube-state-metrics) when the gateway knows
 * its namespace (`POD_NAMESPACE`) and the node series answer; otherwise the agents' own `cpu`
 * device and per-process RSS.
 */

const FIXTURE_CPU = JSON.parse(readFileSync(resolve(__dirname, '../../../../../../tests/contracts/model-residency-catalogue.fixture.json'), 'utf8'))
  .response.cpu;
const MiB = 1024 * 1024;
const GiB = 1024 * MiB;
const NS = 'hope-v2-dev';
const NER = 'blaze999/Medical-NER';
const GLIGUARD = 'fastino/gliguard-LLMGuardrails-300M';

type Row = Record<string, unknown>;
type Sample = { metric: Record<string, string>; value: number };

const sample = (value: number, metric: Record<string, string> = {}): Sample => ({ metric, value });
const perPod = (values: Record<string, number>): Sample[] => Object.entries(values).map(([pod, value]) => sample(value, { pod }));

function agentModel(overrides: Row = {}): Row {
  return {
    modelRef: NER,
    aiModelId: null,
    cache: 'nlp_token_classifier',
    state: 'loaded',
    device: 'cpu',
    bytes: 1_200 * MiB,
    bytesSource: 'measured',
    inFlight: 0,
    pinned: false,
    adminPinned: false,
    ttlSeconds: 900,
    loadedAt: new Date(Date.now() - 3_600_000).toISOString(),
    lastUsedAt: new Date(Date.now() - 60_000).toISOString(),
    loadSeconds: 2.1,
    ...overrides,
  };
}

function aiModel(overrides: Row): Row {
  return {
    tenantId: SYSTEM_TENANT_ID,
    servedBy: 'nlp',
    observedMemoryMb: null,
    observedLoadSeconds: null,
    memorySizeMb: 1_000,
    resourceStatus: 'ENABLED',
    name: 'model',
    format: 'SAFETENSORS',
    version: 3,
    metaData: {},
    ...overrides,
  };
}

/** The Prometheus series the cluster answers (verified live 2026-10-10, ticket §2), in bytes / cores. */
function clusterSeries() {
  return {
    memTotal: [sample(64 * GiB)],
    memAvailable: [sample(6 * GiB)],
    cpuUtil: [sample(37.5)],
    cpuCores: [sample(48)],
    podMemory: perPod({
      'hope-stt-675557d78c-qqgzt': 2 * GiB,
      'hope-stt-worker-6db7759cf6-5cn96': 3 * GiB,
      'hope-nlp-7c9f8d6b5d-abcde': 5 * GiB,
      'hope-lmstudio-5b8c7d9f6-lm001': 10 * GiB,
      'hope-api-5d4f7b9c8-xyz12': 1 * GiB,
      // a StatefulSet pod in the namespace: not a residency workload, so it is part of `other`
      'hope-postgres-0': 4 * GiB,
    }),
    allMemory: [sample(40 * GiB)],
    podCpu: perPod({
      'hope-stt-675557d78c-qqgzt': 0.5,
      'hope-stt-worker-6db7759cf6-5cn96': 1.25,
      'hope-nlp-7c9f8d6b5d-abcde': 0.25,
      'hope-lmstudio-5b8c7d9f6-lm001': 0.135,
      'hope-api-5d4f7b9c8-xyz12': 0.021,
    }),
    podCpuRequests: perPod({ 'hope-stt-675557d78c-qqgzt': 1, 'hope-stt-worker-6db7759cf6-5cn96': 2, 'hope-nlp-7c9f8d6b5d-abcde': 1 }),
    podCpuLimits: perPod({ 'hope-stt-675557d78c-qqgzt': 4, 'hope-stt-worker-6db7759cf6-5cn96': 6, 'hope-nlp-7c9f8d6b5d-abcde': 2 }),
    podMemoryLimits: perPod({
      'hope-stt-675557d78c-qqgzt': 8 * GiB,
      'hope-stt-worker-6db7759cf6-5cn96': 12 * GiB,
      'hope-nlp-7c9f8d6b5d-abcde': 6 * GiB,
    }),
  };
}

function build(opts: { namespace?: string } = {}) {
  const state = {
    series: clusterSeries() as ReturnType<typeof clusterSeries> | null,
    prometheusDown: false,
    reports: {
      stt: { devices: [{ id: 'cpu', kind: 'cpu', totalBytes: 64 * GiB, freeBytes: 20 * GiB, processBytes: 2.5 * GiB }], models: [] as Row[] },
      nlp: {
        devices: [{ id: 'cpu', kind: 'cpu', totalBytes: 64 * GiB, freeBytes: 20 * GiB, processBytes: 3 * GiB }],
        models: [agentModel(), agentModel({ modelRef: GLIGUARD, cache: 'nlp_gliner2_guard', bytes: null, bytesSource: 'unknown' })] as Row[],
      },
      tts: { devices: [{ id: 'cpu', kind: 'cpu', totalBytes: 64 * GiB, freeBytes: 20 * GiB, processBytes: 0.5 * GiB }], models: [] as Row[] },
    } as Record<string, { devices: Row[]; models: Row[] }>,
    catalogue: [
      aiModel({ id: 'model-ner', slug: 'medical-ner', sourceUri: NER, name: 'Medical NER', taskType: 'TOKEN_CLASSIFICATION' }),
      aiModel({ id: 'model-gliguard', slug: 'gliguard', sourceUri: GLIGUARD, name: 'GLiGuard', observedMemoryMb: 1_136 }),
    ] as Row[],
    settings: {} as Record<string, unknown>,
  };

  const queries: string[] = [];
  const prometheus = {
    instantVector: vi.fn(async (query: string) => {
      queries.push(query);
      if (state.prometheusDown) throw new Error('prometheus: connect ECONNREFUSED');
      const s = state.series;
      if (!s) return [];
      if (query.includes('MemTotal')) return s.memTotal;
      if (query.includes('MemAvailable')) return s.memAvailable;
      if (query.includes('mode="idle"')) return s.cpuUtil;
      if (query.includes('count by (cpu)')) return s.cpuCores;
      if (query.includes('container_memory_working_set_bytes')) return query.includes('namespace=') ? s.podMemory : s.allMemory;
      if (query.includes('container_cpu_usage_seconds_total')) return s.podCpu;
      if (query.includes('resource_requests') && query.includes('resource="cpu"')) return s.podCpuRequests;
      if (query.includes('resource_limits') && query.includes('resource="cpu"')) return s.podCpuLimits;
      if (query.includes('resource_limits') && query.includes('resource="memory"')) return s.podMemoryLimits;
      return [];
    }),
  };
  const agents = {
    report: vi.fn(async (service: string) => {
      const report = state.reports[service];
      if (!report) throw Object.assign(new Error(`${service} down`), { code: 'SERVICE_UNREACHABLE' });
      return { service, instance: `hope-${service}-pod`, reportedAt: new Date().toISOString(), ...report };
    }),
    load: vi.fn(),
    unload: vi.fn(),
    setPolicy: vi.fn(),
  };
  const effectiveSettings = {
    resolveEffective: vi.fn(async (key: string) => (key in state.settings ? { key, value: state.settings[key], sourceScope: 'system' } : null)),
  };
  const config = { getConfigValue: vi.fn((key: string) => (key === 'POD_NAMESPACE' ? opts.namespace : undefined)) };

  const service = new ModelResidencyService(
    { findAll: vi.fn(async () => []) } as never,
    { findAll: vi.fn(async () => state.catalogue), findById: vi.fn(async (id: string) => state.catalogue.find((m) => m.id === id)) } as never,
    agents as never,
    prometheus as never,
    effectiveSettings as never,
    { read: vi.fn(async () => []), status: vi.fn(() => ({ at: Date.now(), error: null, liveAssignments: 0, consumers: 0 })) } as never,
    { build: vi.fn(async (_s: string, modelRef: string) => ({ cache: 'nlp_gliner2_guard', model_path: `/models/${modelRef}` })) } as never,
    { read: vi.fn(async () => ({ get: () => undefined })) } as never,
    { emit: vi.fn() } as never,
    { get: vi.fn((key: string) => (key === 'user' ? { id: 'admin-1', roles: ['SUPER_ADMIN'] } : undefined)) } as never,
    confirmationsStub(),
    config as never,
  );
  return { service, state, queries, prometheus, effectiveSettings };
}

describe('TASK-1060 — the catalogue`s CPU summary (lane G)', () => {
  it('1. Prometheus samples become the node card: RAM used of total, free, CPU %, cores', async () => {
    const h = build({ namespace: NS });
    const { cpu } = await h.service.getCatalogue();

    expect(cpu?.source).toBe('prometheus');
    expect(cpu?.node).toEqual({
      label: 'Node — 48 vCPU',
      totalBytes: 64 * GiB,
      usedBytes: 58 * GiB,
      freeBytes: 6 * GiB,
      headroomPercent: 15,
      headroomBytes: Math.floor((64 * GiB * 15) / 100),
      overHeadroom: true,
      cpuCores: 48,
      utilisationPercent: 37.5,
    });
    // the namespace scopes the per-pod series; the node series are node-wide
    expect(h.queries.filter((q) => q.includes('container_cpu_usage_seconds_total')).every((q) => q.includes(`namespace="${NS}"`))).toBe(true);
    expect(h.queries.some((q) => q.includes('node_memory_MemTotal_bytes'))).toBe(true);
  });

  it('2. a Deployment pod maps to its workload by name — hope-stt never swallows hope-stt-worker', async () => {
    const h = build({ namespace: NS });
    const { cpu } = await h.service.getCatalogue();
    const by = (service: string) => cpu?.services.find((s) => s.service === service);

    expect(by('stt')).toMatchObject({
      label: 'Speech-to-text — live sessions',
      memoryBytes: 2 * GiB,
      memoryLimitBytes: 8 * GiB,
      cpuCores: 0.5,
      cpuRequestCores: 1,
      cpuLimitCores: 4,
    });
    expect(by('stt-worker')).toMatchObject({
      memoryBytes: 3 * GiB,
      cpuCores: 1.25,
      cpuRequestCores: 2,
      cpuLimitCores: 6,
      memoryLimitBytes: 12 * GiB,
    });
    expect(by('lm-studio')).toMatchObject({ memoryBytes: 10 * GiB, cpuCores: 0.135, cpuRequestCores: null, cpuLimitCores: null });
    expect(by('gateway')).toMatchObject({ label: 'Gateway', memoryBytes: 1 * GiB, cpuCores: 0.021, models: [], attributedBytes: 0 });
    // tts has no pod and no CPU model here — a service with no data at all is omitted; order is fixed
    expect(cpu?.services.map((s) => s.service)).toEqual(['stt', 'stt-worker', 'lm-studio', 'nlp', 'gateway', 'other']);
  });

  it('2b. the workload map is the `residency.cpu.workloads` setting, names regex-escaped', async () => {
    const h = build({ namespace: NS });
    h.state.settings['residency.cpu.workloads'] = { stt: 'hope.stt', gateway: 'hope-api' };
    h.state.series!.podMemory.push(sample(7 * GiB, { pod: 'hope.stt-675557d78c-zzzzz' }), sample(9 * GiB, { pod: 'hopeXstt-675557d78c-yyyyy' }));
    const { cpu } = await h.service.getCatalogue();

    expect(h.effectiveSettings.resolveEffective).toHaveBeenCalledWith('residency.cpu.workloads', { tenantId: SYSTEM_TENANT_ID });
    expect(cpu?.services.find((s) => s.service === 'stt')?.memoryBytes).toBe(7 * GiB);
    // nlp is not in the configured map, so its pod is NOT matched (its models still put it on the list)
    expect(cpu?.services.find((s) => s.service === 'nlp')?.memoryBytes).toBeNull();
  });

  it('3. `other` = every container on the node − the HOPE workloads matched; unattributed floors at 0', async () => {
    const h = build({ namespace: NS });
    const { cpu } = await h.service.getCatalogue();
    const other = cpu?.services.find((s) => s.service === 'other');
    // 40 GiB over all namespaces − (2 + 3 + 5 + 10 + 1) GiB matched
    expect(other).toMatchObject({ label: 'Other workloads', memoryBytes: 19 * GiB, models: [], cpuCores: null });
    // node used 58 GiB − Σ services 40 GiB
    expect(cpu?.unattributedBytes).toBe(18 * GiB);

    const h2 = build({ namespace: NS });
    h2.state.series!.memAvailable = [sample(60 * GiB)]; // node used 4 GiB < the 40 GiB the containers report
    h2.state.series!.allMemory = [sample(15 * GiB)]; // fewer than the 21 GiB matched
    const floored = (await h2.service.getCatalogue()).cpu;
    expect(floored?.unattributedBytes).toBe(0);
    expect(floored?.services.find((s) => s.service === 'other')?.memoryBytes).toBe(0);
  });

  it('4. no POD_NAMESPACE → the agents` own readings: node from the first report, RSS per service, no cores, no `other`', async () => {
    const h = build();
    const { cpu } = await h.service.getCatalogue();

    expect(cpu?.source).toBe('agents');
    expect(cpu?.node).toMatchObject({
      label: 'Host',
      totalBytes: 64 * GiB,
      freeBytes: 20 * GiB,
      usedBytes: 44 * GiB,
      cpuCores: null,
      utilisationPercent: null,
    });
    expect(cpu?.services.map((s) => s.service)).toEqual(['stt', 'nlp', 'tts', 'gateway']);
    for (const s of cpu!.services) {
      expect(s, s.service).toMatchObject({ cpuCores: null, cpuRequestCores: null, cpuLimitCores: null, memoryLimitBytes: null });
    }
    expect(cpu?.services.find((s) => s.service === 'nlp')?.memoryBytes).toBe(3 * GiB);
    expect(cpu?.services.find((s) => s.service === 'gateway')?.memoryBytes).toEqual(expect.any(Number));
    expect(cpu?.services.find((s) => s.service === 'gateway')!.memoryBytes!).toBeGreaterThan(0);
    // the node / pod series are never asked for without a namespace
    expect(h.queries.some((q) => q.includes('node_memory') || q.includes('container_'))).toBe(false);
  });

  it('5. a Prometheus outage (or empty node series) degrades to the agents source — it never throws', async () => {
    const down = build({ namespace: NS });
    down.state.prometheusDown = true;
    await expect(down.service.getCatalogue()).resolves.toMatchObject({ cpu: { source: 'agents' } });

    const empty = build({ namespace: NS });
    empty.state.series = null;
    const { cpu } = await empty.service.getCatalogue();
    expect(cpu?.source).toBe('agents');
    expect(cpu?.services.some((s) => s.service === 'other')).toBe(false);

    const blind = build();
    blind.state.reports = {};
    expect((await blind.service.getCatalogue()).cpu).toBeNull();
  });

  it('6. CPU headroom is a badge only: over it, a CPU load is previewed exactly as before and not refused', async () => {
    const withCpu = build({ namespace: NS });
    withCpu.state.reports.nlp.models = [agentModel()]; // GLiGuard not resident: a load candidate on host memory
    expect((await withCpu.service.getCatalogue()).cpu?.node.overHeadroom).toBe(true);
    const preview = await withCpu.service.previewLoad({ service: 'nlp', modelRef: GLIGUARD });

    const without = build();
    without.state.reports.nlp.models = [agentModel()];
    const baseline = await without.service.previewLoad({ service: 'nlp', modelRef: GLIGUARD });

    expect(preview).toEqual(baseline);
    expect(preview).toMatchObject({ device: 'cpu', fits: true, refusal: null });
  });

  it('7. CPU-resident models are listed under their service with bytes and how they are known; `devices[]` is unchanged', async () => {
    const h = build({ namespace: NS });
    const view = await h.service.getCatalogue();
    const nlp = view.cpu?.services.find((s) => s.service === 'nlp');

    expect(nlp?.models).toEqual([
      { service: 'nlp', modelRef: NER, name: 'Medical NER', bytes: 1_200 * MiB, bytesSource: 'measured' },
      { service: 'nlp', modelRef: GLIGUARD, name: 'GLiGuard', bytes: 1_136 * MiB, bytesSource: 'estimated' },
    ]);
    expect(nlp?.attributedBytes).toBe(1_200 * MiB + 1_136 * MiB);
    expect(nlp?.unattributedBytes).toBe(5 * GiB - (1_200 * MiB + 1_136 * MiB));
    // the host pool stays in `devices[]`, models and all — the CPU panel is an additional view of it
    const pool = view.devices.find((d) => d.id === 'cpu:nlp');
    expect(pool?.models.map((m) => m.modelRef)).toEqual([NER, GLIGUARD]);
  });

  it('8. the block is key-for-key the contract fixture (`model-residency-catalogue.fixture.json` → response.cpu)', async () => {
    const keys = (o: object) => Object.keys(o).sort();
    const { cpu } = await build({ namespace: NS }).service.getCatalogue();
    expect(keys(cpu!)).toEqual(keys(FIXTURE_CPU));
    expect(keys(cpu!.node)).toEqual(keys(FIXTURE_CPU.node));
    expect(keys(cpu!.services[0])).toEqual(keys(FIXTURE_CPU.services[0]));
    expect(keys(cpu!.services.find((s) => s.service === 'nlp')!.models[0])).toEqual(keys(FIXTURE_CPU.services[0].models[0]));
  });
});
