/**
 * @arcaai/vox - Language selection types (TASK-1004)
 *
 * The cross-language contract shared by every HOPE surface that carries a spoken language
 * selection (live streaming, batch transcription, the consultation declaration). Pinned by
 * `tests/contracts/language-resolution.fixture.json` (readers: the TS normalizer + resolver in
 * `@arcaai/applications`, `apps/stt`'s Python mirror, `@arcaai/vox-node`, this package, and the
 * ALaaS broker). The fixture's `gateway` block is this file's `LanguageResolution` shape,
 * camelCase; `enums.source`/`enums.reason` are the closed unions below.
 */

/**
 * A catalog language-mode id, e.g. `'en'`, `'ml'`, `'ml-en'` (Malayalam-led, English mixed),
 * `'auto'`. Widened with `(string & {})` so a mode the catalog adds later is still accepted —
 * this is a SELECTION id sent to the gateway, not a closed enum the SDK enforces client-side; an
 * unrecognized value is refused server-side (400 `LANGUAGE_MODE_UNKNOWN`), never silently dropped.
 *
 * Named `LanguageModeId` (not `LanguageMode`) to avoid colliding with the catalog-ENTRY interface
 * of that name ({@link LanguageMode} — `id`, `label`, `kind`, `supportedEngines`, ...) — this
 * type is the value of that entry's own `id` field.
 */
export type LanguageModeId = 'en' | 'ml' | 'ml-en' | 'vi' | 'vi-en' | 'auto' | (string & {});

/**
 * Which tier supplied the effective language mode — precedence is
 * request > consultation > agent default > `'auto'` (never engine selection; OD-6). Closed: the
 * fixture's `enums.source` is authoritative, add a value there first.
 */
export type LanguageResolutionSource = 'request' | 'consultation' | 'agent' | 'default';

/**
 * Why a resolution came back `degraded: true`. Closed: the fixture's `enums.reason` is
 * authoritative, add a value there first.
 */
export type LanguageResolutionDegradeReason =
  'whisper_cpp_pair_unprimed' | 'gloss_translation_only' | 'engine_auto_detect' | 'fallback_engine_switch';

/**
 * The engine-neutral decoding parameters STT actually applied — the fixture's `params`/
 * `paramsKeys`. `language` is the vendor-facing language tag STT passed the engine (`null` when
 * the engine got no language signal at all, e.g. an unprimed whisper.cpp pair); `primed` is
 * whether a priming prompt was sent.
 */
export interface LanguageResolutionParams {
  language: string | null;
  codeSwitching: boolean;
  streamingEnglishGloss: boolean;
  primed: boolean;
}

/**
 * The resolution RECEIPT — what was requested, which tier won, and what the serving engine
 * actually did with it. No silent degrade: a mode an engine cannot serve natively still returns
 * `degraded: true` with a `reason`, rather than failing the session/job (422 `LANGUAGE_MODE_UNSUPPORTED`
 * is reserved for a mode NO engine in the chain can serve at all).
 *
 * Carried on {@link StreamingSessionResponse.languageResolution} and the `status`/`ready` WS
 * frames ({@link WsStatusMessage.languageResolution}, {@link WsReadyMessage.languageResolution}).
 */
export interface LanguageResolution {
  /** What the caller asked for (or what precedence resolved to, before the engine adapted it). */
  requestedMode: LanguageModeId;
  source: LanguageResolutionSource;
  /** What was actually applied — equals `requestedMode` unless the engine degraded it. */
  appliedMode: LanguageModeId;
  /** The serving engine — an `AiModelFormat` value (e.g. `'WHISPER_CPP'`, `'SARVAM'`), descriptive rather than a closed union: the catalogue can add engines without a type change here. */
  engine: string;
  /** The resolved ASR model's `provider`, or `null` for a self-hosted engine. */
  provider: string | null;
  params: LanguageResolutionParams;
  /** `true` when the engine could not serve `requestedMode` natively and applied its best available approximation. */
  degraded: boolean;
  /** Present exactly when `degraded` is `true`. */
  reason: LanguageResolutionDegradeReason | null;
}
