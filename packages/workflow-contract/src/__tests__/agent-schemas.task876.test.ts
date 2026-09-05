/**
 * TASK-876 — the agent contract additions of wave 2 (TASK-870 program).
 *
 * (a) TEXT_GENERATION gains the `fallback` block SPEECH_TO_TEXT already carries, and the
 *     governance defaults are DECLARED on the contract (`AGENT_FALLBACK_DEFAULTS`) rather than
 *     re-typed by each runtime builder — fallback is a platform HA capability, on by default,
 *     and the toggle is per agent node. `switchAfterConsecutiveFailures` is SPEECH_TO_TEXT ONLY:
 *     both text lanes are per-call and switch on the first failure, so on TEXT_GENERATION it
 *     would be a validated, tenant-settable knob with no reader (owner rule: no dead knobs).
 * (b) For TASK-877, SPEECH_TO_TEXT gains `decoding.{chunkLengthSec,strideLengthSec}` (owner
 *     decision #9), a `streaming.semantic` block, and the `endpointing` model reference the
 *     end-of-utterance runtime resolves by registry slug — declared here, materialised there.
 */
import { jsonSchemaValueProblems } from '@arcaai/json-schema-subset';
import { describe, expect, it } from 'vitest';
import {
  AGENT_FALLBACK_DEFAULTS,
  AGENT_PARAMETER_SCHEMAS,
  ASR_ENDPOINTING_MODEL_SLUG_PATH,
  agentConfigProblems,
  readAgentFallbackGovernance,
} from '../agent-schemas';
import { forbiddenSchemaKeyProblems } from '../agentic-contract';

const TEXT = AGENT_PARAMETER_SCHEMAS.TEXT_GENERATION;
const ASR = AGENT_PARAMETER_SCHEMAS.SPEECH_TO_TEXT;

const props = (schema: unknown, ...path: string[]): Record<string, unknown> => {
  let cursor = schema as Record<string, unknown>;
  for (const key of path) {
    cursor = (cursor.properties as Record<string, Record<string, unknown>>)[key];
    if (cursor === undefined) throw new Error(`no property ${path.join('.')}`);
  }
  return cursor;
};

describe('TASK-876 — fallback governance is declared ONCE on the contract', () => {
  it('names the two defaults every runtime builder must read', () => {
    expect(AGENT_FALLBACK_DEFAULTS).toEqual({ autoSwitch: true, switchAfterConsecutiveFailures: 2 });
    expect(Object.isFrozen(AGENT_FALLBACK_DEFAULTS)).toBe(true);
  });

  it.each(['TEXT_GENERATION', 'SPEECH_TO_TEXT'] as const)('%s carries the fallback block with the defaults on the schema', (task) => {
    const fallback = props(AGENT_PARAMETER_SCHEMAS[task], 'fallback');
    expect(fallback).toMatchObject({ type: 'object', additionalProperties: false });
    expect(props(AGENT_PARAMETER_SCHEMAS[task], 'fallback', 'autoSwitch')).toMatchObject({ type: 'boolean', default: true });
    // The fallback agent is a LINEAGE SLUG of the same task — a reference, never a model id.
    expect(String(props(AGENT_PARAMETER_SCHEMAS[task], 'fallback', 'agentSlug').description)).toContain(task);
  });

  // A threshold needs a runtime that COUNTS across calls. `stt/streaming/session_manager.py` is
  // one; both TEXT lanes are per-call. A knob with no reader is a dead knob.
  it('declares switchAfterConsecutiveFailures on SPEECH_TO_TEXT ONLY', () => {
    expect(Object.keys(props(ASR, 'fallback').properties as object).sort()).toEqual(['agentSlug', 'autoSwitch', 'switchAfterConsecutiveFailures']);
    expect(props(ASR, 'fallback', 'switchAfterConsecutiveFailures')).toMatchObject({ type: 'integer', minimum: 1, maximum: 20, default: 2 });
    expect(Object.keys(props(TEXT, 'fallback').properties as object).sort()).toEqual(['agentSlug', 'autoSwitch']);
    // `additionalProperties: false` therefore REFUSES it on a TEXT_GENERATION agent.
    expect(jsonSchemaValueProblems(TEXT, { generation: {}, fallback: { switchAfterConsecutiveFailures: 3 } }, 'parameters')).not.toEqual([]);
  });

  it('readAgentFallbackGovernance applies the declared defaults to an absent / partial / present block', () => {
    expect(readAgentFallbackGovernance(undefined)).toEqual({ agentSlug: null, autoSwitch: true });
    expect(readAgentFallbackGovernance({})).toEqual({ agentSlug: null, autoSwitch: true });
    expect(readAgentFallbackGovernance({ fallback: { autoSwitch: false } })).toEqual({ agentSlug: null, autoSwitch: false });
    expect(readAgentFallbackGovernance({ fallback: { agentSlug: 'platform-summarization' } })).toEqual({
      agentSlug: 'platform-summarization',
      autoSwitch: true,
    });
    // A malformed block reads as the defaults — the schema is where a bad shape is refused.
    expect(readAgentFallbackGovernance({ fallback: 'nope' })).toEqual({ agentSlug: null, autoSwitch: true });
    expect(readAgentFallbackGovernance({ fallback: { agentSlug: '', autoSwitch: 'yes' } })).toEqual({ agentSlug: null, autoSwitch: true });
  });
});

describe('TASK-876 — TEXT_GENERATION fallback block', () => {
  const base = { generation: { temperature: 0.2, maxTokens: 1024 }, responseFormat: 'text' };

  it('accepts a fallback agent slug with the governance knobs', () => {
    const value = { ...base, fallback: { agentSlug: 'platform-summarization', autoSwitch: true } };
    expect(jsonSchemaValueProblems(TEXT, value, 'parameters')).toEqual([]);
    expect(agentConfigProblems({ task: 'TEXT_GENERATION', parameters: value, instruction: { systemPrompt: 'x' } })).toEqual([]);
  });

  it('accepts the toggle alone (the per-node HA switch a tenant admin flips)', () => {
    expect(jsonSchemaValueProblems(TEXT, { ...base, fallback: { autoSwitch: false } }, 'parameters')).toEqual([]);
  });

  it('refuses a stray key inside the block and a non-slug reference', () => {
    expect(jsonSchemaValueProblems(TEXT, { ...base, fallback: { provider: 'azure' } }, 'parameters')).not.toEqual([]);
    expect(jsonSchemaValueProblems(TEXT, { ...base, fallback: { agentSlug: 'x' } }, 'parameters')).not.toEqual([]);
    // The ASR block still enforces the threshold's bounds where it IS declared.
    expect(jsonSchemaValueProblems(ASR, { fallback: { switchAfterConsecutiveFailures: 0 } }, 'parameters')).not.toEqual([]);
  });

  it('keeps the reference-only rule (no credential / endpoint / wire-model property anywhere)', () => {
    expect(forbiddenSchemaKeyProblems(AGENT_PARAMETER_SCHEMAS)).toEqual([]);
    expect(TEXT.additionalProperties).toBe(false);
  });
});

describe('TASK-876 — SPEECH_TO_TEXT additions for TASK-877', () => {
  it('decoding gains chunkLengthSec and a strideLengthSec PAIR (owner decision #9)', () => {
    expect(props(ASR, 'decoding', 'chunkLengthSec')).toMatchObject({ type: 'number', minimum: 1, maximum: 60 });
    // TASK-880 corrected `strideLengthSec` from a scalar to the `[left, right]` PAIR the
    // wire field (`AsrSpecDecoding.strideLengthSec`), `buildResolvedAsrSpec`'s `pair()`
    // reader and the committed contract fixture have always used. As a `number` it was a
    // value an agent could author and the runtime could never consume.
    expect(props(ASR, 'decoding', 'strideLengthSec')).toMatchObject({ type: 'array', minItems: 2, maxItems: 2 });
    expect(jsonSchemaValueProblems(ASR, { decoding: { chunkLengthSec: 30, strideLengthSec: [4, 2] } }, 'parameters')).toEqual([]);
    expect(jsonSchemaValueProblems(ASR, { decoding: { chunkLengthSec: 0 } }, 'parameters')).not.toEqual([]);
    expect(jsonSchemaValueProblems(ASR, { decoding: { strideLengthSec: 5 } }, 'parameters')).not.toEqual([]);
    expect(jsonSchemaValueProblems(ASR, { decoding: { strideLengthSec: [4] } }, 'parameters')).not.toEqual([]);
    expect(jsonSchemaValueProblems(ASR, { decoding: { strideLengthSec: [4, 31] } }, 'parameters')).not.toEqual([]);
    // Still closed: the existing `additionalProperties: false` on `decoding` is preserved.
    expect(jsonSchemaValueProblems(ASR, { decoding: { chunkLength: 30 } }, 'parameters')).not.toEqual([]);
  });

  it('audioFrontEnd.vad gains speechPadMs, the fourth agent-owned VAD knob (TASK-880)', () => {
    // `stt.vad.speechPadMs` was a platform key beside `threshold` / `minSpeechMs` /
    // `minSilenceMs`, which the agent has owned since TASK-861.
    expect(props(ASR, 'audioFrontEnd', 'vad', 'speechPadMs')).toMatchObject({ type: 'integer', minimum: 0, maximum: 5000 });
    expect(jsonSchemaValueProblems(ASR, { audioFrontEnd: { vad: { speechPadMs: 200 } } }, 'parameters')).toEqual([]);
    expect(jsonSchemaValueProblems(ASR, { audioFrontEnd: { vad: { speechPadMs: 5001 } } }, 'parameters')).not.toEqual([]);
    expect(jsonSchemaValueProblems(ASR, { audioFrontEnd: { vad: { speechPadMs: 200.5 } } }, 'parameters')).not.toEqual([]);
  });

  it('streaming gains a closed `semantic` block and the endpointing model reference', () => {
    const semantic = props(ASR, 'streaming', 'semantic');
    expect(semantic).toMatchObject({ type: 'object', additionalProperties: false });
    expect(Object.keys(semantic.properties as object).sort()).toEqual([
      'confidenceThreshold',
      'maxSilenceMs',
      'minSilenceMs',
      'minWords',
      'modelSlug',
    ]);
    expect(props(ASR, 'streaming', 'semantic', 'minSilenceMs')).toMatchObject({ type: 'integer', minimum: 0, maximum: 10000 });
    expect(props(ASR, 'streaming', 'semantic', 'maxSilenceMs')).toMatchObject({ type: 'integer', minimum: 0, maximum: 30000 });
    expect(props(ASR, 'streaming', 'semantic', 'confidenceThreshold')).toMatchObject({ type: 'number', minimum: 0, maximum: 1 });
    expect(props(ASR, 'streaming', 'semantic', 'minWords')).toMatchObject({ type: 'integer', minimum: 0, maximum: 64 });
    // The end-of-utterance model is a registry SLUG, exactly like every other ASR auxiliary.
    expect(props(ASR, 'streaming', 'semantic', 'modelSlug')).toMatchObject({ type: 'string', pattern: '^[a-z0-9][a-z0-9._-]{0,127}$' });
    expect(String(props(ASR, 'streaming', 'semantic', 'modelSlug').description)).toContain('endpointing');
    expect(ASR_ENDPOINTING_MODEL_SLUG_PATH).toEqual(['streaming', 'semantic', 'modelSlug']);

    expect(
      jsonSchemaValueProblems(
        ASR,
        {
          streaming: {
            partialIntervalMs: 500,
            endpointing: 'semantic',
            semantic: { minSilenceMs: 300, maxSilenceMs: 2000, confidenceThreshold: 0.7, minWords: 3, modelSlug: 'eou-classifier' },
          },
        },
        'parameters',
      ),
    ).toEqual([]);
    expect(jsonSchemaValueProblems(ASR, { streaming: { semantic: { threshold: 0.5 } } }, 'parameters')).not.toEqual([]);
  });

  it('the existing ASR fixture of TASK-863 still validates unchanged (additive only)', () => {
    const value = {
      audioFrontEnd: {
        vad: { modelSlug: 'silero-vad', threshold: 0.5 },
        diarization: { enabled: true, backend: 'embedding', embeddingModelSlug: 'ecapa' },
      },
      decoding: { languageMode: 'ml-en', wordTimestamps: true, beamSize: 5 },
      streaming: { partialIntervalMs: 500, endpointing: 'semantic' },
      fallback: { autoSwitch: true, switchAfterConsecutiveFailures: 3 },
    };
    expect(jsonSchemaValueProblems(ASR, value, 'parameters')).toEqual([]);
  });
});
