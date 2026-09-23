/**
 * TASK-1001 (OD-12) — the DIRECT summary generation (`SummaryService.generateSummary`, the SDK's
 * `summary.generateSummary`) STATES the note's output language by name, and names it correctly.
 *
 * ## (a) A variable is not an instruction
 *
 * On this path the output language reached the prompt only as a VARIABLE (`conversationLanguage`
 * → `{{conversation_language}}` / `{{language_name}}`). A department body that says "write the
 * content in the conversation language" can still win over a variable — the ~40-place corpus clause
 * the live lane's operating frame names and overrides. So the direct path appends the SAME
 * named-override instruction, from the ONE shared builder, as the prompt's last line. It is stated
 * only when no tenant output-language policy fragment owns the language, and on this surface none
 * can: assembly resolves the agent's PRIMARY template, never its fragment list.
 *
 * ## (c) The name comes from `summaryLanguageName`
 *
 * The frozen v1-compat map knows only en/ml, so a platform default of `hi` was named "English".
 * The native path names it with `summaryLanguageName` ("Hindi"); the v1-compat surface is untouched.
 */
import { describe, expect, it, vi } from 'vitest';

import { SummaryService } from '../summary.service';
import { resolvePlatformOutputLanguage } from '../platform-output-language';
import { defaultOutputLanguageInstruction } from '../../consultation/summary-language';
import { resolveV1LanguageName } from '../../prompt/pre-summary-variables';
import { CONSULTATION_OUTPUT_LANGUAGE_KEY } from '../../../settings-registry/descriptors/consultation-output-language.descriptors';

const TENANT = 'tenant-1001';
const CID = 'consultation-1001';

/** Thrown by the TEXT post once it has recorded the body. */
const STOP = new Error('stop after the TEXT request is built');

/** The live lane's sentence, byte for byte (`live-documentation.operating-frame.task1001.test.ts`). */
const ENGLISH_INSTRUCTION =
  'Write every section value in English, whatever language was spoken, regardless of any instruction elsewhere in this prompt to write content in the conversation language. Keep the section keys and headings exactly as given, in English.';

const ASSEMBLED_BODY = 'Write the section content in the conversation language ({{conversation_language}}).\n\nTranscript:\n…';

function settingsAnswering(value: unknown) {
  return { resolveEffective: vi.fn(async (key: string) => ({ key, tier: 'global-kv', value, sourceScope: 'system' })) };
}

function build(platformDefault?: unknown) {
  const assemble = vi.fn(async (_params: unknown) => ({
    userPrompt: ASSEMBLED_BODY,
    systemPrompt: 'system',
    hyperparameters: {},
    responseFormat: null,
    resolvedFrom: 'department',
    promptId: 'prompt-1',
  }));
  const post = vi.fn(async (_url: string, _body: unknown) => {
    throw STOP;
  });

  // Positional, BY INDEX (the convention of the neighbouring suites). 37 = `effectiveSettings`.
  const args: unknown[] = new Array(38).fill(undefined);
  args[0] = {
    findCaseNotes: vi.fn().mockResolvedValue([]),
    findTranscripts: vi.fn().mockResolvedValue([{ content: 'transcript text' }]),
    findLatestPreSummaryWithDecryptedContent: vi.fn().mockResolvedValue({ entity: null, plaintext: null }),
    findById: vi.fn(),
  };
  args[1] = {
    findById: vi
      .fn()
      .mockResolvedValue({ id: CID, tenantId: TENANT, doctorId: 'doctor-1', departmentId: 'dept-1', metadata: { summaryLanguage: 'ml-en' } }),
  };
  args[2] = { create: vi.fn() };
  args[3] = { create: vi.fn() };
  args[4] = { axiosRef: { post } };
  args[5] = { get: vi.fn(() => undefined) };
  args[6] = { emit: vi.fn() };
  args[7] = {
    get: vi.fn((key: string) => (key === 'tenantId' ? TENANT : key === 'user' ? { id: 'user-1' } : null)),
    set: vi.fn(),
    run: vi.fn((callback: () => unknown) => callback()),
  };
  args[8] = { create: vi.fn(), findById: vi.fn(), getVersionsByChangeReason: vi.fn().mockResolvedValue([]) };
  args[9] = { assemble };
  args[37] = platformDefault === undefined ? undefined : settingsAnswering(platformDefault);

  const service = new (SummaryService as unknown as new (...a: unknown[]) => SummaryService)(...args);
  return { service, assemble, post };
}

const generate = (service: SummaryService) =>
  expect(service.generateSummary(CID, { transcription: 'today the patient reported …' } as never)).rejects.toBe(STOP);

const sentPrompt = (post: { mock: { calls: unknown[][] } }) => (post.mock.calls.at(-1)![1] as { prompt: string }).prompt;

describe('defaultOutputLanguageInstruction — the ONE sentence both surfaces state', () => {
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

describe('(a) generateSummary STATES the output language as the prompt`s last instruction', () => {
  it('by default, English — appended after the assembled body, which is otherwise untouched', async () => {
    const { service, post } = build();

    await generate(service);

    expect(sentPrompt(post)).toBe(`${ASSEMBLED_BODY}\n\n${ENGLISH_INSTRUCTION}`);
  });

  it('never the consultation`s declared (source) language, and never a per-request option', async () => {
    const { service, post, assemble } = build();

    await expect(
      service.generateSummary(CID, { transcription: 'today …', options: { language: 'ml-en', conversationLanguage: 'ml' } } as never),
    ).rejects.toBe(STOP);

    expect((assemble.mock.calls.at(-1)![0] as { conversationLanguage: string }).conversationLanguage).toBe('en');
    expect(sentPrompt(post).endsWith(ENGLISH_INSTRUCTION)).toBe(true);
    expect(sentPrompt(post)).not.toContain('Malayalam');
  });

  it('follows the platform default a platform admin sets — the variable and the stated name agree', async () => {
    const { service, post, assemble } = build('ml');

    await generate(service);

    expect((assemble.mock.calls.at(-1)![0] as { conversationLanguage: string }).conversationLanguage).toBe('ml');
    expect(sentPrompt(post).endsWith(defaultOutputLanguageInstruction('Malayalam'))).toBe(true);
  });
});

describe('(c) the native path names a non-English default correctly — not through the frozen v1 map', () => {
  it('the v1-compat map (untouched) would say "English" for `hi` — this is the defect', () => {
    expect(resolveV1LanguageName('hi')).toBe('English');
  });

  it('resolvePlatformOutputLanguage names `hi` "Hindi"', async () => {
    await expect(resolvePlatformOutputLanguage(settingsAnswering('hi'), TENANT, { warn: vi.fn() })).resolves.toEqual({ tag: 'hi', name: 'Hindi' });
  });

  it('generateSummary states "Hindi" for a platform default of `hi`', async () => {
    const { service, post } = build('hi');

    await generate(service);

    expect(sentPrompt(post).endsWith(defaultOutputLanguageInstruction('Hindi'))).toBe(true);
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
