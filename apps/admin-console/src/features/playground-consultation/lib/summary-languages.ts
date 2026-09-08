/**
 * TASK-932 §3.7 — the SUMMARY-LANGUAGE options, derived from the STT language catalogue.
 *
 * ## Why derived and not listed
 *
 * The languages a clinician can be documented in are the languages this platform actually
 * transcribes, and the backend already publishes that set: `GET
 * /audio/transcription-jobs/language-modes` returns each mode with its `primaryLanguage` and
 * `secondaryLanguage` as ISO 639-1 tags. Writing a list here instead would be a second, drifting
 * statement of the platform's language support living in a console — the "no hardcoded
 * configuration" rule, applied to a picker.
 *
 * The two axes stay separate, which is the point of the whole field: a MODE (`ml-en`,
 * code-switch) says what the microphone may hear; a TAG (`ml`) says what the note is written in.
 * This function reads the mode catalogue for its LANGUAGES and discards everything else about it.
 *
 * ## The fallback, and why it is a UI fallback and not a default
 *
 * When the catalogue cannot be read the picker still has to offer something, or a clinician who
 * needs a Malayalam note is silently unable to ask for one. The fallback is the pair the
 * platform's own ASR agent declares (`ASR_PARAMETERS.decoding.languageMode: 'ml-en'`), and it
 * changes no default: "Not declared" remains the selected value, and undeclared is not English.
 */

/** One offerable summary language. */
export interface SummaryLanguageOption {
  /** The BCP-47 tag sent as `session.open({ language })`. */
  tag: string;
  /** What the clinician reads. */
  label: string;
}

/** The shape this reads off an SDK `LanguageMode` — structural, so no SDK import is needed. */
export interface LanguageModeLike {
  primaryLanguage?: string | null;
  secondaryLanguage?: string | null;
}

/**
 * Names for the tags this platform serves. Not a registry and not meant to become one: a tag with
 * no entry is offered under its own tag, which a clinician reads correctly and which cannot be
 * wrong — unlike a guessed name.
 */
const LANGUAGE_NAMES: Record<string, string> = {
  en: 'English',
  ml: 'Malayalam',
  hi: 'Hindi',
  ta: 'Tamil',
  kn: 'Kannada',
  te: 'Telugu',
};

/** The pair the platform's own ASR agent declares, used only when the catalogue yields nothing. */
const FALLBACK_TAGS = ['en', 'ml'];

export function summaryLanguageLabel(tag: string): string {
  return LANGUAGE_NAMES[tag.split('-')[0]!.toLowerCase()] ?? tag;
}

/**
 * Every language the catalogue mentions, deduplicated, English first and then alphabetical by
 * label — English first because it is the platform's documentation language and a list that
 * opens on it is the one a clinician scans fastest, not because it is a default.
 */
export function deriveSummaryLanguages(modes: readonly LanguageModeLike[] | undefined): SummaryLanguageOption[] {
  const tags = new Set<string>();
  for (const mode of modes ?? []) {
    for (const candidate of [mode.primaryLanguage, mode.secondaryLanguage]) {
      if (typeof candidate === 'string' && candidate.trim().length > 0) tags.add(candidate.trim().toLowerCase());
    }
  }
  const resolved = tags.size > 0 ? [...tags] : FALLBACK_TAGS;
  return resolved
    .map((tag) => ({ tag, label: summaryLanguageLabel(tag) }))
    .sort((a, b) => (a.tag === 'en' ? -1 : b.tag === 'en' ? 1 : a.label.localeCompare(b.label)));
}
