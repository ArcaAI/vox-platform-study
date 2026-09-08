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
 */

import type { JsonObject } from '@arcaai/domains';

/** The namespaced key the summary language lives under inside `Consultation.metadata`. */
export const SUMMARY_LANGUAGE_METADATA_KEY = 'summaryLanguage';

/**
 * BCP-47-ish: a 2-3 letter primary subtag, then up to three `-`-separated alphanumeric subtags.
 * Exported so the request DTO and the tests state ONE grammar.
 */
export const SUMMARY_LANGUAGE_PATTERN = /^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8}){0,3}$/;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * The consultation's declared summary language, or `null`.
 *
 * A malformed or blank value reads as ABSENT rather than raising: the fail-safe direction is "the
 * agent's own body decides the language", never "this consultation cannot be documented".
 */
export function readSummaryLanguage(metadata: unknown): string | null {
  if (!isPlainObject(metadata)) return null;
  const value = metadata[SUMMARY_LANGUAGE_METADATA_KEY];
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 && SUMMARY_LANGUAGE_PATTERN.test(trimmed) ? trimmed : null;
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
