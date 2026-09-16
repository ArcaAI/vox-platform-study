/**
 * TASK-977 — every ASR audio front-end STAGE is a declared agent opinion, OFF until
 * an admin turns it on. Diarization already was (TASK-887); VAD and denoise were not.
 *
 * The schema half of decisions D-1 (VAD default `false`), D-2 (denoise gets its own
 * `enabled`, so binding a model no longer enables the stage) and D-5 (`resample` /
 * `normalize` declare the `true` the resolver already applies, so the console can
 * render a truthful initial state instead of a blank tri-state).
 */
import { describe, expect, it } from 'vitest';
import { AGENT_PARAMETER_SCHEMAS } from '../agent-schemas';

const props = (schema: unknown, ...path: string[]): Record<string, unknown> => {
  let cursor = schema as Record<string, unknown>;
  for (const key of path) {
    cursor = (cursor.properties as Record<string, Record<string, unknown>>)[key];
    if (cursor === undefined) throw new Error(`no property ${path.join('.')}`);
  }
  return cursor;
};

const afe = (...path: string[]) => props(AGENT_PARAMETER_SCHEMAS.SPEECH_TO_TEXT, 'audioFrontEnd', ...path);

describe('TASK-977 — the ASR front-end stages declare themselves OFF', () => {
  it('D-1: VAD carries an explicit `enabled`, default false', () => {
    expect(afe('vad', 'enabled')).toMatchObject({ type: 'boolean', default: false });
  });

  it('D-2: denoise carries an explicit `enabled`, default false — binding a model is not consent', () => {
    expect(afe('denoise', 'enabled')).toMatchObject({ type: 'boolean', default: false });
  });

  it('all three stages agree: the default is off', () => {
    for (const stage of ['vad', 'denoise', 'diarization']) {
      expect(afe(stage, 'enabled')).toMatchObject({ type: 'boolean', default: false });
    }
  });

  it('D-5: resample and normalize declare the `true` the resolver applies', () => {
    expect(afe('resample')).toMatchObject({ type: 'boolean', default: true });
    expect(afe('normalize')).toMatchObject({ type: 'boolean', default: true });
  });

  it('the new keys are additive — the stage objects stay closed and keep their tuning knobs', () => {
    expect(Object.keys(afe('vad').properties as object).sort()).toEqual([
      'enabled',
      'minSilenceMs',
      'minSpeechMs',
      'modelSlug',
      'speechPadMs',
      'threshold',
    ]);
    expect(Object.keys(afe('denoise').properties as object).sort()).toEqual(['enabled', 'level', 'modelSlug']);
    expect(afe('vad')).toMatchObject({ type: 'object', additionalProperties: false });
    expect(afe('denoise')).toMatchObject({ type: 'object', additionalProperties: false });
  });
});
