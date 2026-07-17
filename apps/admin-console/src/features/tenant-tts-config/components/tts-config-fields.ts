/**
 * Declarative field metadata + sparse-patch builder for the TTS config row
 * (TASK-504 Phase 4), mirroring harness-policy's `policy-fields.ts`. Drafts are
 * held as strings/booleans; the patch emits only changed fields, parsing lists
 * (comma-separated) and coercing empty scalars to null (= inherit).
 */

import type { TtsConfigRow, TtsFormat, TtsVoiceBindings, UpdateTtsConfigRequest } from '../api';

export type TtsFieldKind = 'string' | 'select' | 'integer' | 'fraction' | 'switch' | 'list';

/**
 * Stable INTERNAL voice ids (TASK-506) — mirror tts-v2's DEFAULT_VOICES
 * (`catalog/voices.py`). These are the values `defaultVoiceEn/Ml` and the
 * bindings editor key on; per-provider voice names live in the bindings map.
 */
export const EN_INTERNAL_VOICE_IDS = ['en-female-1', 'en-male-1'] as const;
export const ML_INTERNAL_VOICE_IDS = ['ml-female-1', 'ml-male-1'] as const;
export const ALL_INTERNAL_VOICE_IDS = [...EN_INTERNAL_VOICE_IDS, ...ML_INTERNAL_VOICE_IDS] as const;

export interface TtsField {
  key: keyof UpdateTtsConfigRequest;
  label: string;
  kind: TtsFieldKind;
  hint?: string;
  options?: readonly string[];
}

export interface TtsFieldGroup {
  title: string;
  fields: readonly TtsField[];
}

export const TTS_FORMATS: readonly TtsFormat[] = ['pcm', 'wav', 'mp3'];

export const TTS_FIELD_GROUPS: readonly TtsFieldGroup[] = [
  {
    title: 'Voices & output',
    fields: [
      {
        key: 'defaultVoiceEn',
        label: 'Default English voice',
        kind: 'select',
        options: EN_INTERNAL_VOICE_IDS,
        hint: 'Internal voice id; empty = inherit the platform default.',
      },
      {
        key: 'defaultVoiceMl',
        label: 'Default Malayalam voice',
        kind: 'select',
        options: ML_INTERNAL_VOICE_IDS,
        hint: 'Internal voice id; empty = inherit.',
      },
      { key: 'defaultFormat', label: 'Default format', kind: 'select', options: TTS_FORMATS },
      { key: 'defaultSpeed', label: 'Default speed', kind: 'fraction', hint: 'Clamped to the platform speed range.' },
      { key: 'sampleRate', label: 'Sample rate (Hz)', kind: 'integer' },
      { key: 'maxInputChars', label: 'Max input chars', kind: 'integer' },
    ],
  },
  {
    title: 'Routing & providers',
    fields: [
      { key: 'routingEn', label: 'English routing', kind: 'list', hint: 'Comma-separated provider order.' },
      { key: 'routingMl', label: 'Malayalam routing', kind: 'list', hint: 'Comma-separated provider order.' },
      { key: 'allowedProviders', label: 'Allowed providers', kind: 'list', hint: 'Comma-separated whitelist.' },
      {
        key: 'sarvamPublicApiAllowed',
        label: 'Allow Sarvam public API',
        kind: 'switch',
        hint: 'PHI posture: keep off unless the public API is approved for this tenant.',
      },
    ],
  },
];

export const TTS_FIELDS: readonly TtsField[] = TTS_FIELD_GROUPS.flatMap((group) => group.fields);

/** Current row value expressed in the draft shape (string / boolean). */
export function fieldDraftValue(field: TtsField, row: TtsConfigRow): string | boolean {
  const raw = (row as unknown as Record<string, unknown>)[field.key as string];
  if (field.kind === 'switch') return Boolean(raw);
  if (field.kind === 'list') return Array.isArray(raw) ? raw.join(', ') : '';
  if (raw == null) return '';
  return String(raw);
}

/** Read-only display of an effective value (for the resolve card). */
export function fieldDisplayValue(field: TtsField, value: unknown): string {
  if (field.kind === 'switch') return value ? 'on' : 'off';
  if (Array.isArray(value)) return value.length > 0 ? value.join(', ') : '—';
  if (value == null || value === '') return '—';
  return String(value);
}

function parseList(draft: string): string[] {
  return draft
    .split(',')
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
}

/** Tenant bindings persisted on the row (under configJson.voiceBindings). */
export function rowVoiceBindings(row: TtsConfigRow): TtsVoiceBindings {
  const raw = row.configJson?.['voiceBindings'];
  return raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as TtsVoiceBindings) : {};
}

/** Editor rows: the 4 internal ids ∪ any voice id already bound (saved or effective). */
export function bindingVoiceIds(saved: TtsVoiceBindings, effective: TtsVoiceBindings | undefined): string[] {
  const ids = new Set<string>(ALL_INTERNAL_VOICE_IDS);
  for (const id of Object.keys(effective ?? {})) ids.add(id);
  for (const id of Object.keys(saved)) ids.add(id);
  return [...ids];
}

/**
 * Apply per-provider drafts over the saved tenant bindings into the FULL map
 * the PUT persists (the gateway replaces configJson.voiceBindings wholesale).
 * A draft of '' clears that provider binding (inherit); voice ids left with no
 * providers are dropped from the map.
 */
export function mergeBindingDrafts(saved: TtsVoiceBindings, drafts: Record<string, Record<string, string>>): TtsVoiceBindings {
  const merged: TtsVoiceBindings = {};
  const voiceIds = new Set([...Object.keys(saved), ...Object.keys(drafts)]);
  for (const voiceId of voiceIds) {
    const providerMap: Record<string, string> = { ...saved[voiceId] };
    for (const [provider, value] of Object.entries(drafts[voiceId] ?? {})) {
      if (value === '') delete providerMap[provider];
      else providerMap[provider] = value;
    }
    if (Object.keys(providerMap).length > 0) merged[voiceId] = providerMap;
  }
  return merged;
}

/** Whether the drafts change anything relative to the saved bindings. */
export function bindingsDirty(saved: TtsVoiceBindings, drafts: Record<string, Record<string, string>>): boolean {
  return JSON.stringify(mergeBindingDrafts(saved, drafts)) !== JSON.stringify(mergeBindingDrafts(saved, {}));
}

/**
 * Build the sparse PUT patch: only fields whose draft differs from the current
 * row value. Empty scalar strings become null (inherit); lists are parsed;
 * numbers are coerced (an unparseable number is skipped rather than sent as NaN).
 */
export function buildSparsePatch(row: TtsConfigRow, drafts: Record<string, string | boolean>): Omit<UpdateTtsConfigRequest, 'expectedVersion'> {
  const patch: Record<string, unknown> = {};

  for (const field of TTS_FIELDS) {
    const key = field.key as string;
    if (!(key in drafts)) continue;
    const draft = drafts[key];
    const current = fieldDraftValue(field, row);
    if (draft === current) continue;

    switch (field.kind) {
      case 'switch':
        patch[key] = Boolean(draft);
        break;
      case 'list':
        patch[key] = parseList(String(draft));
        break;
      case 'integer':
      case 'fraction': {
        const text = String(draft).trim();
        if (text === '') {
          patch[key] = null;
          break;
        }
        const num = field.kind === 'integer' ? Number.parseInt(text, 10) : Number.parseFloat(text);
        if (Number.isFinite(num)) patch[key] = num;
        break;
      }
      default: {
        const text = String(draft).trim();
        patch[key] = text === '' ? null : text;
      }
    }
  }

  return patch;
}
