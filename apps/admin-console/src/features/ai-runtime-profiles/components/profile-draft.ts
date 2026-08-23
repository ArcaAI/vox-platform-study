/**
 * Draft <-> wire translation for the runtime-profile editor.
 *
 * Kept out of the component because the three-way field semantics are the part
 * that is easy to get quietly wrong, and they deserve their own tests: on the
 * wire a knob may be a NUMBER, `null` ("no opinion — fall through the
 * cascade"), or ABSENT ("leave the stored value untouched"). A form that only
 * distinguishes "has text" from "has no text" collapses `null` into absence and
 * makes clearing a knob impossible.
 */

import { ALL_KNOBS, type AiRuntimeProfile, type KnobSpec, type RuntimeProfileKnobs, type UpsertAiRuntimeProfileRequest } from '../api/types';

/** Text state, one entry per scalar knob. `''` means "cleared to null". */
export type KnobDraft = Record<KnobSpec['name'], string>;

/** Numbers render as text; `null` renders as empty, which is what re-clearing looks like. */
export function draftFromProfile(profile: Pick<AiRuntimeProfile, keyof RuntimeProfileKnobs> | undefined): KnobDraft {
  const draft = {} as KnobDraft;
  for (const spec of ALL_KNOBS) {
    const value = profile?.[spec.name] as number | null | undefined;
    draft[spec.name] = value === null || value === undefined ? '' : String(value);
  }
  return draft;
}

/** Per-field range messages, empty when the draft is submittable. */
export function validateDraft(draft: KnobDraft): Partial<Record<KnobSpec['name'], string>> {
  const errors: Partial<Record<KnobSpec['name'], string>> = {};
  for (const spec of ALL_KNOBS) {
    const raw = draft[spec.name].trim();
    // Empty is always valid: it is the explicit "no opinion" value.
    if (raw === '') continue;

    const parsed = Number(raw);
    if (!Number.isFinite(parsed)) {
      errors[spec.name] = `${spec.label} must be a number, or empty for no opinion.`;
      continue;
    }
    if (spec.kind === 'integer' && !Number.isInteger(parsed)) {
      errors[spec.name] = `${spec.label} must be a whole number.`;
      continue;
    }
    if (parsed < spec.min || (spec.max !== undefined && parsed > spec.max)) {
      const range = spec.max === undefined ? `at least ${spec.min}` : `between ${spec.min} and ${spec.max}`;
      errors[spec.name] = `${spec.label} must be ${range}.`;
    }
  }
  return errors;
}

/**
 * The PUT body: only knobs whose draft DIFFERS from what is stored.
 *
 * Sending the full set would work, but it would also make every save a
 * full-record overwrite — so two admins editing different knobs on the same row
 * would clobber each other's field even though neither touched it. Diffing
 * keeps a save to what the admin actually changed, and lets `null` travel as
 * the deliberate clear it is.
 */
export function bodyFromDraft(
  draft: KnobDraft,
  stored: Pick<AiRuntimeProfile, keyof RuntimeProfileKnobs> | undefined,
  extraJson: Record<string, unknown> | null | undefined,
  extraJsonDirty: boolean,
): Omit<UpsertAiRuntimeProfileRequest, 'expectedVersion'> {
  const body: Omit<UpsertAiRuntimeProfileRequest, 'expectedVersion'> = {};
  for (const spec of ALL_KNOBS) {
    const raw = draft[spec.name].trim();
    const next = raw === '' ? null : Number(raw);
    const current = (stored?.[spec.name] ?? null) as number | null;
    if (next !== current) {
      // `null` is written explicitly — it is the clear, not an omission.
      body[spec.name] = next as never;
    }
  }
  if (extraJsonDirty) {
    body.extraJson = extraJson ?? null;
  }
  return body;
}

/** True when a save would send nothing — the Save gate. */
export function isDraftClean(body: Omit<UpsertAiRuntimeProfileRequest, 'expectedVersion'>): boolean {
  return Object.keys(body).length === 0;
}
