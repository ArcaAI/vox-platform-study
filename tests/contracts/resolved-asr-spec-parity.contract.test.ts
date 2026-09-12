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
/**
 * TASK-880 — `metadata` is present only when the row declares decode geometry.
 * TASK-944 (B2) — `libraryName` is omit-when-absent for the same reason `metadata` is:
 * both halves are strict about unknown keys, so a field added on one side first has to
 * be able to be missing on the other. It IS present on every model in this fixture,
 * asserted separately below — the loader-selection field going missing is the defect.
 */
const OPTIONAL_MODEL_FIELDS = ['metadata', 'libraryName'];

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

  it('carries the loader-selection library on every model, and omits it rather than nulling it (TASK-944)', () => {
    // `apps/stt` selects its loader with `libraryName` — `format` has been descriptive
    // since TASK-860. Selecting on `format` is what routed the pyannote/speechbrain
    // embedders and the two package-resident denoisers (all `PYTORCH`) to `transformers`,
    // which cannot read them. The gateway is the only half that KNOWS the library, so if
    // it stops sending it, `apps/stt` silently falls back to the key that caused the bug.
    for (const [name, { expected }] of cases) {
      for (const [role, model] of Object.entries(expected.models)) {
        expect(model.libraryName, `${name}.models.${role}`).toBeTruthy();
      }
      for (const [role, model] of Object.entries(expected.fallback.spec?.models ?? {})) {
        expect(model.libraryName, `${name}.fallback.models.${role}`).toBeTruthy();
      }
    }
    // Omit-when-absent, like `metadata`: an input row with no library must not produce a
    // `libraryName: null` key, which the strict pydantic half would reject outright.
    const stripped = structuredClone(fixture.platformDefault as FixtureCase).input;
    for (const model of stripped.agent.models) delete (model as { libraryName?: string }).libraryName;
    for (const model of Object.values(buildResolvedAsrSpec(stripped).models)) {
      expect(model).not.toHaveProperty('libraryName');
    }
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

  it('carries the agent-owned VAD padding, and omits it when the agent set none (TASK-880)', () => {
    // `stt.vad.speechPadMs` was a platform number beside three knobs the agent already
    // owned (`threshold`, `minSpeechMs`, `minSilenceMs`). It is the fourth now, and it
    // follows the omit-when-absent rule the other TASK-877/880 additions use.
    expect((fixture.agentOwnedStreamingBehaviour as FixtureCase).expected.audioFrontEnd.vad.speechPadMs).toBe(320);
    expect((fixture.platformDefault as FixtureCase).expected.audioFrontEnd.vad).not.toHaveProperty('speechPadMs');
    expect((fixture.cloudWithAgentFallback as FixtureCase).expected.audioFrontEnd.vad).not.toHaveProperty('speechPadMs');
  });

  it('carries the clinical-vocabulary stage, and its terms only once (TASK-935)', () => {
    // OD-2 (a) — the stage is a per-agent choice, so it rides the wire; OD-5 (a) — its
    // vocabulary is `instruction.hotwords` and NOTHING here, so that a term named for the
    // decoder and a term corrected after it can never be two different lists.
    const wired = fixture.clinicalVocabularyCorrection as FixtureCase;
    expect(wired.expected.postProcessing.lexicon).toEqual({ enabled: true, maxDistance: 0.3 });
    expect(wired.expected.postProcessing.lexicon).not.toHaveProperty('terms');
    expect(wired.expected.instruction.hotwords).toEqual(['ceftriaxone', 'amoxicillin']);
    // The stage is the agent's; the terms came from the model row. Both halves of that
    // split have to survive, which is why this case pins them together.
    expect(wired.expected.decoding.sources).toMatchObject({ hotwords: 'model' });

    // Same omit-when-absent rule as every additive field before it — never `null`.
    for (const name of ['platformDefault', 'cloudWithAgentFallback', 'agentOwnedStreamingBehaviour', 'modelProfileDecodeKnobs']) {
      expect((fixture[name] as FixtureCase).expected.postProcessing).not.toHaveProperty('lexicon');
    }
  });

  it('carries the per-model hotword-prompt switch, and omits it when the row is silent (TASK-946)', () => {
    // OD-1 — appending `instruction.hotwords` to a whisper.cpp decoder prompt is a
    // property of the MODEL, not of the box: on the seeded ml-en fine-tune it is the
    // difference between 100 % and 2 % Latin script on English audio. The row declares
    // it; absence keeps the engine default (OFF).
    const tuned = fixture.modelProfileDecodeKnobs as FixtureCase;
    expect(tuned.expected.decoding.hotwordsInPrompt).toBe(true);
    expect(tuned.expected.decoding.sources).toMatchObject({ hotwordsInPrompt: 'model' });
    // The row's RAW recommendation rides on the model as provenance, beside the value.
    expect(tuned.expected.models.asr.metadata?.decoding?.hotwordsInPrompt).toBe(true);

    // Omit-when-absent, as for every additive field before it. `clinicalVocabularyCorrection`
    // is the load-bearing one: the SAME row, hotwords and all, with no switch — the terms
    // still reach the lexicon stage and the decoder prompt is left alone.
    for (const name of ['platformDefault', 'cloudWithAgentFallback', 'agentOwnedStreamingBehaviour', 'clinicalVocabularyCorrection']) {
      expect((fixture[name] as FixtureCase).expected.decoding).not.toHaveProperty('hotwordsInPrompt');
    }
    const silent = fixture.clinicalVocabularyCorrection as FixtureCase;
    expect(silent.expected.instruction.hotwords).toEqual(['ceftriaxone', 'amoxicillin']);
    expect(silent.expected.postProcessing.lexicon?.enabled).toBe(true);
  });

  it('names the CONNECTION each engine chain authenticates as, and omits all three fields when it names none (TASK-958)', () => {
    // D-4 — a tenant may hold two accounts of one vendor, so the provider id no longer
    // selects a `provider_overrides` entry. The core carries the key the loaders read
    // under; `connectionKey === provider` for a default/platform row, which is what
    // leaves every pre-958 payload byte-identical.
    const twoAccounts = fixture.twoConnectionsOfOneVendor as FixtureCase;
    expect(twoAccounts.expected.connectionKey).toBe('azure-speech');
    expect(twoAccounts.expected.connectionSlug).toBe('azure-speech');
    expect(twoAccounts.expected.connectionId).toBe('c0000001-0000-4000-8000-000000000001');
    // The FALLBACK core names the sibling — the whole point: without a per-core key the
    // failover would re-read the entry of the account that just failed.
    expect(twoAccounts.expected.fallback.spec?.connectionKey).toBe('azure-speech-research');
    expect(twoAccounts.expected.fallback.spec?.connectionId).toBe('c0000002-0000-4000-8000-000000000002');
    expect(twoAccounts.expected.fallback.spec?.connectionKey).not.toBe(twoAccounts.expected.connectionKey);

    // Omit-when-absent, like every additive field before it: `apps/stt`'s mirror is
    // `extra='forbid'` and reads an absent key as "no connection named", so a `null`
    // would be a second encoding of that state.
    for (const name of ['platformDefault', 'cloudWithAgentFallback', 'agentOwnedStreamingBehaviour', 'modelProfileDecodeKnobs', 'clinicalVocabularyCorrection']) {
      const { expected } = fixture[name] as FixtureCase;
      for (const field of ['connectionId', 'connectionSlug', 'connectionKey']) {
        expect(expected, `${name}.${field}`).not.toHaveProperty(field);
        if (expected.fallback.spec) expect(expected.fallback.spec, `${name}.fallback.${field}`).not.toHaveProperty(field);
      }
    }
  });

  it('carries no credential material anywhere', () => {
    const json = JSON.stringify(fixture);
    // The INPUT deliberately carries a provider override; the EXPECTED specs must not.
    for (const [, { expected }] of cases) expect(JSON.stringify(expected)).not.toMatch(/api_key|apiKey|secret/i);
    expect(json).toContain('provider_overrides'); // the $comment records where credentials travel instead
  });
});
