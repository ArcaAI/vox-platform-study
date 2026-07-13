/**
 * Declarative field metadata + sparse-patch builder for the TTS config row
 * (TASK-504 Phase 4), mirroring harness-policy's `policy-fields.ts`. Drafts are
 * held as strings/booleans; the patch emits only changed fields, parsing lists
 * (comma-separated) and coercing empty scalars to null (= inherit).
 */

import type { TtsConfigRow, TtsFormat, UpdateTtsConfigRequest } from '../api';

export type TtsFieldKind = 'string' | 'select' | 'integer' | 'fraction' | 'switch' | 'list';

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
      { key: 'defaultVoiceEn', label: 'Default English voice', kind: 'string', hint: 'Empty = inherit the platform default.' },
      { key: 'defaultVoiceMl', label: 'Default Malayalam voice', kind: 'string', hint: 'Empty = inherit.' },
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
