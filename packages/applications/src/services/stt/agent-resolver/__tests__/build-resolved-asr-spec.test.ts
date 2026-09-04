/**
 * TASK-861 — `buildResolvedAsrSpec()` is the ONE producer of the gateway → apps/stt
 * ASR runtime contract. These tests pin it against the committed cross-language
 * fixture (`tests/contracts/resolved-asr-spec.fixture.json`) and the edge rules the
 * fixture cannot show (no primary model → fail closed; a fallback needs a distinct
 * runtime key).
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { ResolvedAgent, ResolvedAsrSpec } from '@arcaai/types';
import { describe, expect, it } from 'vitest';
import { AsrSpecBuildError, buildResolvedAsrSpec } from '../build-resolved-asr-spec';

interface FixtureCase {
  input: { agent: ResolvedAgent; fallbackAgent: ResolvedAgent | null };
  expected: ResolvedAsrSpec;
}

const FIXTURE_PATH = resolve(__dirname, '../../../../../../../tests/contracts/resolved-asr-spec.fixture.json');
const fixture = JSON.parse(readFileSync(FIXTURE_PATH, 'utf-8')) as Record<string, FixtureCase | string>;
const cases = Object.entries(fixture).filter((entry): entry is [string, FixtureCase] => typeof entry[1] === 'object');

describe('buildResolvedAsrSpec — the committed contract fixture', () => {
  it.each(cases)('%s: produces exactly the expected ResolvedAsrSpec', (_name, { input, expected }) => {
    expect(buildResolvedAsrSpec(input)).toEqual(expected);
  });

  it('never carries credential material, even when the agent resolved a provider override', () => {
    const cloud = fixture.cloudWithAgentFallback as FixtureCase;
    const json = JSON.stringify(buildResolvedAsrSpec(cloud.input));
    expect(json).not.toContain('api_key');
    expect(json).not.toContain('REDACTED-NEVER-IN-SPEC');
  });
});

describe('buildResolvedAsrSpec — rules the fixture cannot show', () => {
  const base = (fixture.platformDefault as FixtureCase).input.agent;

  it('fails closed when the agent resolved no primary model', () => {
    const agent: ResolvedAgent = { ...base, models: base.models.filter((m) => m.role !== 'primary') };
    expect(() => buildResolvedAsrSpec({ agent, fallbackAgent: null })).toThrow(AsrSpecBuildError);
  });

  it('a model-level fallback gets a runtime key distinct from the primary so an engine switch is observable', () => {
    const spec = buildResolvedAsrSpec({ agent: base, fallbackAgent: null });
    expect(spec.fallback.kind).toBe('model');
    expect(spec.fallback.spec?.runtimeKey).not.toBe(spec.runtimeKey);
    expect(spec.fallback.spec?.runtimeKey).toContain(spec.runtimeKey);
  });

  it('with no fallback rows and no fallback agent the spec declares kind none and no target', () => {
    const agent: ResolvedAgent = { ...base, models: base.models.filter((m) => m.role !== 'fallback') };
    const spec = buildResolvedAsrSpec({ agent, fallbackAgent: null });
    expect(spec.fallback).toEqual({ kind: 'none', autoSwitch: true, switchAfterConsecutiveFailures: 2, spec: null });
  });

  it('prefers the lowest-priority enabled fallback row', () => {
    const agent: ResolvedAgent = {
      ...base,
      models: [
        ...base.models,
        { ...base.models[1], role: 'fallback', priority: 5, slug: 'later-fallback' },
        { ...base.models[1], role: 'fallback', priority: -1, slug: 'first-fallback' },
      ],
    };
    expect(buildResolvedAsrSpec({ agent, fallbackAgent: null }).fallback.spec?.models.asr.slug).toBe('first-fallback');
  });

  it('a fallback agent wins over the model chain (parameters.fallback.agentSlug is the explicit choice)', () => {
    const fallbackAgent = (fixture.cloudWithAgentFallback as FixtureCase).input.fallbackAgent as ResolvedAgent;
    const spec = buildResolvedAsrSpec({ agent: base, fallbackAgent });
    expect(spec.fallback.kind).toBe('agent');
    expect(spec.fallback.spec?.runtimeKey).toBe(fallbackAgent.agentVersionId);
  });
});
