/**
 * TASK-970 L2 — reasoning-posture cross-language parity (TypeScript half).
 *
 * `@arcaai/applications` PRODUCES the posture (`TextRequestEnrichmentService.applyTextRuntimeProfile`,
 * over `reasoningWire`) and `apps/text` CONSUMES it (`GenerateRequest.reasoning`, then one
 * render per adapter). Both halves read the SAME committed fixture —
 * `reasoning-posture.fixture.json` — so a shape change on one side fails the other.
 *
 * Why the fixture exists at all: before TASK-970 the posture was pre-rendered here into
 * `extra.reasoning_effort`, mapping `enabled: false` onto `'minimal'`. That is LOSSY — on the
 * wire "the admin turned reasoning OFF" became indistinguishable from "the admin asked for
 * minimal EFFORT", so an engine whose off-switch is a different parameter entirely (Ollama
 * `think: false`, Anthropic `thinking: {type: 'disabled'}`) could not be driven correctly from
 * it. The posture now travels AS a posture and each adapter renders it.
 *
 * This file asserts the PRODUCER side, end to end through the real service and the real
 * settings registry — a stub would assert only that this test agrees with itself.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
// Everything comes through @arcaai/applications: the root workspace has no direct dependency
// on the package's internals, and the barrel already re-exports both halves (the same shape
// `resolved-asr-spec-parity.contract.test.ts` uses for the ASR spec).
import { AGENT_REASONING_EFFORTS, EffectiveSettingsService, REASONING_WIRE_FIELD, TextRequestEnrichmentService, reasoningWire } from '@arcaai/applications';
import type { AgentReasoning } from '@arcaai/applications';

interface WireCase {
  name: string;
  posture: AgentReasoning | null;
  meaning: string;
}

const fixture = JSON.parse(readFileSync(path.join(__dirname, 'reasoning-posture.fixture.json'), 'utf-8')) as {
  wire: { field: string; location: string; cases: WireCase[]; caller_override: string };
  support: Record<string, { class: string; renders: string | null; verified: boolean }>;
};

const cases = fixture.wire.cases;
const byName = (name: string): WireCase => {
  const found = cases.find((entry) => entry.name === name);
  if (!found) throw new Error(`fixture.wire.cases has no case named ${name}`);
  return found;
};

const TENANT = 'tenant-1';
const cls = () => ({ get: vi.fn().mockReturnValue(TENANT) });

/**
 * The REAL enrichment service over the REAL registry. `settings` undefined ⇒ the facade is
 * present but its `global-kv` backend is not, so `resolveEffective` applies the descriptor's
 * OWN declared `failMode` — which is how the platform default below is proven to be the
 * registry's and not this file's.
 */
function build(settings?: { value: unknown }) {
  const tenantSettings = settings === undefined ? undefined : { resolve: vi.fn(() => ({ value: settings.value, source: 'system' })) };
  return new TextRequestEnrichmentService(cls() as never, undefined, new EffectiveSettingsService(tenantSettings as never) as never);
}

/** No settings facade at all — the "nobody is wired to answer" shape. */
const buildUnwired = () => new TextRequestEnrichmentService(cls() as never, undefined, undefined);

type Body = { provider?: string; model?: string; extra?: Record<string, unknown>; reasoning?: AgentReasoning };
const body = (): Body => ({ provider: 'lm-studio', model: 'gemma' });

/** What reached the wire for this body: the posture, or `null` for "the field is absent". */
function wireOf(target: Body): AgentReasoning | null {
  if (!Object.prototype.hasOwnProperty.call(target, REASONING_WIRE_FIELD)) return null;
  return target.reasoning ?? null;
}

describe('TASK-970 — the fixture is not vacuous', () => {
  it('names the field this producer writes, at the location the Python half reads', () => {
    expect(fixture.wire.field).toBe(REASONING_WIRE_FIELD);
    expect(fixture.wire.location).toContain('GenerateRequest');
  });

  it('declares all four cases, each distinct, covering both postures and the absence', () => {
    expect(cases.map((entry) => entry.name)).toEqual(['off', 'on-unspecified', 'on-effort', 'absent']);
    expect(new Set(cases.map((entry) => JSON.stringify(entry.posture))).size).toBe(4);
    expect(new Set(cases.map((entry) => entry.posture?.enabled ?? null))).toEqual(new Set([false, true, null]));
    // One case, and only one, means "send nothing".
    expect(cases.filter((entry) => entry.posture === null)).toHaveLength(1);
  });

  it('uses the effort vocabulary this package declares — a fifth effort here would be unrenderable', () => {
    for (const { name, posture } of cases) {
      if (posture?.effort !== undefined) expect(AGENT_REASONING_EFFORTS, name).toContain(posture.effort);
    }
    expect(byName('on-effort').posture?.effort).toBe('high');
  });

  it('declares a support class for every adapter the Python half owns, and every class is one of three', () => {
    // Read-only here: L1 OWNS `support[*]` and must correct each row against the deployed
    // engine. This half pins only that the table stays a TOTAL function over the ten adapters
    // the ticket measured — a class may be corrected, an adapter may not quietly vanish from
    // the contract and go back to dropping the posture unrecorded.
    const adapters = Object.entries(fixture.support).filter(([key]) => !key.startsWith('$'));
    expect(adapters.map(([key]) => key)).toEqual(
      expect.arrayContaining(['openai', 'azure_openai', 'openai_compat', 'lmstudio', 'vllm', 'ollama', 'anthropic', 'llama_cpp', 'bedrock', 'vertex']),
    );
    for (const [adapter, entry] of adapters) {
      expect(['native-off', 'effort-only', 'unsupported'], adapter).toContain(entry.class);
      // `unsupported` renders nothing; everything else must name the parameter it renders.
      expect(entry.renders === null, adapter).toBe(entry.class === 'unsupported');
    }
  });
});

describe('TASK-970 — reasoningWire is the identity on the posture, and silence on its absence', () => {
  it.each(cases.map((entry) => [entry.name, entry] as const))('%s', (_name, entry) => {
    expect(reasoningWire(entry.posture)).toEqual(entry.posture ?? undefined);
  });

  it('drops an effort that was authored alongside `enabled: false` — off is off', () => {
    // `agentReasoningProblems` accepts `{ enabled: false, effort: 'high' }` (both keys are
    // individually valid), but a budget for reasoning that will not happen is a second,
    // contradictory instruction on a wire that must carry exactly one.
    expect(reasoningWire({ enabled: false, effort: 'high' })).toEqual(byName('off').posture);
  });
});

describe('TASK-970 — the AGENT tier emits the fixture posture verbatim', () => {
  it.each(cases.filter((entry) => entry.posture !== null).map((entry) => [entry.name, entry] as const))('%s', async (_name, entry) => {
    // Platform default deliberately set to something ELSE, so a case that passes here passes
    // because the agent tier won — not because the two tiers happened to agree.
    const out = await build({ value: 'low' }).applyTextRuntimeProfile(body(), { temperature: 0.2, reasoning: entry.posture });
    expect(wireOf(out)).toEqual(entry.posture);
  });
});

describe('TASK-970 — the PLATFORM tier renders into the same four cases', () => {
  it('`minimal` — the platform posture TASK-968 declared — is the `off` case', async () => {
    // The descriptor's own words: "'minimal' (default) is the engine's own off switch and is
    // the platform posture". On an `effort-only` adapter `{enabled:false}` renders back to
    // `reasoning_effort: 'minimal'`, so the OpenAI family sees the identical bytes it saw
    // before this ticket; on Ollama/Anthropic it becomes the off-switch it always meant.
    const out = await build({ value: 'minimal' }).applyTextRuntimeProfile(body(), { temperature: 0.2 });
    expect(wireOf(out)).toEqual(byName('off').posture);
  });

  it('a named effort is the `on-effort` case', async () => {
    const out = await build({ value: 'high' }).applyTextRuntimeProfile(body(), { temperature: 0.2 });
    expect(wireOf(out)).toEqual(byName('on-effort').posture);
  });

  it('`engine-default` is the `absent` case — nothing is synthesized', async () => {
    const out = await build({ value: 'engine-default' }).applyTextRuntimeProfile(body(), { temperature: 0.2 });
    expect(wireOf(out)).toBeNull();
  });

  it('an unwired settings facade is the `absent` case too', async () => {
    expect(wireOf(await buildUnwired().applyTextRuntimeProfile(body(), { temperature: 0.2 }))).toBeNull();
  });

  it('cannot reach `on-unspecified` — the platform vocabulary has no "reason, budget unnamed"', async () => {
    // Not a gap: that case exists for an AGENT that asked to reason without naming a budget.
    // A platform tier that could say it would be inventing a tenant's spend for every
    // unprofiled call, which is precisely what the agent tier refuses to do.
    for (const value of ['minimal', 'low', 'medium', 'high', 'engine-default']) {
      const out = await build({ value }).applyTextRuntimeProfile(body(), { temperature: 0.2 });
      expect(wireOf(out), value).not.toEqual(byName('on-unspecified').posture);
    }
  });
});

describe('TASK-970 — CALLER WINS, exactly as before', () => {
  it('a caller that pinned the raw ride-along is not second-guessed, and gets no competing posture', async () => {
    // `extra.reasoning_effort` remains supported (fixture `wire.caller_override`). Emitting a
    // posture beside it would put two instructions on one wire — and on an `effort-only`
    // adapter both render to the SAME key, so which one won would be an ordering accident.
    const target: Body = { ...body(), extra: { reasoning_effort: 'high' } };
    const out = await build({ value: 'minimal' }).applyTextRuntimeProfile(target, { reasoning: { enabled: false } });
    expect(out.extra).toEqual({ reasoning_effort: 'high' });
    expect(wireOf(out)).toBeNull();
  });

  it('a caller that already stated the posture itself keeps it', async () => {
    const target: Body = { ...body(), reasoning: { enabled: true, effort: 'high' } };
    const out = await build({ value: 'minimal' }).applyTextRuntimeProfile(target, { reasoning: { enabled: false } });
    expect(wireOf(out)).toEqual(byName('on-effort').posture);
  });

  it('an unrelated `extra` ride-along survives untouched beside the posture', async () => {
    const target: Body = { ...body(), extra: { ttl: 900 } };
    const out = await build({ value: 'minimal' }).applyTextRuntimeProfile(target, { temperature: 0.2 });
    expect(out.extra).toEqual({ ttl: 900 });
    expect(wireOf(out)).toEqual(byName('off').posture);
  });
});
