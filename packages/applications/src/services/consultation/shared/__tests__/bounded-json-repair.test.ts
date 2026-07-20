/**
 * bounded-json-repair — the shared single-retry JSON auto-repair contract
 */
import { describe, it, expect, vi } from 'vitest';
import { CORRECTIVE_RETRY_INSTRUCTION, generateJsonWithRepair, looksLikeJsonObject } from '../bounded-json-repair';

interface Call {
  text: string;
  structured: boolean;
}

const parseStrict = (text: string): { ok: string } | null => {
  try {
    const parsed = JSON.parse(text) as { ok?: unknown };
    return typeof parsed.ok === 'string' ? { ok: parsed.ok } : null;
  } catch {
    return null;
  }
};
const parseTolerant = (text: string): { ok: string } => ({ ok: `tolerant:${text}` });

describe('generateJsonWithRepair', () => {
  it('returns the first strict parse and does NOT retry when the first response is valid', async () => {
    const generate = vi.fn(async () => ({ text: '{"ok":"first"}', structured: true }) as Call);
    const outcome = await generateJsonWithRepair({ generate, parseStrict, parseTolerant, shouldRepair: (c) => c.structured });

    expect(generate).toHaveBeenCalledTimes(1);
    expect(outcome.repaired).toBe(false);
    expect(outcome.value).toEqual({ ok: 'first' });
    expect(outcome.calls).toHaveLength(1);
  });

  it('retries EXACTLY once with the corrective instruction, then returns the repaired parse', async () => {
    const generate = vi
      .fn<(c: string | undefined) => Promise<Call>>()
      .mockResolvedValueOnce({ text: '{"ok": broken', structured: true })
      .mockResolvedValueOnce({ text: '{"ok":"second"}', structured: true });

    const outcome = await generateJsonWithRepair({ generate, parseStrict, parseTolerant, shouldRepair: (c) => c.structured });

    expect(generate).toHaveBeenCalledTimes(2);
    expect(generate).toHaveBeenNthCalledWith(1, undefined);
    expect(generate).toHaveBeenNthCalledWith(2, CORRECTIVE_RETRY_INSTRUCTION);
    expect(outcome.repaired).toBe(true);
    expect(outcome.value).toEqual({ ok: 'second' });
    expect(outcome.calls).toHaveLength(2);
  });

  it('falls back to the tolerant parser (still ONE retry) when the repair is also invalid', async () => {
    const generate = vi
      .fn<(c: string | undefined) => Promise<Call>>()
      .mockResolvedValueOnce({ text: '{"ok": broken', structured: true })
      .mockResolvedValueOnce({ text: '{still broken', structured: true });

    const outcome = await generateJsonWithRepair({ generate, parseStrict, parseTolerant, shouldRepair: (c) => c.structured });

    expect(generate).toHaveBeenCalledTimes(2);
    expect(outcome.repaired).toBe(true);
    expect(outcome.value).toEqual({ ok: 'tolerant:{still broken' });
  });

  it('does not retry when shouldRepair is false (engine ignored structured output)', async () => {
    const generate = vi.fn(async () => ({ text: 'plain prose', structured: false }) as Call);
    const outcome = await generateJsonWithRepair({ generate, parseStrict, parseTolerant, shouldRepair: (c) => c.structured });

    expect(generate).toHaveBeenCalledTimes(1);
    expect(outcome.repaired).toBe(false);
    expect(outcome.value).toEqual({ ok: 'tolerant:plain prose' });
  });
});

describe('looksLikeJsonObject', () => {
  it('detects a bare or fenced JSON object attempt', () => {
    expect(looksLikeJsonObject('{"a":1}')).toBe(true);
    expect(looksLikeJsonObject('  {"a": broken')).toBe(true);
    expect(looksLikeJsonObject('```json\n{"a":1}\n```')).toBe(true);
  });

  it('rejects clean prose (no leading brace)', () => {
    expect(looksLikeJsonObject('Pt on amlodipine.')).toBe(false);
    expect(looksLikeJsonObject('Subjective: chest pain')).toBe(false);
    expect(looksLikeJsonObject('')).toBe(false);
  });
});
