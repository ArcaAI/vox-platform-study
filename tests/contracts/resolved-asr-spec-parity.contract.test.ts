/**
 * TASK-861 — ResolvedAsrSpec cross-language parity (TypeScript half).
 *
 * The gateway PRODUCES the spec (`buildResolvedAsrSpec`, @arcaai/applications) and
 * `apps/stt` CONSUMES it (`stt.pipeline.spec`, pydantic). Both halves read the SAME
 * committed fixture — `resolved-asr-spec.fixture.json` — so a shape change one side
 * makes fails the other: the Python half is
 * `apps/stt/tests/unit/test_resolved_spec_parity.py`.
 *
 * This file asserts the producer side: the builder's output IS the fixture, and the
 * fixture honours the structural invariants `@arcaai/types` declares (schema version,
 * role vocabulary, the per-model fields the STT loader needs, no credentials).
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
// Everything comes through @arcaai/applications: the root workspace has no @arcaai/types
// dependency, and the applications barrel re-exports the contract for exactly this reason.
import { ASR_SPEC_MODEL_ROLES, ASR_SPEC_ROLE_TASK_TYPE, RESOLVED_ASR_SPEC_SCHEMA_VERSION, buildResolvedAsrSpec } from '@arcaai/applications';
import type { AsrSpecCore, ResolvedAgent, ResolvedAsrSpec } from '@arcaai/applications';

interface FixtureCase {
  input: { agent: ResolvedAgent; fallbackAgent: ResolvedAgent | null };
  expected: ResolvedAsrSpec;
}

const fixture = JSON.parse(readFileSync(join(__dirname, 'resolved-asr-spec.fixture.json'), 'utf-8')) as Record<string, FixtureCase | string>;
const cases = Object.entries(fixture).filter((entry): entry is [string, FixtureCase] => typeof entry[1] === 'object');

const MODEL_FIELDS = ['role', 'slug', 'taskType', 'format', 'sourceUri', 'sourceRevision', 'localPath', 'checksum', 'computeType', 'provider', 'tenantId'];
/** TASK-880 — `metadata` is the one OPTIONAL member: present only when the row declares geometry. */
const OPTIONAL_MODEL_FIELDS = ['metadata'];

function assertCore(core: AsrSpecCore): void {
  expect(core.runtimeKey.length).toBeGreaterThan(0);
  expect(core.models.asr.role).toBe('asr');
  for (const [role, model] of Object.entries(core.models)) {
    expect(ASR_SPEC_MODEL_ROLES).toContain(role);
    expect(model.role).toBe(role);
    expect(model.taskType).toBe(ASR_SPEC_ROLE_TASK_TYPE[model.role]);
    const keys = Object.keys(model);
    expect(keys.filter((k) => !OPTIONAL_MODEL_FIELDS.includes(k)).sort()).toEqual([...MODEL_FIELDS].sort());
    expect(keys.filter((k) => !MODEL_FIELDS.includes(k) && !OPTIONAL_MODEL_FIELDS.includes(k))).toEqual([]);
  }
}

describe('ResolvedAsrSpec parity — producer half', () => {
  it('the fixture declares at least the platform-default and the cloud/agent-fallback cases', () => {
    expect(cases.map(([name]) => name)).toEqual(expect.arrayContaining(['platformDefault', 'cloudWithAgentFallback']));
  });

  it.each(cases)('%s: buildResolvedAsrSpec(input) deep-equals expected', (_name, { input, expected }) => {
    expect(buildResolvedAsrSpec(input)).toEqual(expected);
  });

  it.each(cases)('%s: expected honours the @arcaai/types invariants', (_name, { expected }) => {
    expect(expected.schemaVersion).toBe(RESOLVED_ASR_SPEC_SCHEMA_VERSION);
    assertCore(expected);
    expect(['none', 'agent', 'model']).toContain(expected.fallback.kind);
    if (expected.fallback.spec) {
      assertCore(expected.fallback.spec);
      expect(expected.fallback.spec.runtimeKey).not.toBe(expected.runtimeKey);
    } else {
      expect(expected.fallback.kind).toBe('none');
    }
  });

  it('omits the additive TASK-877 fields rather than emitting null when the agent set none', () => {
    // `apps/stt`'s mirror is `extra='forbid'`, so a key it has not learned yet is a
    // contract drift. Omitting an unset optional — instead of writing `null` — is what
    // lets the two halves ship in either order, and it is asserted here rather than
    // left to the deep-equal above, which would pass just as happily on `null`.
    const untouched = fixture.platformDefault as FixtureCase;
    expect(untouched.expected.decoding).not.toHaveProperty('chunkLengthSec');
    expect(untouched.expected.decoding).not.toHaveProperty('strideLengthSec');
    expect(untouched.expected.streaming).not.toHaveProperty('semantic');
    expect(untouched.expected.models).not.toHaveProperty('endpointing');

    // …and carries them, in full, when it did.
    const wired = fixture.agentOwnedStreamingBehaviour as FixtureCase;
    expect(wired.expected.decoding.chunkLengthSec).toBe(20);
    expect(wired.expected.decoding.strideLengthSec).toEqual([5, 3]);
    expect(wired.expected.streaming.semantic).toEqual({ minSilenceMs: 240, maxSilenceMs: 600, confidenceThreshold: 0.9, minWords: 5 });
    expect(wired.expected.streaming.endpointing).toBe('semantic');
    expect(wired.expected.models.endpointing?.slug).toBe('smart-turn-v3');
    expect(wired.expected.models.endpointing?.taskType).toBe(ASR_SPEC_ROLE_TASK_TYPE.endpointing);
  });

  it('carries AiModel._metadata.asr per CHAIN, and omits it on a row that declares none (TASK-880)', () => {
    // The geometry that used to be `stt.whisperCpp.maxAudioSeconds` and
    // `stt.streaming.partialWindowS` — one number for every engine on the box — now belongs
    // to the row, so the fallback's window is its own rather than the primary's.
    const platform = fixture.platformDefault as FixtureCase;
    expect(platform.expected.models.asr.metadata).toEqual({ maxDecodeWindowSec: 7, partialWindowSec: 6 });
    expect(platform.expected.fallback.spec?.models.asr.metadata).toEqual({ maxDecodeWindowSec: 30 });
    // Same omit-when-absent rule as the other additive fields: never `null`, never `{}`.
    expect(platform.expected.models.vad).not.toHaveProperty('metadata');
    expect((fixture.cloudWithAgentFallback as FixtureCase).expected.models.asr).not.toHaveProperty('metadata');
  });

  it('carries no credential material anywhere', () => {
    const json = JSON.stringify(fixture);
    // The INPUT deliberately carries a provider override; the EXPECTED specs must not.
    for (const [, { expected }] of cases) expect(JSON.stringify(expected)).not.toMatch(/api_key|apiKey|secret/i);
    expect(json).toContain('provider_overrides'); // the $comment records where credentials travel instead
  });
});
