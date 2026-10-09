import { Logger } from '@nestjs/common';
import { register, type Gauge } from 'prom-client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { RESIDENCY_AGENT_LOAD_TIMEOUT_MS, ResidencyAgentClient, ResidencyAgentError } from '../residency-agent.client';
import { RESIDENCY_LIVE_PATH_MODEL_LOADED, RESIDENCY_SERVICE_REACHABLE } from '../residency-metrics';
import { ASR, GEMMA, GLIGUARD, GRANITE, MiB, NER, UUID0, agentModel, audits, build, lmsModel, refusal, type Row } from './task1055-harness';

/**
 * TASK-1055 — the post-merge review of the gateway residency controller (findings R1-F* / R2-F*):
 * the suggestion never flips a model off its own placement, splits fit PER CARD, a longer context
 * costs more memory, makeDefault is judged first and written only once the load lands, a replace is
 * as careful as an unload (reason, one copy, each copy restored where it was), the policy loop places
 * where the load goes, timeouts outlast the agents', and two gauges the deployment alerts on.
 */

afterEach(() => vi.restoreAllMocks());

const GiB = 1024 * MiB;

/** Free memory per card in MiB, with DCGM's used memory set so each card still totals 16 380 MiB (headroom 2 457 MiB). */
function setFree(h: ReturnType<typeof build>, free: Record<string, number>): void {
  h.state.freeMib = { ...free };
  h.state.usedMib = Object.fromEntries(Object.entries(free).map(([gpu, mib]) => [gpu, 16_000 - mib]));
}

function nerLivePath(h: ReturnType<typeof build>): void {
  h.state.livePath = [
    { service: 'nlp', modelRef: NER, aiModelId: 'model-ner', aiModelIds: ['model-ner'], tenantId: 't', agentSlug: 'ner', role: 'routing' },
  ];
  h.state.usage.set('model-ner', {
    agentCount: 10,
    tenantCount: 10,
    liveConsultation: true,
    uses: [],
    consumers: { agents: 10, fallbacks: 0, routingPolicies: 0, pipelineStages: 0, workflowNodes: 0 },
  });
}

// ── R1-F1 — the suggestion keeps the model's own placement ──────────────────────

describe('R1-F1 — the suggestion never flips a model off its default placement', () => {
  it('the model`s defaultDevice is suggested whenever it fits, even when another card has more room', async () => {
    const h = build();
    setFree(h, { '0': 8_000, '1': 13_830 });
    h.state.catalogue[1].metaData = { residency: { defaultDevice: 'gpu0' } };

    const preview = await h.service.previewLoad({ service: 'nlp', modelRef: GLIGUARD });

    expect(preview.suggestedDevice).toBe('gpu0');
    expect(preview.candidates.map((c) => c.device)).toEqual(['gpu0', 'gpu1']);
  });

  it('LM Studio: the profile`s card is suggested while it fits', async () => {
    const h = build();
    h.state.models['lm-studio'] = [];
    setFree(h, { '0': 13_830, '1': 8_000 }); // Gemma's profile is GPU 1 (priorityOrder [1])

    const preview = await h.service.previewLoad({ service: 'lm-studio', modelRef: GEMMA });

    expect(preview.device).toBe('gpu1');
    expect(preview.suggestedDevice).toBe('gpu1');
  });

  it('when the default does not fit, the best SINGLE card is suggested before `multi`, even if the split leaves more room', async () => {
    const h = build();
    h.state.models['lm-studio'] = [];
    // Granite (4 900 MiB, profile GPU 0): GPU 0 has 4 543 MiB above headroom (short), GPU 1 5 543 (fits, 643 to spare);
    // an even split fits too and would leave 5 186 MiB — the old "most remaining" rule picked it.
    setFree(h, { '0': 7_000, '1': 8_000 });

    const preview = await h.service.previewLoad({ service: 'lm-studio', modelRef: GRANITE });

    expect(preview.suggestedDevice).toBe('gpu1');
    expect(preview.candidates.map((c) => c.device)).toEqual(['gpu1', 'multi', 'gpu0']);
  });

  it('`multi` is suggested only when no single card fits and the split does', async () => {
    const h = build();
    h.state.models['lm-studio'] = [];
    setFree(h, { '0': 6_000, '1': 6_000 }); // 3 543 MiB above headroom on each: no card holds 4 900, 2 450 per card does

    const preview = await h.service.previewLoad({ service: 'lm-studio', modelRef: GRANITE });

    expect(preview.suggestedDevice).toBe('multi');
  });
});

// ── R2-F5 — a split fits per card ─────────────────────────────────────────────────

describe('R2-F5 — split admission is judged per card', () => {
  it('`multi` does not fit when one card cannot hold its half, however much the other card has', async () => {
    const h = build();
    h.state.models['lm-studio'] = [];
    setFree(h, { '0': 3_200, '1': 13_830 }); // GPU 0: 743 MiB above headroom < 2 450 MiB (half of Granite)

    const preview = await h.service.previewLoad({ service: 'lm-studio', modelRef: GRANITE, device: 'multi' });

    const multi = preview.candidates.find((c) => c.device === 'multi')!;
    expect(multi.fits).toBe(false);
    expect(multi.shortfallBytes).toBe((2_450 - (3_200 - 2_457)) * MiB);
    expect(preview).toMatchObject({ fits: false, refusal: 'OVER_BUDGET' });
    expect(await refusal(h.service.load({ service: 'lm-studio', modelRef: GRANITE, device: 'multi' }))).toMatchObject({
      status: 409,
      body: { code: 'OVER_BUDGET', device: 'multi' },
    });
  });

  it('a per-card share larger than that card`s FREE memory is EXCEEDS_DEVICE, even forced', async () => {
    const h = build();
    h.state.models['lm-studio'] = [];
    setFree(h, { '0': 2_000, '1': 13_830 });

    const { body } = await refusal(h.service.load({ service: 'lm-studio', modelRef: GRANITE, device: 'multi', force: true, reason: 'x' }));

    expect(body).toMatchObject({ code: 'EXCEEDS_DEVICE', device: 'multi' });
    expect(h.agents.load).not.toHaveBeenCalled();
  });

  it('a profile split with a custom ratio is judged by that ratio', async () => {
    const h = build();
    h.state.models['lm-studio'] = [];
    // Granite profile: custom 1:3 across both cards → 1 225 MiB on GPU 0, 3 675 MiB on GPU 1.
    h.state.catalogue[4].metaData = {
      serving: { contextLength: 16384, parallel: 10, gpuSplit: { strategy: 'custom', customRatio: [1, 3] } },
    };
    setFree(h, { '0': 4_000, '1': 6_000 }); // rooms 1 543 / 3 543: GPU 1 is 132 MiB short of its 3 675

    const preview = await h.service.previewLoad({ service: 'lm-studio', modelRef: GRANITE });

    expect(preview.device).toBe('multi');
    expect(preview.fits).toBe(false);
    expect(preview.shortfallBytes).toBe(132 * MiB);
  });
});

// ── R2-F6 — a longer context needs more memory ────────────────────────────────────

describe('R2-F6 — context-length overrides scale the need', () => {
  it('a context above the one the footprint was measured at scales the need by the ratio', async () => {
    const h = build();
    h.state.models['lm-studio'] = [];
    setFree(h, { '0': 13_000, '1': 13_830 });

    const same = await h.service.previewLoad({ service: 'lm-studio', modelRef: GRANITE, options: { contextLength: 8192 } });
    expect(same.needBytes).toBe(4_900 * MiB);

    const doubled = await h.service.previewLoad({ service: 'lm-studio', modelRef: GRANITE, options: { contextLength: 32768 } });
    expect(doubled.needBytes).toBe(9_800 * MiB);
  });

  it('a scaled need over budget needs force + reason like any other', async () => {
    const h = build();
    h.state.models['lm-studio'] = [];
    setFree(h, { '0': 11_000, '1': 13_830 }); // 8 543 above headroom < 9 800 ≤ 11 000 free

    expect(
      await refusal(h.service.load({ service: 'lm-studio', modelRef: GRANITE, device: 'gpu0', options: { contextLength: 32768 } })),
    ).toMatchObject({ status: 409, body: { code: 'OVER_BUDGET', needBytes: 9_800 * MiB } });

    const forced = await h.service.load({
      service: 'lm-studio',
      modelRef: GRANITE,
      device: 'gpu0',
      options: { contextLength: 32768 },
      force: true,
      reason: 'long-context test',
    });
    expect(forced.status).toBe(202);
    await h.service.drain();
  });

  it('a profile context above the recorded measurement context scales the need too', async () => {
    const h = build();
    h.state.models['lm-studio'] = [];
    h.state.catalogue[4].metaData = {
      residency: { observedContextLength: 8192 },
      serving: { contextLength: 16384, parallel: 10, gpuSplit: { strategy: 'priorityOrder', priority: [0], disabledGpus: [1] } },
    };
    const preview = await h.service.previewLoad({ service: 'lm-studio', modelRef: GRANITE });
    expect(preview.needBytes).toBe(9_800 * MiB);
  });

  it('a measured load records the context it was measured at', async () => {
    const h = build();
    h.state.models['lm-studio'] = [];
    setFree(h, { '0': 13_000, '1': 13_830 });
    h.agents.load.mockResolvedValueOnce({
      outcome: 'loaded',
      model: lmsModel({ modelRef: GRANITE, bytes: 5_000 * MiB, loadConfig: { contextLength: 16384 } }),
    });
    await h.service.load({ service: 'lm-studio', modelRef: GRANITE });
    await h.service.drain();
    const row = h.state.catalogue[4] as { observedMemoryMb: number; metaData: { residency?: Row } };
    expect(row.observedMemoryMb).toBe(5_000);
    expect(row.metaData.residency).toMatchObject({ observedContextLength: 16384 });
  });

  it('a context above the model`s declared maximum is refused 400', async () => {
    const h = build();
    h.state.models['lm-studio'] = [];
    const { status, body } = await refusal(h.service.load({ service: 'lm-studio', modelRef: GEMMA, options: { contextLength: 131072 } }));
    expect(status).toBe(400);
    expect(body).toMatchObject({ code: 'CONTEXT_LENGTH_UNSUPPORTED', maxContextLength: 65536 });
    expect(h.agents.load).not.toHaveBeenCalled();
  });
});

// ── R2-F7 — makeDefault ─────────────────────────────────────────────────────────

describe('R2-F7 — makeDefault is judged first and written only once the load lands', () => {
  it('the default is written AFTER the load succeeds, and audited with the device and the previous value', async () => {
    const h = build();
    h.state.catalogue[1].metaData = { residency: { defaultDevice: 'gpu0' } };
    let release!: () => void;
    h.agents.load.mockImplementationOnce(
      () =>
        new Promise((done) => {
          release = () => done({ outcome: 'loaded', model: agentModel({ modelRef: GLIGUARD, device: 'cuda:1' }) });
        }) as never,
    );

    await h.service.load({ service: 'nlp', modelRef: GLIGUARD, device: 'gpu1', makeDefault: true });
    expect(h.aiModels.updateWithVersion).not.toHaveBeenCalled();

    release();
    await h.service.drain();
    expect((h.state.catalogue[1].metaData as { residency: Row }).residency.defaultDevice).toBe('gpu1');
    expect(audits(h).find((a) => a.action === 'model-residency.default-device')).toMatchObject({
      service: 'nlp',
      aiModelId: 'model-gliguard',
      device: 'gpu1',
      previousDevice: 'gpu0',
    });
  });

  it('a failed load writes no default', async () => {
    const h = build();
    h.agents.load.mockRejectedValueOnce(new ResidencyAgentError('LOAD_FAILED', 'CUDA OOM', 500));
    await h.service.load({ service: 'nlp', modelRef: GLIGUARD, device: 'gpu1', makeDefault: true });
    await h.service.drain();
    expect(h.aiModels.updateWithVersion).not.toHaveBeenCalled();
  });

  it('a forced over-budget load is never made the default: refused before anything is sent or written', async () => {
    const h = build();
    const { status, body } = await refusal(
      h.service.load({ service: 'nlp', modelRef: GLIGUARD, device: 'gpu0', makeDefault: true, force: true, reason: 'tight' }),
    );
    expect(status).toBe(409);
    expect(body).toMatchObject({ code: 'MAKE_DEFAULT_OVER_BUDGET', device: 'gpu0', suggestedDevice: 'gpu1' });
    expect(h.agents.load).not.toHaveBeenCalled();
    expect(h.aiModels.updateWithVersion).not.toHaveBeenCalled();
  });

  it('already loaded on that same device: the default is written at once (and audited)', async () => {
    const h = build();
    h.state.models.nlp = [agentModel({ modelRef: GLIGUARD, cache: 'nlp_gliner2_guard', device: 'cuda:1' })];
    const result = await h.service.load({ service: 'nlp', modelRef: GLIGUARD, device: 'gpu1', makeDefault: true });
    expect(result.body).toMatchObject({ outcome: 'already_loaded' });
    expect((h.state.catalogue[1].metaData as { residency: Row }).residency.defaultDevice).toBe('gpu1');
    expect(audits(h).find((a) => a.action === 'model-residency.default-device')).toMatchObject({ device: 'gpu1', previousDevice: null });
  });

  it('already loaded on ANOTHER device: refused, nothing written', async () => {
    const h = build(); // Gemma is resident on GPU 1
    setFree(h, { '0': 13_000, '1': 13_830 });
    const { status, body } = await refusal(h.service.load({ service: 'lm-studio', modelRef: GEMMA, device: 'gpu0', makeDefault: true }));
    expect(status).toBe(409);
    expect(body).toMatchObject({ code: 'ALREADY_LOADED_ELSEWHERE', device: 'gpu0', loadedOn: 'gpu1' });
    expect(h.aiModels.updateWithVersion).not.toHaveBeenCalled();
  });
});

// ── R2-F8 / R1-F3 / R1-F4 — replace ──────────────────────────────────────────────

describe('R2-F8 / R1-F3 / R1-F4 — a replace is as careful as an unload', () => {
  it('replacing a live-path model without a reason is 409 LIVE_PATH_REASON_REQUIRED; with one it proceeds', async () => {
    const h = build();
    nerLivePath(h);
    h.state.models.nlp = [agentModel({ modelRef: NER, cache: 'nlp_token_classifier', device: 'cuda:1' })];

    expect(await refusal(h.service.load({ service: 'nlp', modelRef: NER, replace: true }))).toMatchObject({
      status: 409,
      body: { code: 'LIVE_PATH_REASON_REQUIRED', consumers: ['10 agents · 10 tenants (live consultations)'] },
    });
    expect(h.agents.unload).not.toHaveBeenCalled();

    const accepted = await h.service.load({ service: 'nlp', modelRef: NER, replace: true, reason: 'reload after config change' });
    expect(accepted.status).toBe(202);
    await h.service.drain();
  });

  it('an nlp replace unloads ONLY the copy on the target device', async () => {
    const h = build();
    h.state.models.nlp = [
      agentModel({ modelRef: NER, cache: 'nlp_token_classifier', device: 'cuda:0' }),
      agentModel({ modelRef: NER, cache: 'nlp_token_classifier', device: 'cuda:1' }),
    ];
    await h.service.load({ service: 'nlp', modelRef: NER, device: 'gpu1', replace: true });
    await h.service.drain();
    expect(h.agents.unload).toHaveBeenCalledTimes(1);
    expect(h.agents.unload).toHaveBeenCalledWith('nlp', expect.objectContaining({ modelRef: NER, device: 'cuda:1' }));
  });

  it('a failed nlp replace restores the copy on ITS device, and touches no other copy', async () => {
    const h = build();
    h.state.models.nlp = [
      agentModel({ modelRef: NER, cache: 'nlp_token_classifier', device: 'cuda:0' }),
      agentModel({ modelRef: NER, cache: 'nlp_token_classifier', device: 'cuda:1' }),
    ];
    h.agents.load.mockRejectedValueOnce(new ResidencyAgentError('LOAD_FAILED', 'boom', 500));
    await h.service.load({ service: 'nlp', modelRef: NER, device: 'gpu1', replace: true });
    await h.service.drain();
    const loads = h.agents.load.mock.calls.map(([, r]) => (r as { device?: string }).device);
    expect(loads).toEqual(['cuda:1', 'cuda:1']);
  });

  it('a failed LM Studio replace restores the instance with ITS previous load config', async () => {
    const h = build();
    h.state.models['lm-studio'] = [
      lmsModel({
        modelRef: GRANITE,
        instanceId: GRANITE,
        device: 'cuda:1',
        loadConfig: {
          contextLength: 8192,
          parallel: 4,
          flashAttention: false,
          kvCacheQuant: { k: 'q8_0', v: 'q8_0' },
          gpuSplit: { strategy: 'priorityOrder', priority: [1], disabledGpus: [0], customRatio: [] },
        },
      }),
    ];
    setFree(h, { '0': 13_000, '1': 13_830 });
    h.agents.load.mockRejectedValueOnce(new ResidencyAgentError('LOAD_FAILED', 'boom', 500));

    await h.service.load({ service: 'lm-studio', modelRef: GRANITE, replace: true, options: { contextLength: 4096 } });
    await h.service.drain();

    const [, restore] = h.agents.load.mock.calls[1] as unknown as [string, { loadSpec: Row; device?: string }];
    expect(restore.loadSpec).toMatchObject({
      identifier: GRANITE,
      context_length: 8192,
      parallel: 4,
      flash_attention: false,
      kv_cache_quant: { k: 'q8_0', v: 'q8_0' },
      gpu_split: { strategy: 'priorityOrder', priority: [1], disabled_gpus: [0], custom_ratio: [] },
    });
  });
});

// ── R1-F2 — the policy loop places where the load goes ───────────────────────────

describe('R1-F2 — enforce places, budgets and gates on the load plan`s target', () => {
  it('a live-path model with defaultDevice gpu1 is admitted against GPU 1 and loaded there', async () => {
    const h = build({ enforce: true });
    h.state.catalogue[1].metaData = { residency: { defaultDevice: 'gpu1' } };
    h.state.livePath = [
      {
        service: 'nlp',
        modelRef: GLIGUARD,
        aiModelId: 'model-gliguard',
        aiModelIds: ['model-gliguard'],
        tenantId: 't',
        agentSlug: 'g',
        role: 'routing',
      },
    ];
    let release!: () => void;
    h.agents.load.mockImplementationOnce(
      () =>
        new Promise((done) => {
          release = () => done({ outcome: 'loaded', model: agentModel({ modelRef: GLIGUARD, device: 'cuda:1' }) });
        }) as never,
    );

    await h.service.tick();

    expect(h.agents.load).toHaveBeenCalledWith('nlp', expect.objectContaining({ modelRef: GLIGUARD, device: 'cuda:1' }));
    // The gate holds GPU 1 — the target — not GPU 0.
    expect(await refusal(h.service.load({ service: 'nlp', modelRef: NER, device: 'gpu1', force: true, reason: 'x' }))).toMatchObject({
      body: { code: 'LOAD_IN_PROGRESS' },
    });
    expect((await h.service.load({ service: 'nlp', modelRef: NER, device: 'gpu0', force: true, reason: 'other card' })).status).toBe(202);
    release();
    await h.service.drain();
  });
});

// ── R1-F5 — timeouts ────────────────────────────────────────────────────────────

describe('R1-F5 — load timeouts', () => {
  it('the gateway waits longer for an agent load than the agents themselves (LM Studio agent: 600 s)', () => {
    expect(RESIDENCY_AGENT_LOAD_TIMEOUT_MS).toBeGreaterThanOrEqual(900_000);
  });

  it('a timed-out agent call is marked `timedOut`', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw Object.assign(new Error('aborted'), { name: 'AbortError' });
      }),
    );
    const client = new ResidencyAgentClient(
      { getConfigValue: vi.fn(() => 'http://hope-nlp:8864') } as never,
      { getSecretOptional: vi.fn(async () => 'tok') } as never,
    );
    const error = await client.load('nlp', { modelRef: GLIGUARD, loadSpec: {}, pin: false }).catch((e: unknown) => e);
    vi.unstubAllGlobals();
    expect(error).toBeInstanceOf(ResidencyAgentError);
    expect((error as ResidencyAgentError).timedOut).toBe(true);
  });

  it('after a gateway timeout the card stays claimed until a report shows the instance loaded', async () => {
    vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const h = build();
    h.agents.load.mockRejectedValueOnce(
      Object.assign(new ResidencyAgentError('SERVICE_UNREACHABLE', 'timed out after 900000 ms', 0, undefined, undefined, { timedOut: true })),
    );
    await h.service.load({ service: 'nlp', modelRef: GLIGUARD, device: 'gpu1' });
    await h.service.drain();

    expect(await refusal(h.service.load({ service: 'nlp', modelRef: NER, device: 'gpu1' }))).toMatchObject({ body: { code: 'LOAD_IN_PROGRESS' } });

    h.state.models.nlp = [agentModel({ modelRef: GLIGUARD, cache: 'nlp_gliner2_guard', device: 'cuda:1' })];
    await h.service.tick();
    expect((await h.service.load({ service: 'nlp', modelRef: NER, device: 'gpu1' })).status).toBe(202);
    await h.service.drain();
  });
});

// ── R1-F7 / R1-F8 / R1-F9 / R1-F10 ──────────────────────────────────────────────

describe('R1-F7 — device mapping', () => {
  it('a uuid that matches no DCGM card is NOT mapped onto the only card', async () => {
    const h = build();
    h.state.freeMib = { '0': 13_000 };
    h.state.usedMib = { '0': 3_000 };
    h.state.dcgmUuid = { '0': UUID0 };
    h.state.devices.nlp = [{ id: 'cuda:0', kind: 'gpu', totalBytes: 16 * GiB, freeBytes: 8 * GiB, index: 0, uuid: 'GPU-some-other-card' }];
    h.state.models.nlp = [agentModel({ modelRef: GLIGUARD, cache: 'nlp_gliner2_guard', device: 'cuda:0' })];

    const view = await h.service.getView();
    expect(view.models.find((m) => m.modelRef === GLIGUARD)?.device).toBe('cuda:0');
  });
});

describe('R1-F8 — preview `device` is in the request vocabulary', () => {
  it('host memory is `cpu`, never `cpu:<service>`', async () => {
    const h = build();
    h.state.devices.nlp = [{ id: 'cpu', kind: 'cpu', totalBytes: 64 * GiB, freeBytes: 32 * GiB }];
    const preview = await h.service.previewLoad({ service: 'nlp', modelRef: GLIGUARD });
    expect(preview.device).toBe('cpu');

    const h2 = build();
    h2.state.devices.nlp = [{ id: 'cpu', kind: 'cpu', totalBytes: 64 * GiB, freeBytes: 32 * GiB }];
    h2.state.models.nlp = [agentModel({ modelRef: GLIGUARD, cache: 'nlp_gliner2_guard', device: 'cpu' })];
    expect((await h2.service.previewLoad({ service: 'nlp', modelRef: GLIGUARD })).device).toBe('cpu');
  });
});

describe('R1-F9 — the policy loop sees each device copy on its own', () => {
  it('an idle copy on GPU 0 is unloaded — only that copy — while the busy copy on GPU 1 stays', async () => {
    const h = build({ enforce: true });
    const hourAgo = new Date(Date.now() - 3_600_000).toISOString();
    h.state.policies = [{ id: 'p1', aiModelId: 'model-gliguard', service: 'nlp', class: 'ON_DEMAND', priority: 0, idleTtlSeconds: 60, version: 1 }];
    h.state.models.stt = [];
    h.state.models.nlp = [
      agentModel({ modelRef: GLIGUARD, cache: 'nlp_gliner2_guard', device: 'cuda:0', loadedAt: hourAgo, lastUsedAt: hourAgo }),
      agentModel({ modelRef: GLIGUARD, cache: 'nlp_gliner2_guard', device: 'cuda:1', loadedAt: hourAgo, lastUsedAt: new Date().toISOString() }),
    ];

    await h.service.tick();

    expect(h.agents.unload).toHaveBeenCalledTimes(1);
    expect(h.agents.unload).toHaveBeenCalledWith('nlp', expect.objectContaining({ modelRef: GLIGUARD, device: 'cuda:0' }));
  });
});

describe('R1-F10 — a stored default device does not bypass ALREADY_LOADED', () => {
  it('a model resident on GPU 0 with defaultDevice gpu1 is already loaded; no second copy is made', async () => {
    const h = build();
    h.state.catalogue[1].metaData = { residency: { defaultDevice: 'gpu1' } };
    h.state.models.nlp = [agentModel({ modelRef: GLIGUARD, cache: 'nlp_gliner2_guard', device: 'cuda:0' })];

    const result = await h.service.load({ service: 'nlp', modelRef: GLIGUARD });

    expect(result).toMatchObject({ status: 200, body: { outcome: 'already_loaded' } });
    expect(h.agents.load).not.toHaveBeenCalled();
  });
});

// ── R2-F4 — gauges ──────────────────────────────────────────────────────────────

describe('R2-F4 — reachability and live-path gauges (names frozen for the alerts)', () => {
  const values = async (name: string) => {
    const metric = register.getSingleMetric(name) as Gauge | undefined;
    if (!metric) return [];
    return (await metric.get()).values.map((v) => ({ labels: v.labels, value: v.value }));
  };

  it('each tick sets residency_service_reachable{service} and residency_live_path_model_loaded{service,model_ref}', async () => {
    const h = build();
    h.state.reachable['lm-studio'] = false;
    nerLivePath(h);
    h.state.livePath.push({
      service: 'stt',
      modelRef: ASR,
      aiModelId: 'model-asr',
      aiModelIds: ['model-asr'],
      tenantId: 't',
      agentSlug: 'a',
      role: 'primary',
    });
    h.state.models.stt = [];
    h.state.models.nlp = [agentModel({ modelRef: NER, cache: 'nlp_token_classifier', device: 'cuda:1' })];

    await h.service.tick();

    expect(RESIDENCY_SERVICE_REACHABLE).toBe('residency_service_reachable');
    expect(RESIDENCY_LIVE_PATH_MODEL_LOADED).toBe('residency_live_path_model_loaded');
    expect(await values(RESIDENCY_SERVICE_REACHABLE)).toEqual(
      expect.arrayContaining([
        { labels: { service: 'stt' }, value: 1 },
        { labels: { service: 'nlp' }, value: 1 },
        { labels: { service: 'lm-studio' }, value: 0 },
      ]),
    );
    expect(await values(RESIDENCY_LIVE_PATH_MODEL_LOADED)).toEqual([
      { labels: { service: 'nlp', model_ref: NER }, value: 1 },
      { labels: { service: 'stt', model_ref: ASR }, value: 0 },
    ]);
  });
});
