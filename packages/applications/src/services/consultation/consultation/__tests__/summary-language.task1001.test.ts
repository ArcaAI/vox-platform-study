/**
 * TASK-1001 — the consultation's SOURCE language and the note's OUTPUT language are two different
 * values with two different grammars and two different owners.
 *
 * Owner decision 2026-09-23 (lane L5, "English by default"): *"ALaaS still sends the language:
 * `ml-en` indicates code-mixed/code-switch enabled for realtime/job transcription, Malayalam as the
 * main language. The summarization (both pre-summary and summary) is still in English, by admin
 * configuration OR by default."*
 *
 * So:
 *  - `ml-en` is a legitimate SOURCE value and is ACCEPTED at `POST /consultations/open` — lane L1's
 *    400 is reversed at the DTO boundary;
 *  - the OUTPUT language is the tenant's selected policy fragment, else the platform default, and
 *    the source tag is not an input to that decision at all;
 *  - an OUTPUT language still cannot be "mixed": the output grammar keeps refusing `ml-en`, which is
 *    also what keeps the frozen v1-compat `resolveV1LanguageName('ml-en')` on English.
 *
 * Testing Strategy: real `class-validator` `validate()` for the DTO (no mocks), plain calls for the
 * pure resolvers.
 */

import { describe, it, expect } from 'vitest';
import { validate } from 'class-validator';
import { plainToInstance } from 'class-transformer';
import {
  OUTPUT_LANGUAGE_DEFAULT,
  SOURCE_LANGUAGE_PATTERN,
  SUMMARY_LANGUAGE_PATTERN,
  parseLanguageTag,
  platformOutputLanguage,
  readSummaryLanguage,
  resolveOutputLanguage,
  withSummaryLanguage,
} from '../summary-language';
import { OpenConsultationRequest } from '../dto/open-consultation.request';
import { resolveV1LanguageName } from '../../prompt/pre-summary-variables';

describe('SOURCE_LANGUAGE_PATTERN — what is spoken, code-switch modes included', () => {
  it('accepts the code-switch modes ALaaS sends', () => {
    expect(SOURCE_LANGUAGE_PATTERN.test('ml-en')).toBe(true);
    expect(SOURCE_LANGUAGE_PATTERN.test('en-ml')).toBe(true);
  });

  it('accepts plain, region and script+region tags', () => {
    for (const tag of ['en', 'ml', 'en-IN', 'zh-Hant-HK']) expect(SOURCE_LANGUAGE_PATTERN.test(tag), tag).toBe(true);
  });

  it('still refuses the two things that arrive by accident — a display name and a sentence', () => {
    expect(SOURCE_LANGUAGE_PATTERN.test('English')).toBe(false);
    expect(SOURCE_LANGUAGE_PATTERN.test('write it in english')).toBe(false);
    expect(SOURCE_LANGUAGE_PATTERN.test('')).toBe(false);
  });
});

describe('SUMMARY_LANGUAGE_PATTERN — the OUTPUT grammar keeps refusing a "mixed" language', () => {
  it('refuses `ml-en` and `en-ml`: a note is written in ONE language', () => {
    expect(SUMMARY_LANGUAGE_PATTERN.test('ml-en')).toBe(false);
    expect(SUMMARY_LANGUAGE_PATTERN.test('en-ml')).toBe(false);
    expect(parseLanguageTag('ml-en')).toBeNull();
  });

  it('accepts `en`, `ml`, `en-IN` and `zh-Hant-HK`', () => {
    for (const tag of ['en', 'ml', 'en-IN', 'zh-Hant-HK']) expect(SUMMARY_LANGUAGE_PATTERN.test(tag), tag).toBe(true);
  });
});

describe('OpenConsultationRequest.language — the SOURCE language, `ml-en` accepted at the edge', () => {
  async function languageErrors(language: string): Promise<string[]> {
    const instance = plainToInstance(OpenConsultationRequest, { patientId: 'patient-1', language });
    const errors = await validate(instance);
    return errors.filter((e) => e.property === 'language').flatMap((e) => Object.values(e.constraints ?? {}));
  }

  it('ACCEPTS `ml-en` — the value ALaaS sends is a legitimate source declaration (L1`s 400 reversed)', async () => {
    expect(await languageErrors('ml-en')).toEqual([]);
  });

  it('accepts `en-ml`, `en`, `ml` and `en-IN`', async () => {
    for (const tag of ['en-ml', 'en', 'ml', 'en-IN']) expect(await languageErrors(tag), tag).toEqual([]);
  });

  it('still rejects a display name or a sentence, with a message that describes the field as the SOURCE language', async () => {
    const messages = await languageErrors('English');
    expect(messages).toHaveLength(1);
    expect(messages[0]).toContain('SOURCE');
    expect(messages[0]).toContain('ml-en');
    expect((await languageErrors('please write in english')).length).toBeGreaterThan(0);
  });
});

describe('readSummaryLanguage — reads the stored SOURCE tag back verbatim', () => {
  it('reads `ml-en` back as `ml-en` (it no longer reads as absent)', () => {
    expect(readSummaryLanguage(withSummaryLanguage({}, 'ml-en'))).toBe('ml-en');
    expect(readSummaryLanguage({ summaryLanguage: 'ml' })).toBe('ml');
  });

  it('reads a malformed or missing marker as absent', () => {
    expect(readSummaryLanguage({ summaryLanguage: 'English please' })).toBeNull();
    expect(readSummaryLanguage({})).toBeNull();
    expect(readSummaryLanguage(null)).toBeNull();
  });
});

describe('resolveOutputLanguage — admin configuration, otherwise the platform default', () => {
  it('a SELECTED tenant policy owns the language: the runtime states none (null)', () => {
    expect(resolveOutputLanguage(true, 'en')).toBeNull();
    expect(resolveOutputLanguage(true, undefined)).toBeNull();
  });

  it('with no policy selected, the platform default is stated — English by default', () => {
    expect(resolveOutputLanguage(false, undefined)).toEqual({ tag: 'en', name: 'English' });
    expect(resolveOutputLanguage(false, 'en')).toEqual({ tag: 'en', name: 'English' });
  });

  it('takes NO source tag: nothing a consultation declares can reach the answer', () => {
    // The signature is the assertion — two parameters, neither of them the consultation. Pinned so a
    // future "helpful" third parameter has to delete this line first.
    expect(resolveOutputLanguage.length).toBe(2);
  });

  it('a platform admin CAN change the default — `ml` is honoured', () => {
    expect(resolveOutputLanguage(false, 'ml')).toEqual({ tag: 'ml', name: 'Malayalam' });
  });
});

describe('platformOutputLanguage — an unusable stored value still yields ONE named language', () => {
  it('falls back to the code default, English, for anything that is not an OUTPUT tag', () => {
    for (const bad of [undefined, null, '', '   ', 'English', 'ml-en', 'en-ml', 42, true]) {
      expect(platformOutputLanguage(bad), String(bad)).toEqual({ tag: OUTPUT_LANGUAGE_DEFAULT, name: 'English' });
    }
    expect(OUTPUT_LANGUAGE_DEFAULT).toBe('en');
  });

  it('names the platform`s own languages and passes any other valid tag through verbatim', () => {
    expect(platformOutputLanguage('en-IN')).toEqual({ tag: 'en-IN', name: 'English' });
    expect(platformOutputLanguage('hi')).toEqual({ tag: 'hi', name: 'Hindi' });
    expect(platformOutputLanguage('fr')).toEqual({ tag: 'fr', name: 'fr' });
  });
});

/**
 * The FROZEN v1-compat surface keeps v1's contract, byte-pinned by golden fixtures, and this lane
 * does not touch it: `resolveV1LanguageName` still runs the tag through the OUTPUT grammar, so the
 * source-grammar widening above can never make `ml-en` read as Malayalam there.
 */
describe('resolveV1LanguageName — v1 parity kept, code-switch defused (unchanged by L5)', () => {
  it("keeps v1's English default when no language is declared", () => {
    expect(resolveV1LanguageName(undefined)).toBe('English');
    expect(resolveV1LanguageName(null)).toBe('English');
    expect(resolveV1LanguageName('   ')).toBe('English');
  });

  it("keeps v1's unknown -> English rule for a valid but unmapped tag", () => {
    expect(resolveV1LanguageName('fr')).toBe('English');
  });

  it('still maps known tags to their display name', () => {
    expect(resolveV1LanguageName('en')).toBe('English');
    expect(resolveV1LanguageName('ml-IN')).toBe('Malayalam');
  });

  /** THE defect on this surface: `ml-en` was reduced to `ml` and the prompt then said "write Malayalam". */
  it('`ml-en` is still English — never Malayalam', () => {
    expect(resolveV1LanguageName('ml-en')).toBe('English');
    expect(resolveV1LanguageName('en-ml')).toBe('English');
  });
});
