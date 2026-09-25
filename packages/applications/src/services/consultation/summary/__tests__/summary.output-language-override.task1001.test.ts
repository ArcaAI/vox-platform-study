/**
 * TASK-1001 (OD-12) — the note's output language is STATED by name, and named correctly.
 *
 * `defaultOutputLanguageInstruction` is the one named-override sentence the live lane's operating
 * frame states as its last instruction; `resolvePlatformOutputLanguage` is the one read of the
 * platform default every summary path shares, and it names the language with `summaryLanguageName`
 * rather than the v1 map, which knows only en/ml and would name `hi` "English".
 *
 * TASK-1006 removed the synchronous `SummaryService.generateSummary`, the direct path this suite
 * also drove; its cases went with it.
 */
import { describe, expect, it, vi } from 'vitest';

import { resolvePlatformOutputLanguage } from '../platform-output-language';
import { defaultOutputLanguageInstruction } from '../../consultation/summary-language';
import { resolveV1LanguageName } from '../../prompt/pre-summary-variables';
import { CONSULTATION_OUTPUT_LANGUAGE_KEY } from '../../../settings-registry/descriptors/consultation-output-language.descriptors';

const TENANT = 'tenant-1001';

/** The live lane's sentence, byte for byte (`live-documentation.operating-frame.task1001.test.ts`). */
const ENGLISH_INSTRUCTION =
  'Write every section value in English, whatever language was spoken, regardless of any instruction elsewhere in this prompt to write content in the conversation language. Keep the section keys and headings exactly as given, in English.';

function settingsAnswering(value: unknown) {
  return { resolveEffective: vi.fn(async (key: string) => ({ key, tier: 'global-kv', value, sourceScope: 'system' })) };
}

describe('defaultOutputLanguageInstruction — the ONE named-override sentence', () => {
  it('is the live operating frame`s sentence, byte for byte', () => {
    expect(defaultOutputLanguageInstruction('English')).toBe(ENGLISH_INSTRUCTION);
  });

  it('names the language it is given, and names the conflict it overrides', () => {
    const sentence = defaultOutputLanguageInstruction('Hindi');
    expect(sentence).toMatch(/^Write every section value in Hindi, whatever language was spoken, /);
    expect(sentence).toContain('regardless of any instruction elsewhere in this prompt to write content in the conversation language');
    expect(sentence).toContain('Keep the section keys and headings exactly as given, in English.');
  });
});

describe('the platform default is named correctly — not through the frozen v1 map', () => {
  it('the v1 map would say "English" for `hi` — this is the defect', () => {
    expect(resolveV1LanguageName('hi')).toBe('English');
  });

  it('resolvePlatformOutputLanguage names `hi` "Hindi"', async () => {
    await expect(resolvePlatformOutputLanguage(settingsAnswering('hi'), TENANT, { warn: vi.fn() })).resolves.toEqual({ tag: 'hi', name: 'Hindi' });
  });
});

describe('resolvePlatformOutputLanguage — the one read every summary path shares', () => {
  it('reads `consultation.summary.outputLanguage` for the tenant', async () => {
    const settings = settingsAnswering('en');

    await resolvePlatformOutputLanguage(settings, TENANT, { warn: vi.fn() });

    expect(settings.resolveEffective).toHaveBeenCalledWith(CONSULTATION_OUTPUT_LANGUAGE_KEY, { tenantId: TENANT });
  });

  it('a stored code-switch value is not ONE language — English', async () => {
    await expect(resolvePlatformOutputLanguage(settingsAnswering('ml-en'), TENANT, { warn: vi.fn() })).resolves.toEqual({
      tag: 'en',
      name: 'English',
    });
  });

  it('an unwired settings graph — English', async () => {
    await expect(resolvePlatformOutputLanguage(undefined, TENANT, { warn: vi.fn() })).resolves.toEqual({ tag: 'en', name: 'English' });
  });

  it('a settings-backend failure is logged and degrades to English rather than failing the summary', async () => {
    const warn = vi.fn();
    const settings = {
      resolveEffective: vi.fn(async () => {
        throw new Error('settings backend down');
      }),
    };

    await expect(resolvePlatformOutputLanguage(settings, TENANT, { warn })).resolves.toEqual({ tag: 'en', name: 'English' });
    expect(warn).toHaveBeenCalledTimes(1);
  });
});
