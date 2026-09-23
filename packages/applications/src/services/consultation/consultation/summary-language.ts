/**
 * TASK-932 §3.7 / TASK-1001 — the consultation's two LANGUAGES, and which one decides the note.
 *
 * ## Two languages, one consultation, and they are not the same question
 *
 * The SOURCE language is what is spoken and transcribed. It is what `OpenConsultationRequest.language`
 * declares and what is stored under {@link SUMMARY_LANGUAGE_METADATA_KEY}: `en`, `ml`, `en-IN`, or an
 * STT code-switch mode such as `ml-en` ("Malayalam-led, English mixed" — the value ALaaS sends,
 * `ASR_PARAMETERS.decoding.languageMode`). TASK-891 OD-1 governs how the microphone decodes it.
 *
 * The OUTPUT language is what the note is WRITTEN in, and it moves independently: a
 * Malayalam-English consultation is routinely documented in English. The transcript's language and
 * the note's language are independent, so declaring one must never silently set the other.
 *
 * ## Owner decision 2026-09-23 — the output language is configuration, never the source tag
 *
 * *"ALaaS still sends the language: `ml-en` indicates code-mixed/code-switch enabled for
 * realtime/job transcription, Malayalam as the main language. The summarization (both pre-summary
 * and summary) is still in English, by admin configuration OR by default."*
 *
 * So, on the NATIVE path, the output language resolves in exactly two tiers and the source tag is
 * in neither:
 *   1. the TENANT'S POLICY — an `instruction.fragments[]` entry under the platform-reserved key
 *      `OUTPUT_LANGUAGE_POLICY_FRAGMENT_KEY` (`@arcaai/types`), when it is SELECTED for the call.
 *      Its text is the tenant's to write, so the runtime then states NO language of its own;
 *   2. the PLATFORM DEFAULT — `consultation.summary.outputLanguage` (`global-kv`, English unless a
 *      platform admin changes it), which the runtime states EXPLICITLY, naming and overriding the
 *      "write content in the conversation language" clause the clinical corpus carries.
 * {@link resolveOutputLanguage} is that rule. The TASK-932/TASK-1001-L1 posture it replaces —
 * "absent is not English, the agent's own body decides" — is what let the department bodies'
 * own conversation-language clause win, and it is retired on this surface.
 *
 * The FROZEN v1-compat surface keeps its own contract (`resolveV1LanguageName` in
 * `../prompt/pre-summary-variables.ts`, byte-pinned by golden fixtures) and is untouched: it still
 * runs the tag through {@link parseLanguageTag}, so `ml-en` still lands on v1's unknown → English
 * rule and never becomes "Malayalam".
 *
 * ## Why `metadata`, and what would be better
 *
 * `Consultation.language` EXISTS as a column ("Detected or specified language",
 * `consultation.prisma:248`) and is the right long-term home for the SOURCE tag. It is not surfaced
 * by `ConsultationEntity` / `ConsultationModel` / `ConsultationEntityMapper`, so writing it means a
 * domain-layer change outside this module. Every reader goes through {@link readSummaryLanguage},
 * so promotion stays a one-function change.
 *
 * ## Two grammars
 *
 * Both are the conservative BCP-47 subset the platform speaks (`en`, `ml`, `en-IN`, `zh-Hant-HK`),
 * rejecting the two things that arrive by accident — a display name ("English") and a sentence.
 * They differ in exactly one respect:
 *  - {@link SOURCE_LANGUAGE_PATTERN} ACCEPTS a code-switch mode (`ml-en`): it is a legitimate
 *    description of what is spoken, and refusing it at `/consultations/open` (as TASK-1001 L1 did)
 *    rejected the one value the reference integrator actually sends.
 *  - {@link SUMMARY_LANGUAGE_PATTERN} REFUSES one: an OUTPUT language cannot be "mixed". It guards
 *    the platform-default setting's value and the v1-compat name lookup.
 */

import type { JsonObject } from '@arcaai/domains';

/** The namespaced key the declared SOURCE language lives under inside `Consultation.metadata` (historical name). */
export const SUMMARY_LANGUAGE_METADATA_KEY = 'summaryLanguage';

/**
 * The SOURCE-language grammar: BCP-47-ish — a 2-3 letter primary subtag, then up to three
 * `-`-separated alphanumeric subtags. Accepts an STT code-switch mode (`ml-en`, `en-ml`), which is a
 * legitimate description of what is SPOKEN. Exported so the request DTO and the tests state ONE
 * grammar.
 */
export const SOURCE_LANGUAGE_PATTERN = /^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8}){0,3}$/;

/**
 * The OUTPUT-language grammar: {@link SOURCE_LANGUAGE_PATTERN} minus the code-switch modes. A note
 * is written in ONE language, so a "mixed" value is refused here — for the platform-default
 * setting's value (`consultation.summary.outputLanguage`) and for the v1-compat name lookup.
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

function matchTag(value: unknown, pattern: RegExp): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 && pattern.test(trimmed) ? trimmed : null;
}

/**
 * OUTPUT-grammar shape check: a non-blank string matching {@link SUMMARY_LANGUAGE_PATTERN} (which,
 * since TASK-1001 OD-4, excludes STT code-switch markers), or `null`. The v1-compat
 * `resolveV1LanguageName` depends on exactly this behaviour — do not widen it.
 */
export function parseLanguageTag(value: unknown): string | null {
  return matchTag(value, SUMMARY_LANGUAGE_PATTERN);
}

/** SOURCE-grammar shape check: like {@link parseLanguageTag}, but a code-switch mode (`ml-en`) is a valid answer. */
export function parseSourceLanguageTag(value: unknown): string | null {
  return matchTag(value, SOURCE_LANGUAGE_PATTERN);
}

/**
 * The consultation's declared SOURCE language — what was declared at open — or `null`.
 *
 * Kept under its historical name because the storage key and every reader already carry it. It
 * answers "what is spoken", including a code-switch mode such as `ml-en`, and it NEVER decides the
 * note's output language on the native path — {@link resolveOutputLanguage} does, and takes no
 * source tag at all.
 *
 * A malformed or blank value reads as ABSENT rather than raising.
 */
export function readSummaryLanguage(metadata: unknown): string | null {
  if (!isPlainObject(metadata)) return null;
  return parseSourceLanguageTag(metadata[SUMMARY_LANGUAGE_METADATA_KEY]);
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
 * The platform's CODE default for the note OUTPUT language — the `default` of the
 * `consultation.summary.outputLanguage` descriptor, and the answer when no settings graph is wired
 * or the stored value is unusable. It is that descriptor's default declared once, not a second
 * opinion: a platform admin changes the effective value through the setting, never here.
 */
export const OUTPUT_LANGUAGE_DEFAULT = 'en';

/** A resolved note output language: the tag, and the name a prompt states. */
export interface OutputLanguage {
  tag: string;
  name: string;
}

/**
 * The PLATFORM-DEFAULT output language from the resolved value of
 * `consultation.summary.outputLanguage`.
 *
 * A value that is not a valid OUTPUT tag — unset, blank, a display name, or a code-switch mode that
 * somehow bypassed the write lane's `validate` — falls to {@link OUTPUT_LANGUAGE_DEFAULT}: the note
 * must still be written in one named language, and "no instruction" is the failure this ticket
 * exists to remove.
 */
export function platformOutputLanguage(platformDefault: unknown): OutputLanguage {
  const tag = parseLanguageTag(platformDefault) ?? OUTPUT_LANGUAGE_DEFAULT;
  return { tag, name: summaryLanguageName(tag) ?? tag };
}

/**
 * The note OUTPUT-language resolver for the NATIVE consultation path (owner decision 2026-09-23).
 *
 * Two tiers, configuration first — the same "absent = no opinion" shape as `AiProviderConnection`:
 *   1. `tenantPolicySelected` — the tenant's output-language policy fragment
 *      (`OUTPUT_LANGUAGE_POLICY_FRAGMENT_KEY`) was SELECTED for this generation. Its text owns the
 *      language, so this returns `null` and the caller states NONE: a second, generated statement
 *      beside the tenant's would be two answers to one question.
 *   2. otherwise the platform default ({@link platformOutputLanguage}), which the caller STATES.
 *
 * The consultation's declared SOURCE tag is deliberately not a parameter. `ml-en` is what the
 * microphone hears; it never selects what the note is written in.
 */
export function resolveOutputLanguage(tenantPolicySelected: boolean, platformDefault: unknown): OutputLanguage | null {
  return tenantPolicySelected ? null : platformOutputLanguage(platformDefault);
}
