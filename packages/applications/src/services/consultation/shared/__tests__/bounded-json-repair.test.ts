/**
 * bounded-json-repair — the shared single-retry JSON auto-repair contract
 *
 * TASK-1000 amended this file in two ways, both deliberate behaviour changes:
 *
 *  - the `generate` closure now receives a RETRY DESCRIPTOR (`{ corrective, maxTokens }`)
 *    rather than a bare corrective string, so the one retry can be given a LARGER output
 *    budget than the attempt it is repairing;
 *  - a generation the engine cut off at its output cap (`stop_reason: 'length'`) is now
 *    FATAL rather than tolerantly parsed. A truncated response is not malformed JSON that a
 *    reworded prompt can fix — it is a budget failure, and degrading it hands the caller a
 *    partial payload that looks like a successful parse.
 */
import { describe, it, expect, vi } from 'vitest';
import {
  CORRECTIVE_RETRY_INSTRUCTION,
  generateJsonWithRepair,
  JsonRepairRetry,
  looksLikeJsonObject,
  TruncatedGenerationError,
} from '../bounded-json-repair';

interface Call {
  text: string;
  structured: boolean;
  maxTokens?: number;
  truncated?: boolean;
}

const parseStrict = (text: string): { ok: string } | null => {
  try {
    const parsed = JSON.parse(text) as { ok?: unknown };
    return typeof parsed.ok === 'string' ? { ok: parsed.ok } : null;
  } catch {
    return null;
  }
};
const parseTolerant = (call: Call): { ok: string } => ({ ok: `tolerant:${call.text}` });
const isTruncated = (call: Call): boolean => call.truncated === true;

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
      .fn<(r: JsonRepairRetry | undefined) => Promise<Call>>()
      .mockResolvedValueOnce({ text: '{"ok": broken', structured: true })
      .mockResolvedValueOnce({ text: '{"ok":"second"}', structured: true });

    const outcome = await generateJsonWithRepair({ generate, parseStrict, parseTolerant, shouldRepair: (c) => c.structured });

    expect(generate).toHaveBeenCalledTimes(2);
    expect(generate).toHaveBeenNthCalledWith(1, undefined);
    expect(generate).toHaveBeenNthCalledWith(2, { corrective: CORRECTIVE_RETRY_INSTRUCTION, maxTokens: undefined });
    expect(outcome.repaired).toBe(true);
    expect(outcome.value).toEqual({ ok: 'second' });
    expect(outcome.calls).toHaveLength(2);
  });

  it('falls back to the tolerant parser (still ONE retry) when the repair is also invalid', async () => {
    const generate = vi
      .fn<(r: JsonRepairRetry | undefined) => Promise<Call>>()
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

  // ── TASK-1000 — the raised repair budget ────────────────────────────────────

  it('gives the corrective retry the RAISED budget, not the budget that just truncated', async () => {
    const generate = vi
      .fn<(r: JsonRepairRetry | undefined) => Promise<Call>>()
      .mockResolvedValueOnce({ text: '{"ok": "cut off mid-str', structured: true, truncated: true })
      .mockResolvedValueOnce({ text: '{"ok":"second"}', structured: true });

    await generateJsonWithRepair({ generate, parseStrict, parseTolerant, shouldRepair: (c) => c.structured, isTruncated, repairMaxTokens: 16384 });

    expect(generate).toHaveBeenNthCalledWith(1, undefined);
    expect(generate).toHaveBeenNthCalledWith(2, { corrective: CORRECTIVE_RETRY_INSTRUCTION, maxTokens: 16384 });
  });

  it('a truncated first attempt that the retry COMPLETES is an ordinary repair, not a failure', async () => {
    const generate = vi
      .fn<(r: JsonRepairRetry | undefined) => Promise<Call>>()
      .mockResolvedValueOnce({ text: '{"ok": "cut off mid-str', structured: true, truncated: true })
      .mockResolvedValueOnce({ text: '{"ok":"second"}', structured: true });

    const outcome = await generateJsonWithRepair({
      generate,
      parseStrict,
      parseTolerant,
      shouldRepair: (c) => c.structured,
      isTruncated,
      repairMaxTokens: 16384,
    });

    expect(outcome.repaired).toBe(true);
    expect(outcome.value).toEqual({ ok: 'second' });
  });

  // ── TASK-1000 — truncation is fatal, never degraded ─────────────────────────

  it('THROWS when the retry is also truncated — a partial payload is never tolerantly parsed', async () => {
    const generate = vi
      .fn<(r: JsonRepairRetry | undefined) => Promise<Call>>()
      .mockResolvedValueOnce({ text: '{"ok": "cut off', structured: true, truncated: true })
      .mockResolvedValueOnce({ text: '{"ok": "cut off again', structured: true, truncated: true });

    const tolerant = vi.fn(parseTolerant);
    await expect(
      generateJsonWithRepair({ generate, parseStrict, parseTolerant: tolerant, shouldRepair: (c) => c.structured, isTruncated }),
    ).rejects.toThrow(TruncatedGenerationError);

    expect(generate).toHaveBeenCalledTimes(2);
    // The whole point: the caller must never receive a half-document that parsed "fine".
    expect(tolerant).not.toHaveBeenCalled();
  });

  it('THROWS on a truncated first attempt that is not eligible for repair', async () => {
    // An engine that ignores `response_format` still cannot produce a usable half-document.
    const generate = vi.fn(async () => ({ text: 'Subjective: cough, fev', structured: false, truncated: true }) as Call);

    await expect(generateJsonWithRepair({ generate, parseStrict, parseTolerant, shouldRepair: (c) => c.structured, isTruncated })).rejects.toThrow(
      TruncatedGenerationError,
    );
    expect(generate).toHaveBeenCalledTimes(1);
  });

  it('carries the calls it made on the error, so the caller can still record the trajectory', async () => {
    const generate = vi.fn(async () => ({ text: '{"ok": "cut', structured: false, truncated: true }) as Call);

    await expect(generateJsonWithRepair({ generate, parseStrict, parseTolerant, shouldRepair: () => false, isTruncated })).rejects.toMatchObject({
      calls: [{ text: '{"ok": "cut' }],
    });
  });

  it('without an `isTruncated` probe the contract is unchanged — tolerant parse, no throw', async () => {
    const generate = vi.fn(async () => ({ text: '{"ok": "cut', structured: false, truncated: true }) as Call);

    const outcome = await generateJsonWithRepair({ generate, parseStrict, parseTolerant, shouldRepair: (c) => c.structured });

    expect(outcome.value).toEqual({ ok: 'tolerant:{"ok": "cut' });
  });
});

// TASK-1001 (owner directive 2026-09-23: "all pre-summary and summary must be in english") — the
// corrective retry is appended to a summary prompt, so its language rule must name English.
describe('CORRECTIVE_RETRY_INSTRUCTION', () => {
  it('demands English whatever language was spoken, and names no conversation language', () => {
    expect(CORRECTIVE_RETRY_INSTRUCTION).toContain(
      'All headings/labels and descriptive content inside values MUST be in English, whatever language was spoken.',
    );
    expect(CORRECTIVE_RETRY_INSTRUCTION).not.toMatch(/conversation language/i);
    expect(CORRECTIVE_RETRY_INSTRUCTION).not.toContain('English words');
    expect(CORRECTIVE_RETRY_INSTRUCTION).not.toContain('equivalents');
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
