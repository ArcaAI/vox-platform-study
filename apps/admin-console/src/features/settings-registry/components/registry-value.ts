/**
 * `dataType` <-> draft-text translation for the registry editor.
 *
 * The write lane validates `value` against the descriptor's declared
 * `dataType` and 400s a mismatch, so the type is not cosmetic: a number key
 * must arrive as a JSON number, a `string[]` key as an array, a `json` key as
 * whatever it parses to. Phase 1 made non-numeric values first-class, so this
 * is emphatically not a numbers-only form.
 *
 * Kept separate from the component because the parse/serialise rules are where
 * the type errors actually live, and they are worth testing without a DOM.
 */

import type { SettingDataType } from '../api/types';

export interface ParseResult {
  ok: boolean;
  /** The value to send. Only meaningful when `ok`. */
  value?: unknown;
  /** Why it cannot be sent, for display under the control. */
  error?: string;
}

/** The stored value as editable text. */
export function toDraft(dataType: SettingDataType, value: unknown): string {
  if (value === null || value === undefined) return '';
  switch (dataType) {
    case 'boolean':
      return value === true ? 'true' : 'false';
    case 'string':
    case 'enum':
      return String(value);
    case 'number':
      return String(value);
    case 'string[]':
      // One entry per line: an admin edits a list as a list, not as JSON.
      return Array.isArray(value) ? value.map(String).join('\n') : String(value);
    case 'json':
      return JSON.stringify(value, null, 2);
    default:
      return String(value);
  }
}

/** The draft text as the typed value the gateway expects, or a reason it cannot be. */
export function fromDraft(dataType: SettingDataType, draft: string): ParseResult {
  switch (dataType) {
    case 'boolean':
      return { ok: true, value: draft === 'true' };

    case 'number': {
      const trimmed = draft.trim();
      if (trimmed === '') return { ok: false, error: 'A number is required.' };
      const parsed = Number(trimmed);
      if (!Number.isFinite(parsed)) return { ok: false, error: `“${trimmed}” is not a number.` };
      return { ok: true, value: parsed };
    }

    case 'string[]': {
      // Blank lines are dropped rather than sent as empty strings — an admin
      // pressing Enter twice means "next entry", not "an empty entry".
      const entries = draft
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line !== '');
      return { ok: true, value: entries };
    }

    case 'json': {
      const trimmed = draft.trim();
      if (trimmed === '') return { ok: false, error: 'A JSON value is required.' };
      try {
        return { ok: true, value: JSON.parse(trimmed) };
      } catch (error) {
        return { ok: false, error: error instanceof Error ? `Invalid JSON: ${error.message}` : 'Invalid JSON.' };
      }
    }

    case 'string':
    case 'enum':
      return { ok: true, value: draft };

    default:
      // `secret` never reaches here — the drawer refuses to render a control
      // for it — but returning a refusal rather than a value keeps that true
      // even if a future caller forgets.
      return { ok: false, error: 'This value type cannot be edited here.' };
  }
}

/** Compact one-line rendering of a stored value, for the list and the drawer header. */
export function formatValue(dataType: SettingDataType, value: unknown): string {
  if (value === null || value === undefined) return '—';
  if (dataType === 'string[]') return Array.isArray(value) ? (value.length === 0 ? '(empty list)' : value.join(', ')) : String(value);
  if (dataType === 'json') return JSON.stringify(value);
  return String(value);
}
