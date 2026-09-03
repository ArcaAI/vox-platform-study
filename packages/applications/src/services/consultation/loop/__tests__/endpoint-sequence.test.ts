/**
 * the endpoint sequence is ORDERED and EXTENSIBLE, not a literal.
 *
 * What this replaces, verbatim from `loop-config.service.ts` before this ticket:
 *
 * ```ts
 * const endingActionsBase = hasStreamAudio ? ['livedoc.stop', 'harness.finalize'] : ['harness.finalize'];
 * const endingActions = endingActionsBase.filter((action) => !neverActions.has(action));
 * ```
 *
 * Two things were wrong with it, and the second is the one that matters. The list was a code
 * literal, so no admin could reorder or extend it — and `neverActions` could only SUBTRACT, so
 * the only control a tenant had over the stage that closes a consultation was the power to
 * delete steps from it. "You may remove things from this list and nothing else" is not
 * configuration.
 *
 * The tests below pin the four levers the replacement gives an admin: ORDER (the persisted list
 * is the order), EXTEND (per-agent `alwaysActions` appends), SUBTRACT (`neverActions` still
 * vetoes, now as one lever among several), and a fallback that is a real default rather than a
 * silent empty stage.
 */
import { describe, expect, it } from 'vitest';
import { CONSULTATION_ENDPOINT_ACTIONS_DEFAULT, ENDPOINT_ELIGIBLE_ACTIONS, resolveEndpointSequence } from '../endpoint-sequence';

describe('resolveEndpointSequence — ORDER (D-10)', () => {
  it('runs the persisted list in the order it was authored', () => {
    expect(
      resolveEndpointSequence({
        configured: ['feedback.capture', 'summary.finalize', 'session.timeout'],
        hasStreamAudio: false,
      }),
    ).toEqual(['feedback.capture', 'summary.finalize', 'session.timeout']);
  });

  it('a reorder of the persisted list reorders the stage — the whole point of D-10', () => {
    const forwards = resolveEndpointSequence({ configured: ['summary.finalize', 'feedback.capture'], hasStreamAudio: false });
    const backwards = resolveEndpointSequence({ configured: ['feedback.capture', 'summary.finalize'], hasStreamAudio: false });
    expect(forwards).not.toEqual(backwards);
    expect(forwards).toEqual(['summary.finalize', 'feedback.capture']);
    expect(backwards).toEqual(['feedback.capture', 'summary.finalize']);
  });

  it('de-duplicates, keeping the FIRST occurrence — an action runs once, at the position authored for it', () => {
    expect(
      resolveEndpointSequence({
        configured: ['summary.finalize', 'feedback.capture', 'summary.finalize'],
        hasStreamAudio: false,
      }),
    ).toEqual(['summary.finalize', 'feedback.capture']);
  });
});

describe('resolveEndpointSequence — EXTEND (the lever `neverActions` never had)', () => {
  it('appends an endpoint-eligible alwaysAction that the persisted list omits', () => {
    expect(
      resolveEndpointSequence({
        configured: ['harness.finalize'],
        hasStreamAudio: false,
        alwaysActions: ['feedback.capture'],
      }),
    ).toEqual(['harness.finalize', 'feedback.capture']);
  });

  it('appends multiple, in the order the agent declared them', () => {
    expect(
      resolveEndpointSequence({
        configured: ['harness.finalize'],
        hasStreamAudio: false,
        alwaysActions: ['feedback.capture', 'summary.finalize'],
      }),
    ).toEqual(['harness.finalize', 'feedback.capture', 'summary.finalize']);
  });

  it('never MOVES an action already in the persisted list — the admin ordering wins over the agent', () => {
    expect(
      resolveEndpointSequence({
        configured: ['summary.finalize', 'harness.finalize'],
        hasStreamAudio: false,
        alwaysActions: ['summary.finalize'],
      }),
    ).toEqual(['summary.finalize', 'harness.finalize']);
  });

  it('ignores a non-endpoint alwaysAction — this is why existing agents are unchanged', () => {
    // Every agent configured before this ticket carries per-kind actions in `alwaysActions`
    // (`client.emit` above all). Appending those to the ENDPOINT stage would silently change the
    // behaviour of every such agent, so only endpoint-eligible keys may extend it.
    expect(
      resolveEndpointSequence({
        configured: ['harness.finalize'],
        hasStreamAudio: false,
        alwaysActions: ['client.emit', 'nlp.extract_entities', 'livedoc.start'],
      }),
    ).toEqual(['harness.finalize']);
  });
});

describe('resolveEndpointSequence — SUBTRACT (still supported, no longer the only lever)', () => {
  it('neverActions removes an entry wherever it appears', () => {
    expect(
      resolveEndpointSequence({
        configured: ['livedoc.stop', 'summary.finalize', 'harness.finalize'],
        hasStreamAudio: true,
        neverActions: ['harness.finalize'],
      }),
    ).toEqual(['livedoc.stop', 'summary.finalize']);
  });

  it('neverActions outranks alwaysActions — a forbidden action is never appended', () => {
    expect(
      resolveEndpointSequence({
        configured: ['harness.finalize'],
        hasStreamAudio: false,
        alwaysActions: ['feedback.capture'],
        neverActions: ['feedback.capture'],
      }),
    ).toEqual(['harness.finalize']);
  });
});

describe('resolveEndpointSequence — audio scoping and degradation', () => {
  it('drops livedoc.stop when the consultation has no STREAM_AUDIO kind (unchanged behaviour)', () => {
    expect(resolveEndpointSequence({ configured: ['livedoc.stop', 'harness.finalize'], hasStreamAudio: false })).toEqual(['harness.finalize']);
  });

  it('keeps livedoc.stop when the consultation streams audio', () => {
    expect(resolveEndpointSequence({ configured: ['livedoc.stop', 'harness.finalize'], hasStreamAudio: true })).toEqual([
      'livedoc.stop',
      'harness.finalize',
    ]);
  });

  it('an empty or malformed persisted value falls back to the platform default, never to an empty stage', () => {
    // An unset setting must not mean "close consultations without finalizing them". The
    // descriptor is `open-to-default` for exactly this reason.
    expect(resolveEndpointSequence({ configured: [], hasStreamAudio: true })).toEqual([...CONSULTATION_ENDPOINT_ACTIONS_DEFAULT]);
    expect(resolveEndpointSequence({ configured: undefined, hasStreamAudio: true })).toEqual([...CONSULTATION_ENDPOINT_ACTIONS_DEFAULT]);
    expect(resolveEndpointSequence({ configured: 'harness.finalize' as never, hasStreamAudio: true })).toEqual([
      ...CONSULTATION_ENDPOINT_ACTIONS_DEFAULT,
    ]);
  });

  it('drops an unknown key rather than dispatching it — the loop would only report it as skipped', () => {
    expect(resolveEndpointSequence({ configured: ['summary.finalize', 'not.an.action', 42 as never], hasStreamAudio: false })).toEqual([
      'summary.finalize',
    ]);
  });

  it('an admin CAN empty the stage deliberately, by vetoing every entry', () => {
    expect(
      resolveEndpointSequence({
        configured: ['harness.finalize'],
        hasStreamAudio: false,
        neverActions: ['harness.finalize'],
      }),
    ).toEqual([]);
  });
});

describe('the endpoint vocabulary', () => {
  it('the platform default preserves the pre-existing stage and adds the three new steps', () => {
    // Ordering rationale, and it is load-bearing: `livedoc.stop` first so the audio session is
    // closed before anything reads the transcript; `summary.finalize` (which LOCKS every
    // document) BEFORE `feedback.capture`, so a feedback capture that degrades can never cost a
    // clinician the finalized note.
    expect(CONSULTATION_ENDPOINT_ACTIONS_DEFAULT).toEqual([
      'livedoc.stop',
      'session.timeout',
      'harness.finalize',
      'summary.finalize',
      'feedback.capture',
    ]);
  });

  it('eligibility is a closed list — an admin orders the stage, they do not invent steps for it', () => {
    expect([...ENDPOINT_ELIGIBLE_ACTIONS].sort()).toEqual(
      ['feedback.capture', 'harness.finalize', 'livedoc.stop', 'session.timeout', 'summary.finalize'].sort(),
    );
  });

  it('every default entry is eligible', () => {
    for (const action of CONSULTATION_ENDPOINT_ACTIONS_DEFAULT) {
      expect(ENDPOINT_ELIGIBLE_ACTIONS).toContain(action);
    }
  });
});
