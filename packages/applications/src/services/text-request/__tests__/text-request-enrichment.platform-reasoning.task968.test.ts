/**
 * TASK-968 — the PLATFORM tier of the reasoning cascade.
 *
 * TASK-891 OD-4 put the posture on the agent and gave the cascade exactly one tier, so an
 * agent that authored nothing resolved to the ENGINE's default — 5168 ms / 184 reasoning
 * tokens against 1237 ms / 30 at `minimal` on `gemma-4-e2b-it-qat`. Enforcing the directive
 * then meant authoring a block on every agent that will ever exist, on every tenant, forever.
 *
 * `text.reasoning.defaultEffort` is the second tier:
 *
 *     the agent's authored block  →  the platform default  →  nothing
 *
 * The load-bearing half of these tests is the NEGATIVE one: the platform tier fills ABSENCE
 * and never answers over an agent that has an opinion.
 *
 * The REAL `EffectiveSettingsService` and the REAL registry are used — a stubbed resolver
 * would assert nothing about the descriptor's declared default or its `failMode`.
 */
import { describe, expect, it, vi } from 'vitest';
import { TextRequestEnrichmentService } from '../text-request-enrichment.service';
import { EffectiveSettingsService } from '../../settings-registry/effective-settings.service';

const TENANT = 'tenant-1';

const cls = () => ({ get: vi.fn().mockReturnValue(TENANT) });

/**
 * `settings` undefined ⇒ the facade is present but its `global-kv` backend is not, so
 * `resolveEffective` applies the descriptor's declared `failMode` — which is how the DEFAULT
 * below is proven to be the registry's and not this test's.
 */
function build(settings?: { value: unknown; source?: string } | Error) {
  const tenantSettings =
    settings === undefined
      ? undefined
      : {
          resolve: vi.fn(() => {
            if (settings instanceof Error) throw settings;
            return { value: settings.value, source: settings.source ?? 'system' };
          }),
        };
  return new TextRequestEnrichmentService(
    cls() as never,
    undefined, // aiProviderConnectionService
    new EffectiveSettingsService(tenantSettings as never) as never,
  );
}

/** No settings facade at all — every positional fixture in the repo, and the pre-TASK-968 shape. */
const buildUnwired = () => new TextRequestEnrichmentService(cls() as never, undefined, undefined);

const body = () => ({ provider: 'lm-studio', model: 'gemma' }) as { provider?: string; model?: string; extra?: Record<string, unknown> };

describe('TASK-968 — an agent that authored NO posture gets the platform default', () => {
  it('falls back to the registry default, which is reasoning off', async () => {
    const out = await build().applyTextRuntimeProfile(body(), { temperature: 0.2 });
    expect(out.extra).toEqual({ reasoning_effort: 'minimal' });
  });

  it('applies a platform row the admin wrote', async () => {
    const out = await build({ value: 'high' }).applyTextRuntimeProfile(body(), { temperature: 0.2 });
    expect(out.extra).toEqual({ reasoning_effort: 'high' });
  });

  it('a caller that passed no `generation` at all is the same absence', async () => {
    const out = await build({ value: 'medium' }).applyTextRuntimeProfile(body());
    expect(out.extra).toEqual({ reasoning_effort: 'medium' });
  });

  it('`engine-default` hands the decision back to the engine — the removed state, kept as a DECISION', async () => {
    const out = await build({ value: 'engine-default' }).applyTextRuntimeProfile(body(), { temperature: 0.2 });
    expect(Object.keys(out)).not.toContain('extra');
  });
});

describe('TASK-968 — the platform tier fills ABSENCE and never answers over an opinion', () => {
  it('an agent that disabled reasoning wins over a platform default of `high`', async () => {
    const out = await build({ value: 'high' }).applyTextRuntimeProfile(body(), { reasoning: { enabled: false } });
    expect(out.extra).toEqual({ reasoning_effort: 'minimal' });
  });

  it('an agent that named an effort wins over the platform default', async () => {
    const out = await build({ value: 'high' }).applyTextRuntimeProfile(body(), { reasoning: { enabled: true, effort: 'low' } });
    expect(out.extra).toEqual({ reasoning_effort: 'low' });
  });

  it('an agent that asked to reason without naming a budget still sends nothing', async () => {
    // NOT a widening case. The agent stated a posture; answering `minimal` over an explicit
    // "reason" would invert the cascade rather than complete it.
    const out = await build({ value: 'minimal' }).applyTextRuntimeProfile(body(), { reasoning: { enabled: true } });
    expect(Object.keys(out)).not.toContain('extra');
  });

  it('the CALLER still wins per key, as it did over the agent tier', async () => {
    const target = { ...body(), extra: { reasoning_effort: 'high' } };
    const out = await build({ value: 'minimal' }).applyTextRuntimeProfile(target, { temperature: 0.2 });
    expect(out.extra).toEqual({ reasoning_effort: 'high' });
  });
});

describe('TASK-968 — degradation never fails a consultation over a hyper-parameter', () => {
  it('no settings facade ⇒ exactly the pre-TASK-968 behaviour', async () => {
    const out = await buildUnwired().applyTextRuntimeProfile(body(), { temperature: 0.2 });
    expect(Object.keys(out)).not.toContain('extra');
  });

  it('a resolve that throws is logged and the call proceeds', async () => {
    const out = await build(new Error('settings backend down')).applyTextRuntimeProfile(body(), { temperature: 0.2 });
    expect(Object.keys(out)).not.toContain('extra');
  });

  it('a stored value outside the declared vocabulary is REFUSED, not coerced', async () => {
    const out = await build({ value: 'maximum' }).applyTextRuntimeProfile(body(), { temperature: 0.2 });
    expect(Object.keys(out)).not.toContain('extra');
  });

  it('a stored value of the wrong type is refused too', async () => {
    const out = await build({ value: 3 }).applyTextRuntimeProfile(body(), { temperature: 0.2 });
    expect(Object.keys(out)).not.toContain('extra');
  });
});
