/**
 * TASK-1001 (owner decision 2026-09-23, OD-12) — the ONE read of the platform-default note OUTPUT
 * language, `consultation.summary.outputLanguage`, for the summary paths: `SummaryService` (direct
 * pre-summary and final summary), `ChainSummaryService`, and the pre-summary / comprehensive-summary
 * queue processors.
 *
 * *"The summarization (both pre-summary and summary) is still in English, by admin configuration OR
 * by default."* None of these paths can SELECT a tenant output-language policy fragment — prompt
 * assembly resolves an agent's primary template, never its fragment list — so what they write in is
 * the platform default. Two sources are therefore never consulted:
 *  - the consultation's declared language — it is the SOURCE language (`ml-en` is what the
 *    microphone hears), never what the note is written in;
 *  - a caller's per-request `options.conversationLanguage` / `language` / `locale` — neither admin
 *    configuration nor the default, and a client forwarding its STT locale there reproduced the
 *    code-switched note this ticket was opened for.
 *
 * It lives beside its callers rather than in `summary-language.ts` because it needs the descriptor
 * key, and the descriptor already imports `summary-language.ts` — importing back would be a cycle.
 */
import { OUTPUT_LANGUAGE_DEFAULT, platformOutputLanguage, type OutputLanguage } from '../consultation/summary-language';
import { CONSULTATION_OUTPUT_LANGUAGE_KEY } from '../../settings-registry/descriptors/consultation-output-language.descriptors';
import type { EffectiveSettingsService } from '../../settings-registry/effective-settings.service';

/**
 * The resolved `consultation.summary.outputLanguage` for `tenantId`, as a tag and the name a prompt
 * states (`summaryLanguageName`, so `hi` is "Hindi" — never the frozen v1-compat map, which knows only
 * en/ml and would name it "English").
 *
 * Never throws: a settings-backend failure is logged and the note is written in the code default
 * (English) rather than failing a clinician's summary. An unwired settings graph (positional test
 * fixtures) answers the same default.
 */
export async function resolvePlatformOutputLanguage(
  settings: Pick<EffectiveSettingsService, 'resolveEffective'> | undefined,
  tenantId: string,
  logger: { warn(message: unknown): void },
): Promise<OutputLanguage> {
  if (!settings) return platformOutputLanguage(OUTPUT_LANGUAGE_DEFAULT);
  try {
    const resolved = await settings.resolveEffective(CONSULTATION_OUTPUT_LANGUAGE_KEY, { tenantId });
    return platformOutputLanguage(resolved.value);
  } catch (error) {
    logger.warn({
      message: 'consultation.summary.outputLanguage could not be resolved — writing the note in the code default',
      tenantId,
      error: error instanceof Error ? error.message : String(error),
    });
    return platformOutputLanguage(OUTPUT_LANGUAGE_DEFAULT);
  }
}
