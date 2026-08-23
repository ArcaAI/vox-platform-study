/**
 * Runtime-profile draft translation (TASK-799 Phase 4, E.2).
 *
 * The knobs are THREE-STATE on the wire — a number, `null` ("no opinion, fall
 * through the cascade"), or absent ("leave the stored value alone") — and the
 * whole point of these tests is that the middle state survives. A form that
 * only knows "filled" and "empty" collapses `null` into omission, and the
 * result is a screen on which a knob can be set but never un-set.
 */

import { describe, expect, it } from 'vitest';
import type { AiRuntimeProfile } from '../../api/types';
import { bodyFromDraft, draftFromProfile, isDraftClean, validateDraft } from '../profile-draft';

const STORED = {
  temperature: 0.2,
  topP: null,
  maxTokens: 2048,
  contextLength: null,
  maxConcurrent: 8,
  tpmLimit: null,
  rpmLimit: null,
  timeoutS: 300,
  keepAliveSeconds: null,
  extraJson: null,
} satisfies Pick<AiRuntimeProfile, 'temperature' | 'topP' | 'maxTokens' | 'contextLength' | 'maxConcurrent' | 'tpmLimit' | 'rpmLimit' | 'timeoutS' | 'keepAliveSeconds' | 'extraJson'>;

describe('draftFromProfile', () => {
  it('renders a null knob as an empty field, so "no opinion" is visibly unset', () => {
    const draft = draftFromProfile(STORED);
    expect(draft.topP).toBe('');
    expect(draft.contextLength).toBe('');
  });

  it('renders numbers as text, including 0 — which is a real value, not an absence', () => {
    const draft = draftFromProfile({ ...STORED, temperature: 0 });
    expect(draft.temperature).toBe('0');
  });

  it('renders an entirely absent row as all-empty (the create case)', () => {
    const draft = draftFromProfile(undefined);
    expect(draft.temperature).toBe('');
    expect(draft.maxConcurrent).toBe('');
  });
});

describe('validateDraft — the server ranges, surfaced per field', () => {
  it('accepts an empty field: empty is the explicit "no opinion" value, never an error', () => {
    expect(validateDraft(draftFromProfile(STORED))).toEqual({});
  });

  it('rejects a temperature above the declared maximum', () => {
    const draft = { ...draftFromProfile(STORED), temperature: '3' };
    expect(validateDraft(draft).temperature).toMatch(/between 0 and 2/);
  });

  it('rejects a fractional value on an integer knob', () => {
    const draft = { ...draftFromProfile(STORED), maxTokens: '2048.5' };
    expect(validateDraft(draft).maxTokens).toMatch(/whole number/);
  });

  it('rejects a negative value on a min-0 knob', () => {
    const draft = { ...draftFromProfile(STORED), timeoutS: '-1' };
    expect(validateDraft(draft).timeoutS).toMatch(/at least 0/);
  });

  it('rejects text that is not a number', () => {
    const draft = { ...draftFromProfile(STORED), rpmLimit: 'lots' };
    expect(validateDraft(draft).rpmLimit).toMatch(/must be a number/);
  });

  it('allows the exact boundary values', () => {
    const draft = { ...draftFromProfile(STORED), temperature: '2', topP: '0' };
    expect(validateDraft(draft)).toEqual({});
  });
});

describe('bodyFromDraft — a save carries only what changed', () => {
  it('sends nothing when nothing was edited', () => {
    const body = bodyFromDraft(draftFromProfile(STORED), STORED, undefined, false);
    expect(body).toEqual({});
    expect(isDraftClean(body)).toBe(true);
  });

  it('sends only the edited knob, so a concurrent edit to a different knob is not clobbered', () => {
    const draft = { ...draftFromProfile(STORED), maxConcurrent: '16' };
    const body = bodyFromDraft(draft, STORED, undefined, false);

    expect(body).toEqual({ maxConcurrent: 16 });
    expect('temperature' in body).toBe(false);
    expect('timeoutS' in body).toBe(false);
  });

  it('sends an explicit null when a set knob is cleared — the clear IS the edit', () => {
    const draft = { ...draftFromProfile(STORED), temperature: '' };
    const body = bodyFromDraft(draft, STORED, undefined, false);

    expect(body).toHaveProperty('temperature', null);
    // Distinguishing these two is the entire reason this module exists: a
    // cleared knob must arrive as `null`, never simply be left out.
    expect(Object.keys(body)).toContain('temperature');
  });

  it('does not resend a knob that was already null and is still empty', () => {
    const body = bodyFromDraft(draftFromProfile(STORED), STORED, undefined, false);
    expect(Object.keys(body)).not.toContain('topP');
  });

  it('coerces to a NUMBER, not a string, on the wire', () => {
    const draft = { ...draftFromProfile(STORED), maxTokens: '4096' };
    const body = bodyFromDraft(draft, STORED, undefined, false);
    expect(typeof body.maxTokens).toBe('number');
  });

  it('treats a create (no stored row) as setting every non-empty knob', () => {
    const draft = { ...draftFromProfile(undefined), temperature: '0.7' };
    const body = bodyFromDraft(draft, undefined, undefined, false);
    expect(body).toEqual({ temperature: 0.7 });
  });

  it('includes extraJson only when it was actually touched', () => {
    const clean = bodyFromDraft(draftFromProfile(STORED), STORED, { n_threads: 8 }, false);
    expect('extraJson' in clean).toBe(false);

    const dirty = bodyFromDraft(draftFromProfile(STORED), STORED, { n_threads: 8 }, true);
    expect(dirty.extraJson).toEqual({ n_threads: 8 });
  });

  it('clears extraJson to null when emptied', () => {
    const body = bodyFromDraft(draftFromProfile(STORED), STORED, null, true);
    expect(body).toHaveProperty('extraJson', null);
  });
});
