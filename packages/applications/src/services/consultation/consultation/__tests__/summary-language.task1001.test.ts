/**
 * TASK-1001 Phase 1 (OD-4) — `ml-en` is the STT code-switch mode, not an output-language tag, and
 * must be rejected rather than collapsed to "Malayalam".
 * TASK-1001 Phase 2 (OD-2) — one summary-language resolver, one absent-posture: `null` is never
 * silently coerced to `'English'`.
 *
 * Testing Strategy: real `class-validator` `validate()` for the DTO-level assertions (no mocks),
 * plain function calls for the resolver-level assertions.
 */

import { describe, it, expect } from 'vitest';
import { validate } from 'class-validator';
import { plainToInstance } from 'class-transformer';
import { SUMMARY_LANGUAGE_PATTERN, resolveSummaryLanguage } from '../summary-language';
import { OpenConsultationRequest } from '../dto/open-consultation.request';
import { resolveV1LanguageName } from '../../prompt/pre-summary-variables';

describe('SUMMARY_LANGUAGE_PATTERN — OD-4 code-switch rejection', () => {
  it('rejects `ml-en`, the STT code-switch mode, not a region tag', () => {
    expect(SUMMARY_LANGUAGE_PATTERN.test('ml-en')).toBe(false);
  });

  it('rejects `en-ml`, the reversed code-switch mode', () => {
    expect(SUMMARY_LANGUAGE_PATTERN.test('en-ml')).toBe(false);
  });

  it('accepts bare language tags `en` and `ml`', () => {
    expect(SUMMARY_LANGUAGE_PATTERN.test('en')).toBe(true);
    expect(SUMMARY_LANGUAGE_PATTERN.test('ml')).toBe(true);
  });

  it('accepts the legitimate region tag `en-IN`', () => {
    expect(SUMMARY_LANGUAGE_PATTERN.test('en-IN')).toBe(true);
  });

  it('accepts a script+region tag `zh-Hant-HK`', () => {
    expect(SUMMARY_LANGUAGE_PATTERN.test('zh-Hant-HK')).toBe(true);
  });
});

describe('OpenConsultationRequest.language — 400 at the edge (OD-4)', () => {
  async function validateLanguage(language: string): Promise<string[]> {
    const instance = plainToInstance(OpenConsultationRequest, { patientId: 'patient-1', language });
    const errors = await validate(instance);
    return errors.filter((e) => e.property === 'language').flatMap((e) => Object.values(e.constraints ?? {}));
  }

  it('rejects `ml-en` with a message naming both the note language and the STT decoding mode', async () => {
    const messages = await validateLanguage('ml-en');
    expect(messages).toHaveLength(1);
    expect(messages[0]).toContain('language');
    expect(messages[0]).toContain('languageMode');
    expect(messages[0]).toContain('ml-en');
  });

  it('rejects `en-ml`', async () => {
    const messages = await validateLanguage('en-ml');
    expect(messages.length).toBeGreaterThan(0);
  });

  it('accepts `en-IN` with no validation errors on `language`', async () => {
    const messages = await validateLanguage('en-IN');
    expect(messages).toHaveLength(0);
  });
});

describe('resolveSummaryLanguage — one resolver, one absent-posture (OD-2)', () => {
  it('returns the configured language when one is set, even if the consultation declares a different one', () => {
    const consultationMetadata = { summaryLanguage: 'ml' };
    expect(resolveSummaryLanguage('en', consultationMetadata)).toBe('English');
  });

  it("returns the consultation's declaration when nothing is configured", () => {
    const consultationMetadata = { summaryLanguage: 'ml' };
    expect(resolveSummaryLanguage(undefined, consultationMetadata)).toBe('Malayalam');
    expect(resolveSummaryLanguage(null, consultationMetadata)).toBe('Malayalam');
  });

  it('returns null when neither is present — never `English`', () => {
    expect(resolveSummaryLanguage(undefined, undefined)).toBeNull();
    expect(resolveSummaryLanguage(null, {})).toBeNull();
    expect(resolveSummaryLanguage(undefined, undefined)).not.toBe('English');
  });

  it('preserves the existing name-to-display mapping for tags that ARE valid', () => {
    expect(resolveSummaryLanguage('en', undefined)).toBe('English');
    expect(resolveSummaryLanguage('ml', undefined)).toBe('Malayalam');
    expect(resolveSummaryLanguage('hi', undefined)).toBe('Hindi');
    expect(resolveSummaryLanguage('ta', undefined)).toBe('Tamil');
    expect(resolveSummaryLanguage('kn', undefined)).toBe('Kannada');
    expect(resolveSummaryLanguage('te', undefined)).toBe('Telugu');
  });

  it('treats a code-switch-shaped configured or declared value as no opinion, never as the language', () => {
    // A rejected `configuredLanguage` falls through to the consultation's own declaration.
    expect(resolveSummaryLanguage('ml-en', { summaryLanguage: 'en' })).toBe('English');
    // A rejected declaration with nothing configured resolves to null, not Malayalam.
    expect(resolveSummaryLanguage(undefined, { summaryLanguage: 'ml-en' })).toBeNull();
  });
});

/**
 * TASK-1001 — the FROZEN v1-compat surface keeps v1's `'English'` default, and that is a
 * deliberate reversal of this ticket's first draft (§A2 called the default "drift").
 *
 * It is parity, and it is load-bearing. Unlike the compat SUMMARY prompt — whose output language
 * became an unconditional `SUMMARY_OUTPUT_LANGUAGE` directive on 2026-08-10 — the compat
 * PRE-SUMMARY template still renders `{language_name}` into a live instruction ("Write ALL bullet
 * content in {language_name}"), and byte-identical golden fixtures pin it. Resolving an absent
 * language to null there would emit "Write ALL bullet content in ." — a degenerate prompt, which
 * is worse than the default it replaced.
 *
 * The NATIVE path keeps the opposite posture (`resolveSummaryLanguage`: absent means undeclared,
 * never English). Two surfaces, two contracts — not a disagreement to collapse.
 */
describe('resolveV1LanguageName — v1 parity kept, code-switch defused (OD-4)', () => {
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

  /** THE defect: `ml-en` was reduced to `ml` and the prompt then said "write Malayalam". */
  it('refuses a code-switch tag instead of reducing it to Malayalam', () => {
    expect(resolveV1LanguageName('ml-en')).toBe('English');
    expect(resolveV1LanguageName('en-ml')).toBe('English');
  });
});
