/**
 * TASK-932 §3.7 — the consultation's SUMMARY LANGUAGE: what the note is written in.
 *
 * ## Two languages, one consultation, and they are not the same question
 *
 * TASK-891 OD-1 settled the FIRST one: the STT language mode has no default, because "the
 * code-switch is always enabled … to use a specific language, the SDK or end-user must declare
 * the language code". That governs DECODING — what the microphone is allowed to hear.
 *
 * This is the SECOND one, and it moves in the opposite direction: a Malayalam-English
 * consultation is routinely documented in English, and an English consultation may be documented
 * in Malayalam. The transcript's language and the note's language are independent, so declaring
 * one must never silently set the other. Nothing here touches the STT channel; nothing on the STT
 * channel is read here.
 *
 * Absent means UNDECLARED, and undeclared is not English — the prompt simply says nothing about
 * an output language and the agent's own body decides, which is what every consultation did
 * before this ticket.
 *
 * ## Why `metadata`, and what would be better
 *
 * `Consultation.language` EXISTS as a column ("Detected or specified language",
 * `consultation.prisma:248`) and is the right long-term home. It is not surfaced by
 * `ConsultationEntity` / `ConsultationModel` / `ConsultationEntityMapper`, so writing it means a
 * domain-layer change (hand-authored entity + mapper + factory props, `gen:model` regeneration,
 * and the `generate-data-entity-check` / `generate-data-model-check` drift gates) — outside this
 * lane's file boundary. The marker below is deliberately shaped so that promotion is a
 * one-function change: every reader goes through {@link readSummaryLanguage}, and the response
 * DTO already exposes it as a first-class `language` field, so the API contract does not move
 * when the storage does.
 *
 * ## Validation
 *
 * A LANGUAGE TAG, not free text: `en`, `ml`, `en-IN`, `zh-Hant-HK`. The pattern is the
 * conservative BCP-47 subset the platform already speaks (`ResolvedAsrSpec` language modes are
 * 2-16 chars, `IO_DEFAULTS.SPEECH_TO_TEXT.language` in the agent seed says the same), rejecting
 * the two things that actually arrive by accident — a display name ("English") and a sentence.
 * It is not a registry check: refusing a valid-but-unlisted tag would be a worse failure than
 * passing one through to a model that reads it as prose.
 *
 * TASK-1001 OD-4 added a third rejection: an STT CODE-SWITCH mode (`ml-en`) is shaped exactly
 * like a legitimate region tag (`en-IN`), so shape alone cannot discriminate them — see
 * {@link SUMMARY_LANGUAGE_PATTERN}'s own docstring for the rule.
 */

import type { JsonObject } from '@arcaai/domains';

/** The namespaced key the summary language lives under inside `Consultation.metadata`. */
export const SUMMARY_LANGUAGE_METADATA_KEY = 'summaryLanguage';

/**
 * BCP-47-ish: a 2-3 letter primary subtag, then up to three `-`-separated alphanumeric subtags.
 * Exported so the request DTO and the tests state ONE grammar.
 *
 * TASK-1001 OD-4 — shape alone cannot tell a REGION subtag from an STT CODE-SWITCH marker: `ml-en`
 * (`ASR_PARAMETERS.decoding.languageMode`) is shaped exactly like the legitimate `en-IN`. The
 * discriminator is content, not shape: a two-letter SECOND subtag that is ITSELF one of the
 * platform's known language PRIMARY subtags (`en`/`ml`/`hi`/`ta`/`kn`/`te` — the same short list
 * {@link summaryLanguageName} already speaks; none of them happens to double as an ISO-3166
 * region code) is not a region and is refused. The rule fires only on a two-letter second
 * subtag, so a script/region combination (`zh-Hant-HK`) is untouched.
 */
export const SUMMARY_LANGUAGE_PATTERN = /^[A-Za-z]{2,3}(?!-(?:en|ml|hi|ta|kn|te)(?:-|$))(-[A-Za-z0-9]{2,8}){0,3}$/i;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Shared shape+grammar check: a non-blank string matching {@link SUMMARY_LANGUAGE_PATTERN}
 * (which, since TASK-1001 OD-4, also excludes STT code-switch markers), or `null`.
 */
export function parseLanguageTag(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 && SUMMARY_LANGUAGE_PATTERN.test(trimmed) ? trimmed : null;
}

/**
 * The consultation's declared summary language, or `null`.
 *
 * A malformed, blank, or code-switch-shaped value reads as ABSENT rather than raising: the
 * fail-safe direction is "the agent's own body decides the language", never "this consultation
 * cannot be documented".
 */
export function readSummaryLanguage(metadata: unknown): string | null {
  if (!isPlainObject(metadata)) return null;
  return parseLanguageTag(metadata[SUMMARY_LANGUAGE_METADATA_KEY]);
}

/**
 * Merge the declared language into existing metadata, preserving every other key — the same
 * shape as `withWorkflowSelectionMarker`, for the same reason: client-supplied metadata from
 * `OpenConsultationRequest` must survive untouched.
 */
export function withSummaryLanguage(metadata: unknown, language: string): JsonObject {
  return { ...(isPlainObject(metadata) ? metadata : {}), [SUMMARY_LANGUAGE_METADATA_KEY]: language.trim() };
}

/**
 * The human-readable NAME of a language tag, for the `{{language_name}}` the clinical corpus
 * binds — or the tag itself when it is not one of the platform's own.
 *
 * Deliberately tiny and deliberately not a lookup service: the two languages this platform
 * transcribes are English and Malayalam (`ASR_PARAMETERS.decoding.languageMode: 'ml-en'`), and a
 * tag outside that set is passed through verbatim rather than mapped through a table that would
 * then have to be maintained. A model reads `en-IN` correctly; it does not read a wrong name.
 */
export function summaryLanguageName(tag: string | null | undefined): string | null {
  if (!tag) return null;
  const primary = tag.split('-')[0]!.toLowerCase();
  const names: Record<string, string> = { en: 'English', ml: 'Malayalam', hi: 'Hindi', ta: 'Tamil', kn: 'Kannada', te: 'Telugu' };
  return names[primary] ?? tag;
}

/**
 * The summary-language resolver for the NATIVE consultation path (TASK-1001 OD-2). Every caller
 * that needs "what language should this note be written in" goes through this function.
 *
 * It does NOT subsume `resolveV1LanguageName` in `../prompt/pre-summary-variables.ts`, and that
 * is deliberate — §A2 of the ticket first called that function's `'English'` default drift, and
 * that reading was wrong. The frozen v1-compat PRE-SUMMARY template renders `{language_name}`
 * into a live instruction and has byte-identical golden fixtures, so an absent language must
 * still resolve to a NAME there; resolving it to `null` would emit "Write ALL bullet content
 * in ." Two surfaces, two contracts. What they now share is the grammar below, which is what
 * actually fixes the reported defect: neither can be handed a code-switch tag any more.
 *
 * Resolution order — configured-first, exactly like `AiProviderConnection`'s "absent = no
 * opinion" cascade:
 *   1. `configuredLanguage` — an explicitly configured agent-level language, when the caller
 *      passes one. Wins even when the consultation declares a different language.
 *   2. the consultation's own declared {@link SUMMARY_LANGUAGE_METADATA_KEY}, via
 *      {@link readSummaryLanguage}.
 *   3. `null` — no output language was declared by either source. The agent's own prompt body
 *      decides (see the module docstring). **Never** coerced to `'English'`.
 *
 * A malformed or code-switch-shaped `configuredLanguage` is treated as "no opinion" and falls
 * through to the consultation's own declaration — the same fail-safe posture
 * {@link readSummaryLanguage} already takes on the stored value.
 */
export function resolveSummaryLanguage(configuredLanguage: string | null | undefined, consultationMetadata: unknown): string | null {
  const tag = parseLanguageTag(configuredLanguage) ?? readSummaryLanguage(consultationMetadata);
  return summaryLanguageName(tag);
}
