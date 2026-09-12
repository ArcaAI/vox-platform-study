/**
 * TASK-879 — ResolvedTtsSpec cross-language parity (TypeScript half).
 *
 * The gateway PRODUCES the spec (`buildResolvedTtsSpec`, @arcaai/applications) and `apps/tts`
 * CONSUMES it (`tts.spec`, pydantic). Both halves read the SAME committed fixture —
 * `resolved-tts-spec.fixture.json` — so a shape change on one side fails the other: the Python
 * half is `apps/tts/src/tts/tests/unit/test_resolved_spec_parity.py`.
 *
 * This file asserts the producer side: the builder's output IS the fixture, and the fixture
 * honours the structural invariants `@arcaai/types` declares (schema version, role vocabulary,
 * the per-model fields the loaders need, distinct runtime keys, no credentials).
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
// Everything comes through @arcaai/applications: the root workspace has no @arcaai/types
// dependency, and the applications barrel re-exports the contract for exactly this reason.
import { RESOLVED_TTS_SPEC_SCHEMA_VERSION, TTS_SPEC_MODEL_ROLES, TTS_SPEC_MODEL_TASK_TYPE, buildResolvedTtsSpec } from '@arcaai/applications';
import type { BuildResolvedTtsSpecInput, ResolvedTtsCandidate, ResolvedTtsSpec } from '@arcaai/applications';

interface FixtureCase {
  input: BuildResolvedTtsSpecInput;
  expected: ResolvedTtsSpec;
}

const fixture = JSON.parse(readFileSync(join(__dirname, 'resolved-tts-spec.fixture.json'), 'utf-8')) as Record<string, FixtureCase | string>;
const cases = Object.entries(fixture).filter((entry): entry is [string, FixtureCase] => typeof entry[1] === 'object');

const MODEL_FIELDS = [
  'role',
  'slug',
  'taskType',
  'format',
  'sourceUri',
  'sourceRevision',
  'localPath',
  'checksum',
  'computeType',
  'provider',
  'tenantId',
  'artifacts',
  'voices',
];
const VOICE_FIELDS = ['id', 'locale', 'providerVoice', 'refAudioPath', 'refText'];
const CANDIDATE_KINDS = ['primary', 'fallback-agent', 'fallback-model', 'platform-default'];

function assertCandidate(candidate: ResolvedTtsCandidate): void {
  expect(CANDIDATE_KINDS).toContain(candidate.kind);
  expect(candidate.runtimeKey.length).toBeGreaterThan(0);
  expect(TTS_SPEC_MODEL_ROLES).toContain(candidate.model.role);
  expect(candidate.model.taskType).toBe(TTS_SPEC_MODEL_TASK_TYPE);
  expect(Object.keys(candidate.model).sort()).toEqual([...MODEL_FIELDS].sort());
  for (const voice of candidate.model.voices) expect(Object.keys(voice).sort()).toEqual([...VOICE_FIELDS].sort());
  // The selected voice is always one of the bound model's own bindings — never a name invented
  // beside the catalogue.
  if (candidate.voice) expect(candidate.model.voices.map((v) => v.id)).toContain(candidate.voice.id);
  expect(['tenant', 'platform']).toContain(candidate.fundingTier);
  if (candidate.connection) {
    expect(candidate.connection.provider).toBe(candidate.model.provider);
    expect(candidate.connection.funding).toBe(candidate.fundingTier);
  }
}

describe('ResolvedTtsSpec parity — producer half', () => {
  it('the fixture declares the platform-default, the agent-fallback and the model-chain cases', () => {
    expect(cases.map(([name]) => name)).toEqual(expect.arrayContaining(['platformDefault', 'tenantAgentWithCloudFallback', 'modelChainFallback']));
  });

  it.each(cases)('%s: buildResolvedTtsSpec(input) deep-equals expected', (_name, { input, expected }) => {
    expect(buildResolvedTtsSpec(input)).toEqual(expected);
  });

  it.each(cases)('%s: expected honours the @arcaai/types invariants', (_name, { expected }) => {
    expect(expected.schemaVersion).toBe(RESOLVED_TTS_SPEC_SCHEMA_VERSION);
    expect(expected.primary.kind).toBe('primary');
    expect(expected.agent).toEqual(expected.primary.agent);
    assertCandidate(expected.primary);

    const keys = new Set([expected.primary.runtimeKey]);
    for (const candidate of expected.fallback.chain) {
      assertCandidate(candidate);
      // A switch that reuses the primary's runtime key is invisible to metrics and metering.
      expect(keys.has(candidate.runtimeKey)).toBe(false);
      keys.add(candidate.runtimeKey);
    }
  });

  it('names the CONNECTION a candidate spends, and omits all three fields when it names none (TASK-958)', () => {
    // D-4 — two candidates of one vendor share a provider NAME, so `connectionKey` is
    // the only thing that can select their credential apart. `connectionKey === engine`
    // for a default/platform row, which leaves every pre-958 payload byte-identical.
    const twoAccounts = fixture.twoConnectionsOfOneVendor as FixtureCase;
    expect(twoAccounts.expected.primary.connectionKey).toBe('azure');
    expect(twoAccounts.expected.primary.connection?.connectionId).toBe('c0000001-0000-4000-8000-00000000000a');
    expect(twoAccounts.expected.fallback.chain).toHaveLength(1);
    expect(twoAccounts.expected.fallback.chain[0].connectionKey).toBe('azure-research');
    expect(twoAccounts.expected.fallback.chain[0].connection?.connectionSlug).toBe('azure-research');

    // Omit-when-absent: `tts.spec` is `extra='forbid'` and lists these in OPTIONAL_FIELDS.
    for (const name of ['platformDefault', 'tenantAgentWithCloudFallback', 'modelChainFallback']) {
      const { expected } = fixture[name] as FixtureCase;
      for (const candidate of [expected.primary, ...expected.fallback.chain]) {
        expect(candidate, `${name}.${candidate.runtimeKey}`).not.toHaveProperty('connectionKey');
        if (candidate.connection) {
          expect(candidate.connection).not.toHaveProperty('connectionId');
          expect(candidate.connection).not.toHaveProperty('connectionSlug');
        }
      }
    }
  });

  it('carries no credential material anywhere', () => {
    // One INPUT deliberately carries a resolved `providerOverride`; no `expected` spec may echo it.
    for (const [, { expected }] of cases) expect(JSON.stringify(expected)).not.toMatch(/api_key|apiKey|secret/i);
    expect(JSON.stringify(fixture)).toContain('provider_overrides');
  });
});
