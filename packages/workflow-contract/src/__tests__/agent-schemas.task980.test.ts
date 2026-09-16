/**
 * TASK-980 (owner decision 2026-09-16, Option C) — the `sortformer` diarization backend is RETIRED.
 *
 * Its checkpoint was a Python literal no agent could choose, pin or veto, and no deployed image can
 * run it. The `backend` key STAYS on the agent and on the wire (both `extra='forbid'` halves of
 * `ResolvedAsrSpec` require it); only its vocabulary narrows to `embedding`. The schema half: an
 * agent can no longer be SAVED with `backend: 'sortformer'`. Stored agent versions that still say it
 * are refused at resolution (`ASR_AGENT_DIARIZATION_BACKEND_UNSUPPORTED`), never coerced.
 */
import { jsonSchemaValueProblems } from '@arcaai/json-schema-subset';
import { describe, expect, it } from 'vitest';
import { AGENT_PARAMETER_SCHEMAS } from '../agent-schemas';
import { forbiddenSchemaKeyProblems } from '../agentic-contract';

const ASR = AGENT_PARAMETER_SCHEMAS.SPEECH_TO_TEXT;

const backend = (): Record<string, unknown> => {
  const afe = (ASR as { properties: Record<string, { properties: Record<string, { properties: Record<string, unknown> }> }> }).properties
    .audioFrontEnd;
  return afe.properties.diarization.properties.backend as Record<string, unknown>;
};

const withBackend = (value: unknown) => ({ audioFrontEnd: { diarization: { enabled: true, backend: value } } });

describe('TASK-980 — the sortformer diarization backend is retired', () => {
  it('narrows the backend vocabulary to embedding, which stays the default', () => {
    expect(backend()).toMatchObject({ type: 'string', default: 'embedding' });
    expect(backend().enum).toEqual(['embedding']);
  });

  it('says why in the description, so an editor reading the schema learns the backend was retired', () => {
    expect(String(backend().description)).toContain('sortformer');
    expect(String(backend().description)).toContain('TASK-980');
  });

  it('refuses to save an agent that declares backend sortformer', () => {
    expect(jsonSchemaValueProblems(ASR, withBackend('sortformer'), 'parameters')).not.toEqual([]);
  });

  it('still accepts the embedding backend, and an agent that states no backend at all', () => {
    expect(jsonSchemaValueProblems(ASR, withBackend('embedding'), 'parameters')).toEqual([]);
    expect(jsonSchemaValueProblems(ASR, { audioFrontEnd: { diarization: { enabled: true } } }, 'parameters')).toEqual([]);
  });

  it('keeps the reference-only rule clean', () => {
    expect(forbiddenSchemaKeyProblems(AGENT_PARAMETER_SCHEMAS)).toEqual([]);
  });
});
