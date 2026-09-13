/**
 * The config-driven live tool layer.
 *
 * C4-T1 null/absent toolConfig ⇒ executor sequence + HTTP calls identical to pre-C4
 *        (one NLP call producing entities+vitals; groundedness iff env-enabled).
 * C4-T2 `ner.enabled:false` ⇒ no NLP call; grounding of PRIOR entities still re-runs.
 * C4-T3 unknown tool key ⇒ ignored at read (the write-side 400 lives in C2's service).
 * C4-T4 anti-laundering lock: extraction executors receive the transcript delta,
 *        never `runningSummary` — enforced by type AND asserted on the wire.
 */

import { Logger } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';
import { DEFAULT_LIVE_TOOL_PLAN, type ResolvedToolPlan } from '../live-agent.port';
import {
  GUARDRAIL_GROUNDEDNESS_TOOL,
  GuardrailGroundednessTool,
  type LiveToolRegistryDeps,
  LiveToolRegistry,
  NLP_CLASSIFY_TOKENS_TOOL,
  NlpExtractionTool,
  mapGroundednessResponse,
  mapVitals,
} from '../live-tool-registry';

const logger = { warn: vi.fn(), log: vi.fn(), error: vi.fn(), debug: vi.fn() } as unknown as Logger;

/**
 * A `ResolvedToolPlan` with `overrides` applied over the platform default.
 *
 * This used to be `normalizeToolPlan(agentToolConfig)` — the parser that turned
 * `DepartmentAgent.toolConfig` JSONB into a plan. deleted the parser
 * with the column it read; the REGISTRY's plan handling, which is what this
 * suite is actually about, is unchanged, so the plans are built directly.
 */
function plan(overrides: Partial<ResolvedToolPlan['tools']> = {}): ResolvedToolPlan {
  return { version: 1, tools: { ...DEFAULT_LIVE_TOOL_PLAN.tools, ...overrides } };
}

function makeDeps(post = vi.fn()): { deps: LiveToolRegistryDeps; post: ReturnType<typeof vi.fn> } {
  const httpService = { axiosRef: { post } } as never;
  return {
    post,
    deps: {
      // Fail-CLOSED `nlp.ner` selection: the NER tool needs BOTH a resolvable
      // routing election and a CLS scope to pin the SYSTEM-only read to.
      nlp: {
        httpService,
        nlpServiceUrl: 'http://nlp.test:8864',
        logger,
        routingPolicies: { resolveDefault: vi.fn().mockResolvedValue({ model: { sourceUri: 'blaze999/Medical-NER' } }) } as never,
        cls: { run: vi.fn((callback: () => unknown) => callback()), set: vi.fn(), get: vi.fn() } as never,
      },
      groundedness: {
        httpService,
        guardrailServiceUrl: 'http://guardrail.test:8863',
        logger,
        timeoutMs: 5000,
        maxRetries: 0,
        retryBackoffMs: 0,
      },
      // Pre-C4 platform behavior: ner/vitals always on, groundedness per env (off by default).
      envDefaults: { ner: true, vitals: true, groundedness: false },
    },
  };
}

describe('LiveToolRegistry — plan resolution (C4-T1/T2/T3)', () => {
  it('C4-T1: the default plan (null toolConfig) enables ner+vitals and defers groundedness to env', () => {
    const { deps } = makeDeps();
    const registry = new LiveToolRegistry(deps);
    const defaultPlan = DEFAULT_LIVE_TOOL_PLAN;

    expect(registry.isEnabled(defaultPlan, 'ner')).toBe(true);
    expect(registry.isEnabled(defaultPlan, 'vitals')).toBe(true);
    expect(registry.isEnabled(defaultPlan, 'groundedness')).toBe(false); // env default off

    const envOn = new LiveToolRegistry({ ...deps, envDefaults: { ner: true, vitals: true, groundedness: true } });
    expect(envOn.isEnabled(defaultPlan, 'groundedness')).toBe(true); // enabled:null follows env, both ways
  });

  it('C4-T2: an explicit false wins over the env default; an explicit true does too', () => {
    const { deps } = makeDeps();
    const registry = new LiveToolRegistry({ ...deps, envDefaults: { ner: true, vitals: true, groundedness: true } });
    const configured = plan({ ner: { enabled: false }, groundedness: { enabled: false } });

    expect(registry.isEnabled(configured, 'ner')).toBe(false);
    expect(registry.isEnabled(configured, 'vitals')).toBe(true); // untouched key keeps its default
    expect(registry.isEnabled(configured, 'groundedness')).toBe(false); // false beats env-on

    const forced = plan({ groundedness: { enabled: true } });
    const envOff = new LiveToolRegistry(deps);
    expect(envOff.isEnabled(forced, 'groundedness')).toBe(true);
  });

  // C4-T3's first half — "an unknown tool key is ignored at READ" — tested
  // `normalizeToolPlan`'s tolerance of a hand-written `DepartmentAgent.toolConfig`
  // blob. Both the column and the parser went with, so there is no
  // untrusted plan document left to be tolerant of. The REGISTRY's own
  // tolerance survives and is what the remaining assertion covers.
  it('C4-T3: a plan missing a tool entirely degrades to the env default, never to a crash', () => {
    const { deps } = makeDeps();
    const registry = new LiveToolRegistry(deps);

    expect(registry.isEnabled({ version: 1, tools: {} } as unknown as ResolvedToolPlan, 'ner')).toBe(true);
  });

  it('constructs executors lazily and memoizes them (a disabled tool is never constructed)', () => {
    const { deps } = makeDeps();
    const registry = new LiveToolRegistry(deps);
    expect(registry.extraction()).toBe(registry.extraction());
    expect(registry.guardrail()).toBe(registry.guardrail());
    expect(registry.extraction()).toBeInstanceOf(NlpExtractionTool);
    expect(registry.guardrail()).toBeInstanceOf(GuardrailGroundednessTool);
  });

  it('describeAll() is the OD-5(a) seam: tool-schema shaped, side-effect free, plan-filterable', () => {
    const { deps, post } = makeDeps();
    const registry = new LiveToolRegistry(deps);

    const all = registry.describeAll();
    expect(all.map((d) => d.key)).toEqual(['ner', 'vitals', 'groundedness']);
    expect(all.map((d) => d.name)).toEqual([NLP_CLASSIFY_TOKENS_TOOL, NLP_CLASSIFY_TOKENS_TOOL, GUARDRAIL_GROUNDEDNESS_TOOL]);
    for (const descriptor of all) {
      expect(descriptor.parameters.type).toBe('object');
      expect(descriptor.parameters.required.length).toBeGreaterThan(0);
    }
    expect(post).not.toHaveBeenCalled();

    const filtered = registry.describeAll(plan({ vitals: { enabled: false } }));
    expect(filtered.map((d) => d.key)).toEqual(['ner']); // groundedness off by env in this fixture
  });
});

describe('NlpExtractionTool (C4-T4 + relocation parity)', () => {
  it('posts the transcript text to /api/v1/classify/tokens and maps entities + vitals', async () => {
    const post = vi.fn().mockResolvedValue({
      data: {
        entities: [{ text: 'aspirin', entity_type: 'MEDICATION', confidence: 0.9, icd_code: null, position: { start: 3, end: 10 } }],
        vitals: { systolic: 120, diastolic: 80, heart_rate: null },
      },
    });
    const { deps } = makeDeps(post);
    const tool = new LiveToolRegistry(deps).extraction();

    const out = await tool.execute({ sourceText: 'pt aspirin daily' });

    expect(post).toHaveBeenCalledTimes(1);
    const [url, body, config] = post.mock.calls[0];
    expect(url).toBe('http://nlp.test:8864/api/v1/classify/tokens');
    // `model_name` is always present now — selection is fail-closed, so the
    // body never goes out without the resolved `nlp.ner` model.
    expect(body).toEqual({ text: 'pt aspirin daily', model_name: 'blaze999/Medical-NER' });
    expect(config.timeout).toBe(30000);
    // A2 — the RAW offsets are kept under `transcriptStart`/`transcriptEnd` beside `start`/`end`,
    // because `groundEntitiesToNote` overwrites the latter with NOTE offsets and the transcript
    // address (the one a "jump to transcript" citation needs) had no other way out of here.
    expect(out.entities).toEqual([
      { text: 'aspirin', type: 'MEDICATION', confidence: 0.9, icd10: undefined, start: 3, end: 10, transcriptStart: 3, transcriptEnd: 10 },
    ]);
    expect(out.vitals).toEqual({ systolic: 120, diastolic: 80 });
  });

  it('C4-T4: the extraction input carries ONLY source text — no channel for generated note text', async () => {
    const post = vi.fn().mockResolvedValue({ data: { entities: [] } });
    const { deps } = makeDeps(post);
    const tool = new LiveToolRegistry(deps).extraction();

    await tool.execute({ sourceText: 'TRANSCRIPT DELTA' });

    const [, body] = post.mock.calls[0];
    // Still no channel for generated note text — the only other key is the
    // fail-closed-resolved `model_name`.
    expect(Object.keys(body).sort()).toEqual(['model_name', 'text']);
    expect(body.text).toBe('TRANSCRIPT DELTA');
  });

  it('authenticates the gateway→NLP hop with X-Service-Token (regression)', async () => {
    const post = vi.fn().mockResolvedValue({ data: { entities: [] } });
    const { deps } = makeDeps(post);
    deps.nlp.secretsService = { getSecretOptional: vi.fn().mockResolvedValue('nlp-token') } as never;
    const tool = new LiveToolRegistry(deps).extraction();

    await tool.execute({ sourceText: 'pt reports cough' });

    const [, , config] = post.mock.calls[0];
    expect(config.headers['X-Service-Token'], 'NLP enforces this header whenever NLP_SERVICE_TOKEN is set').toBe('nlp-token');
  });

  it('sends an EMPTY service token when no secret is configured (preserves the dev bypass)', async () => {
    const post = vi.fn().mockResolvedValue({ data: { entities: [] } });
    const { deps } = makeDeps(post);
    const tool = new LiveToolRegistry(deps).extraction();

    await tool.execute({ sourceText: 'pt reports cough' });

    const [, , config] = post.mock.calls[0];
    expect(config.headers['X-Service-Token']).toBe('');
  });

  it('mapVitals returns undefined when the service reported nothing (never fabricated)', () => {
    expect(mapVitals(undefined)).toBeUndefined();
    expect(mapVitals({ systolic: null, spo2: null })).toBeUndefined();
    expect(mapVitals({ temperature_c: 37.2, weight_kg: 70 })).toEqual({ temperatureC: 37.2, weightKg: 70 });
  });
});

describe('GuardrailGroundednessTool (relocation parity)', () => {
  it('posts { summary, transcript } with the service token and maps the verdict', async () => {
    const post = vi.fn().mockResolvedValue({
      data: { checked: true, segments: [{ text: 'a', verdict: 'grounded', score: 0.9 }], flagged_spans: [] },
    });
    const { deps } = makeDeps(post);
    const tool = new LiveToolRegistry({
      ...deps,
      groundedness: { ...deps.groundedness, secretsService: { getSecretOptional: vi.fn().mockResolvedValue('tok') } as never },
    }).guardrail();

    const out = await tool.execute({ summary: 'NOTE', sourceText: 'TRANSCRIPT' });

    const [url, body, config] = post.mock.calls[0];
    expect(url).toBe('http://guardrail.test:8863/api/guardrail/ground');
    expect(body).toEqual({ summary: 'NOTE', transcript: 'TRANSCRIPT' });
    expect(config.headers['X-Service-Token']).toBe('tok');
    expect(out.verdict).toBe('grounded');
  });

  it('fails CLOSED: an erroring gate yields `unverified`, never `grounded`', async () => {
    const post = vi.fn().mockRejectedValue(new Error('guardrail down'));
    const { deps } = makeDeps(post);
    const out = await new LiveToolRegistry(deps).guardrail().execute({ summary: 'NOTE', sourceText: 'T' });
    expect(out.verdict).toBe('unverified');
  });

  it('mapGroundednessResponse refuses to trust a checked:false body', () => {
    const mapped = mapGroundednessResponse({ checked: false, segments: [{ text: 'a', verdict: 'grounded' }] });
    expect(mapped?.verdict).toBe('unverified');
    expect(mapped?.segments?.[0].verdict).toBe('unverified');
    expect(mapGroundednessResponse({ nonsense: true })).toBeNull();
  });
});
