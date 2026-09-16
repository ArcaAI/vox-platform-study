/**
 * TASK-887 — diarization is a DECLARED ASR-agent option (owner decision, target model item 8).
 *
 * The agent node owns the whole decision: whether to diarize (OFF by default), which
 * `SPEAKER_EMBEDDING` model defines the vector space, and how confidently an ENROLLED voice
 * profile's label may be attached to a segment. The platform keys that used to hold the last
 * two — `stt.diarization.hfModelId` and `stt.voiceProfile.minSimilarity` — are gone.
 */
import { describe, expect, it } from 'vitest';
import { AGENT_PARAMETER_SCHEMAS } from '../agent-schemas';
import { forbiddenSchemaKeyProblems } from '../agentic-contract';

const props = (schema: unknown, ...path: string[]): Record<string, unknown> => {
  let cursor = schema as Record<string, unknown>;
  for (const key of path) {
    cursor = (cursor.properties as Record<string, Record<string, unknown>>)[key];
    if (cursor === undefined) throw new Error(`no property ${path.join('.')}`);
  }
  return cursor;
};

const diarization = (...path: string[]) => props(AGENT_PARAMETER_SCHEMAS.SPEECH_TO_TEXT, 'audioFrontEnd', 'diarization', ...path);

describe('TASK-887 — the ASR agent declares the diarization space', () => {
  it('exposes exactly the five knobs the runtime acts on', () => {
    expect(Object.keys(diarization().properties as object).sort()).toEqual([
      'backend',
      'embeddingModelSlug',
      'enabled',
      'matchThreshold',
      'maxSpeakers',
    ]);
    expect(diarization()).toMatchObject({ type: 'object', additionalProperties: false });
  });

  it('is OFF by default, on the embedding backend', () => {
    expect(diarization('enabled')).toMatchObject({ type: 'boolean', default: false });
    expect(diarization('backend')).toMatchObject({ type: 'string', default: 'embedding' });
    // TASK-980 retired `sortformer`; `agent-schemas.task980.test.ts` pins why.
    expect(diarization('backend').enum).toEqual(['embedding']);
  });

  it('carries matchThreshold with the retired platform key’s default', () => {
    // `stt.voiceProfile.minSimilarity` defaulted to 0.6; the agent inherits the number so the
    // move is a change of OWNER, not a silent change of behaviour.
    expect(diarization('matchThreshold')).toMatchObject({ type: 'number', minimum: 0, maximum: 1, default: 0.6 });
    expect(String(diarization('matchThreshold').description)).toContain('stt.voiceProfile.minSimilarity');
  });

  it('names the embedding model as a REFERENCE annotated with the task type an editor may pick from', () => {
    const slug = diarization('embeddingModelSlug');
    expect(slug).toMatchObject({ type: 'string', modelTaskType: 'SPEAKER_EMBEDDING' });
    // A slug pattern, never a free string: this is a registry reference.
    expect(typeof slug.pattern).toBe('string');
    expect(String(slug.description)).toContain('SPEAKER_EMBEDDING');
  });

  it('still declares no property that could hold a credential, endpoint or wire model id', () => {
    // The annotation added above is a schema KEYWORD, not a property name, so the
    // reference-only sweep must remain clean.
    expect(forbiddenSchemaKeyProblems(AGENT_PARAMETER_SCHEMAS)).toEqual([]);
  });
});
