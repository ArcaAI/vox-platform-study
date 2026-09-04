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

function assertCore(core: AsrSpecCore): void {
  expect(core.runtimeKey.length).toBeGreaterThan(0);
  expect(core.models.asr.role).toBe('asr');
  for (const [role, model] of Object.entries(core.models)) {
    expect(ASR_SPEC_MODEL_ROLES).toContain(role);
    expect(model.role).toBe(role);
    expect(model.taskType).toBe(ASR_SPEC_ROLE_TASK_TYPE[model.role]);
    expect(Object.keys(model).sort()).toEqual([...MODEL_FIELDS].sort());
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

  it('carries no credential material anywhere', () => {
    const json = JSON.stringify(fixture);
    // The INPUT deliberately carries a provider override; the EXPECTED specs must not.
    for (const [, { expected }] of cases) expect(JSON.stringify(expected)).not.toMatch(/api_key|apiKey|secret/i);
    expect(json).toContain('provider_overrides'); // the $comment records where credentials travel instead
  });
});
