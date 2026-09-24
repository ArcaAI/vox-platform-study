/**
 * TASK-1004 — the gateway half of the pinned language contract
 * (`tests/contracts/language-resolution.fixture.json`).
 *
 * The SAME fixture pins `apps/stt`'s `normalize_language_mode` and receipt builder, so a table
 * row changed on one side and not the other fails here or there, never silently in production.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { BadRequestException } from '@nestjs/common';
import {
  LANGUAGE_MODE_IDS,
  LANGUAGE_MODE_SOURCES,
  LANGUAGE_MODE_UNKNOWN,
  LANGUAGE_RESOLUTION_REASONS,
  languageResolutionFromWire,
  normalizeLanguageMode,
  requireLanguageMode,
  resolveEffectiveLanguageMode,
} from '../language-mode';

interface Fixture {
  catalogIds: string[];
  normalize: Array<{ input: string; expected: string | null }>;
  precedence: Array<{
    request: string | null;
    consultation: string | null;
    agent: string | null;
    expected: { mode: string; source: string };
  }>;
  enums: { source: string[]; reason: string[] };
  receipt: {
    keys: string[];
    paramsKeys: string[];
    examples: Array<{ name: string; python: Record<string, unknown>; gateway: Record<string, unknown> }>;
  };
}

const FIXTURE_PATH = resolve(__dirname, '../../../../../../tests/contracts/language-resolution.fixture.json');
const fixture = JSON.parse(readFileSync(FIXTURE_PATH, 'utf-8')) as Fixture;

describe('normalizeLanguageMode — parity with the pinned normalize table', () => {
  it('knows exactly the catalog ids the fixture pins', () => {
    expect([...LANGUAGE_MODE_IDS].sort()).toEqual([...fixture.catalogIds].sort());
  });

  it.each(fixture.normalize)('normalize($input) → $expected', ({ input, expected }) => {
    expect(normalizeLanguageMode(input)).toBe(expected);
  });

  it('a non-string is not a mode', () => {
    expect(normalizeLanguageMode(undefined)).toBeNull();
    expect(normalizeLanguageMode(42)).toBeNull();
  });
});

describe('requireLanguageMode — the edge refusal', () => {
  it('absent is absent, not an error', () => {
    expect(requireLanguageMode(undefined, 'languageMode')).toBeNull();
    expect(requireLanguageMode(null, 'languageMode')).toBeNull();
  });

  it('a normalizable value comes back normalized', () => {
    expect(requireLanguageMode('ML-IN', 'language')).toBe('ml');
  });

  it('an unknown value is 400 LANGUAGE_MODE_UNKNOWN naming the field and the catalog', () => {
    let thrown: unknown;
    try {
      requireLanguageMode('fr-FR', 'language');
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(BadRequestException);
    const body = (thrown as BadRequestException).getResponse() as Record<string, unknown>;
    expect(body.code).toBe(LANGUAGE_MODE_UNKNOWN);
    expect(body.field).toBe('language');
    expect(body.catalog).toEqual([...LANGUAGE_MODE_IDS]);
    expect(String(body.message)).toContain('ml-en');
  });
});

describe('resolveEffectiveLanguageMode — the pinned precedence table', () => {
  it.each(fixture.precedence)('request=$request consultation=$consultation agent=$agent', ({ request, consultation, agent, expected }) => {
    expect(resolveEffectiveLanguageMode({ request, consultation, agent })).toEqual(expected);
  });

  it('never names an engine or an agent — its answer is a mode and a tier, nothing else', () => {
    const answer = resolveEffectiveLanguageMode({ request: 'ml-en', consultation: 'en', agent: 'ml' });
    expect(Object.keys(answer).sort()).toEqual(['mode', 'source']);
  });

  it('a stored value that is not a mode is skipped, not trusted', () => {
    expect(resolveEffectiveLanguageMode({ request: null, consultation: 'fr', agent: 'ml-IN' })).toEqual({ mode: 'ml', source: 'agent' });
  });
});

describe('languageResolutionFromWire — python snake_case → gateway camelCase', () => {
  it('closed enums match the fixture', () => {
    expect([...LANGUAGE_MODE_SOURCES]).toEqual(fixture.enums.source);
    expect([...LANGUAGE_RESOLUTION_REASONS]).toEqual(fixture.enums.reason);
  });

  it.each(fixture.receipt.examples)('$name — object form', ({ python, gateway }) => {
    const projected = languageResolutionFromWire(python);
    expect(projected).toEqual(gateway);
    expect(Object.keys(projected ?? {}).sort()).toEqual([...fixture.receipt.keys].sort());
    expect(Object.keys((projected?.params ?? {}) as object).sort()).toEqual([...fixture.receipt.paramsKeys].sort());
  });

  it.each(fixture.receipt.examples)('$name — JSON-string form (the result-stream status field)', ({ python, gateway }) => {
    expect(languageResolutionFromWire(JSON.stringify(python))).toEqual(gateway);
  });

  it('an already-camelCase receipt round-trips unchanged', () => {
    const { gateway } = fixture.receipt.examples[0]!;
    expect(languageResolutionFromWire(gateway)).toEqual(gateway);
  });

  it('a value outside the closed enums, malformed JSON, or a missing key is dropped (null), never relayed', () => {
    const { python } = fixture.receipt.examples[0]!;
    expect(languageResolutionFromWire({ ...python, source: 'guess' })).toBeNull();
    expect(languageResolutionFromWire({ ...python, reason: 'because' })).toBeNull();
    expect(languageResolutionFromWire('{not json')).toBeNull();
    expect(languageResolutionFromWire({ ...python, params: undefined })).toBeNull();
    expect(languageResolutionFromWire(null)).toBeNull();
    expect(languageResolutionFromWire('')).toBeNull();
  });
});
