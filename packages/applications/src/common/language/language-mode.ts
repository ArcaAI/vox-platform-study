/**
 * TASK-1004 — the spoken-language selection, declared ONCE and interpreted in ONE place.
 *
 * The gateway half of the cross-language contract pinned by
 * `tests/contracts/language-resolution.fixture.json`; `apps/stt`'s `normalize_language_mode`
 * and `LanguageResolution` are the other half, pinned to the same table.
 *
 * - {@link normalizeLanguageMode} — the edge normalizer: a catalog id wins as-is
 *   (case-insensitive, trimmed); a BCP-47 `<lang>-<REGION>` tag whose language subtag IS a
 *   single-language mode maps to it (`en-US` → `en`); anything else names no mode.
 * - {@link requireLanguageMode} — the same, as a 400 `LANGUAGE_MODE_UNKNOWN` at every edge that
 *   accepts a language, so no downstream service re-interprets a free string (the TASK-938 lesson).
 * - {@link resolveEffectiveLanguageMode} — request > consultation > agent > `auto`. It answers a
 *   MODE and the tier that supplied it, and nothing else: language never selects or changes the
 *   engine (TASK-1003 OD-6), and it is never the language a note is written in (TASK-1001 OD-12).
 * - {@link languageResolutionFromWire} — the receipt `apps/stt` emits (snake_case) projected to
 *   the camelCase shape the gateway emits everywhere.
 *
 * The catalog ids are STT's closed contract (`LANGUAGE_MODE_CATALOG`), mirrored here like an
 * enum so the edge can refuse without a round trip; the fixture is what keeps the two equal.
 */
import { BadRequestException } from '@nestjs/common';

/** The closed catalog, in STT's order. Add a mode to the contract fixture first. */
export const LANGUAGE_MODE_IDS = ['en', 'ml', 'ml-en', 'vi', 'vi-en', 'auto'] as const;
export type LanguageModeId = (typeof LANGUAGE_MODE_IDS)[number];

/** The modes a BCP-47 region tag may map onto — exactly the catalog's `kind: 'single'` entries. */
const SINGLE_LANGUAGE_MODES: ReadonlySet<string> = new Set<LanguageModeId>(['en', 'ml', 'vi']);
const CATALOG: ReadonlySet<string> = new Set<string>(LANGUAGE_MODE_IDS);
/** BCP-47 region subtag: two letters or three digits (`US`, `IN`, `419`). */
const BCP47_REGION = /^(?:[a-z]{2}|[0-9]{3})$/;

/** Who declared the effective mode — the precedence tiers. Closed: extend the fixture first. */
export const LANGUAGE_MODE_SOURCES = ['request', 'consultation', 'agent', 'default'] as const;
export type LanguageModeSource = (typeof LANGUAGE_MODE_SOURCES)[number];

/** Why a receipt is `degraded`. Closed: extend the fixture first. */
export const LANGUAGE_RESOLUTION_REASONS = [
  'whisper_cpp_pair_unprimed',
  'gloss_translation_only',
  'engine_auto_detect',
  'fallback_engine_switch',
] as const;
export type LanguageResolutionReason = (typeof LANGUAGE_RESOLUTION_REASONS)[number];

/** The 400 code every language-accepting edge answers with for a value that names no mode. */
export const LANGUAGE_MODE_UNKNOWN = 'LANGUAGE_MODE_UNKNOWN';

/** The catalog mode `value` names, or `null` when it names none. */
export function normalizeLanguageMode(value: unknown): LanguageModeId | null {
  if (typeof value !== 'string') return null;
  const candidate = value.trim().toLowerCase();
  if (CATALOG.has(candidate)) return candidate as LanguageModeId;
  const parts = candidate.split('-');
  if (parts.length !== 2 || !BCP47_REGION.test(parts[1]!)) return null;
  return SINGLE_LANGUAGE_MODES.has(parts[0]!) ? (parts[0] as LanguageModeId) : null;
}

/**
 * The mode a request FIELD names: `null` when the field is absent, the normalized id when it
 * names one, and a 400 `LANGUAGE_MODE_UNKNOWN` naming the field and the catalog otherwise.
 */
export function requireLanguageMode(value: unknown, field: string): LanguageModeId | null {
  if (value === undefined || value === null) return null;
  const mode = normalizeLanguageMode(value);
  if (mode) return mode;
  throw new BadRequestException({
    code: LANGUAGE_MODE_UNKNOWN,
    message:
      `${field} ${JSON.stringify(value)} is not a spoken-language mode. Use one of: ${LANGUAGE_MODE_IDS.join(', ')} ` +
      `(or a BCP-47 tag such as en-US for a single-language mode). GET /audio/transcription-jobs/language-modes lists the catalog.`,
    field,
    catalog: [...LANGUAGE_MODE_IDS],
  });
}

/**
 * The request's explicit mode: `languageMode` wins over `language`, and each one that is SENT must
 * name a mode (an unknown value in either is the caller's bug, answered 400 rather than ignored).
 */
export function requestedLanguageMode(body: { languageMode?: unknown; language?: unknown }): LanguageModeId | null {
  const fromMode = requireLanguageMode(body.languageMode, 'languageMode');
  const fromLanguage = requireLanguageMode(body.language, 'language');
  return fromMode ?? fromLanguage;
}

export interface EffectiveLanguageMode {
  mode: string;
  source: LanguageModeSource;
}

/**
 * request > consultation > agent > `auto`. Every tier is normalized, so a stored value that names
 * no mode is skipped rather than trusted. Engine-blind by construction: the answer is a mode and
 * the tier that supplied it.
 */
export function resolveEffectiveLanguageMode(input: { request?: unknown; consultation?: unknown; agent?: unknown }): EffectiveLanguageMode {
  const request = normalizeLanguageMode(input.request);
  if (request) return { mode: request, source: 'request' };
  const consultation = normalizeLanguageMode(input.consultation);
  if (consultation) return { mode: consultation, source: 'consultation' };
  const agent = normalizeLanguageMode(input.agent);
  if (agent) return { mode: agent, source: 'agent' };
  return { mode: 'auto', source: 'default' };
}

/** The receipt as the gateway emits it (REST, WS status frames, job rows). */
export interface LanguageResolution {
  requestedMode: string;
  source: LanguageModeSource;
  appliedMode: string;
  engine: string;
  provider: string | null;
  params: { language: string | null; codeSwitching: boolean; streamingEnglishGloss: boolean; primed: boolean };
  degraded: boolean;
  reason: LanguageResolutionReason | null;
}

const isRecord = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);

/** Read one key in either spelling — `apps/stt` writes snake_case, a re-projection camelCase. */
function pick(source: Record<string, unknown>, camel: string, snake: string): unknown {
  return camel in source ? source[camel] : source[snake];
}

/**
 * Project a receipt from `apps/stt` — an object, or the JSON string the result stream carries —
 * to the gateway's camelCase shape. Returns `null` for anything malformed or outside the closed
 * enums: a receipt is a display/audit fact, so a bad one is dropped, never relayed and never
 * allowed to fail the session or job it describes.
 */
export function languageResolutionFromWire(raw: unknown): LanguageResolution | null {
  let value = raw;
  if (typeof value === 'string') {
    if (value.length === 0) return null;
    try {
      value = JSON.parse(value);
    } catch {
      return null;
    }
  }
  if (!isRecord(value)) return null;

  const requestedMode = pick(value, 'requestedMode', 'requested_mode');
  const source = value.source;
  const appliedMode = pick(value, 'appliedMode', 'applied_mode');
  const engine = value.engine;
  const provider = value.provider ?? null;
  const degraded = value.degraded;
  const reason = value.reason ?? null;
  const params = value.params;
  if (
    typeof requestedMode !== 'string' ||
    typeof appliedMode !== 'string' ||
    typeof engine !== 'string' ||
    typeof degraded !== 'boolean' ||
    (provider !== null && typeof provider !== 'string') ||
    !(LANGUAGE_MODE_SOURCES as readonly unknown[]).includes(source) ||
    (reason !== null && !(LANGUAGE_RESOLUTION_REASONS as readonly unknown[]).includes(reason)) ||
    !isRecord(params)
  ) {
    return null;
  }

  const language = params.language ?? null;
  const codeSwitching = pick(params, 'codeSwitching', 'code_switching');
  const streamingEnglishGloss = pick(params, 'streamingEnglishGloss', 'streaming_english_gloss');
  const primed = params.primed;
  if (
    (language !== null && typeof language !== 'string') ||
    typeof codeSwitching !== 'boolean' ||
    typeof streamingEnglishGloss !== 'boolean' ||
    typeof primed !== 'boolean'
  ) {
    return null;
  }

  return {
    requestedMode,
    source: source as LanguageModeSource,
    appliedMode,
    engine,
    provider: provider as string | null,
    params: { language: language as string | null, codeSwitching, streamingEnglishGloss, primed },
    degraded,
    reason: reason as LanguageResolutionReason | null,
  };
}
