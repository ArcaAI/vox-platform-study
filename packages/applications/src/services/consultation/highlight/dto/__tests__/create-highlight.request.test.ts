/**
 * CreateHighlightRequest DTO Validation Tests (F-03)
 *
 * `exact` / `note` fold verbatim into the harness prompt as `[highlight]`
 * lines (`harness-internal.service.ts` assemble) — a `@MaxLength` cap on each
 * bounds the prompt-injection / unbounded-payload surface (SOTA
 *
 * Testing Strategy:
 * - Use the REAL class-validator validate() function
 * - NO mocks — these tests verify actual validation behavior
 */

import { describe, it, expect } from 'vitest';
import { validate } from 'class-validator';
import { plainToInstance } from 'class-transformer';
import { HighlightTargetKind } from '@arcaai/domains';
import { CreateHighlightRequest, HIGHLIGHT_TEXT_MAX_LENGTH } from '../create-highlight.request';

const baseValid = {
  targetKind: HighlightTargetKind.TRANSCRIPT,
  exact: 'chest pain',
  startOffset: 0,
  endOffset: 10,
};

async function validateDto(data: Record<string, unknown>): Promise<{ isValid: boolean; errors: string[] }> {
  const instance = plainToInstance(CreateHighlightRequest, data);
  const validationErrors = await validate(instance);
  return {
    isValid: validationErrors.length === 0,
    errors: validationErrors.flatMap((e) => Object.values(e.constraints ?? {})),
  };
}

describe('CreateHighlightRequest', () => {
  it('accepts a normal short highlight', async () => {
    const result = await validateDto(baseValid);
    expect(result.isValid).toBe(true);
  });

  describe('exact', () => {
    it('accepts exact at exactly the max length', async () => {
      const result = await validateDto({ ...baseValid, exact: 'a'.repeat(HIGHLIGHT_TEXT_MAX_LENGTH) });
      expect(result.isValid).toBe(true);
    });

    it('rejects exact one character over the max length', async () => {
      const result = await validateDto({ ...baseValid, exact: 'a'.repeat(HIGHLIGHT_TEXT_MAX_LENGTH + 1) });
      expect(result.isValid).toBe(false);
      expect(result.errors.some((e) => e.toLowerCase().includes('shorter'))).toBe(true);
    });
  });

  describe('note', () => {
    it('accepts note at exactly the max length', async () => {
      const result = await validateDto({ ...baseValid, note: 'b'.repeat(HIGHLIGHT_TEXT_MAX_LENGTH) });
      expect(result.isValid).toBe(true);
    });

    it('rejects note one character over the max length', async () => {
      const result = await validateDto({ ...baseValid, note: 'b'.repeat(HIGHLIGHT_TEXT_MAX_LENGTH + 1) });
      expect(result.isValid).toBe(false);
      expect(result.errors.some((e) => e.toLowerCase().includes('shorter'))).toBe(true);
    });

    it('accepts an absent note (optional)', async () => {
      const result = await validateDto(baseValid);
      expect(result.isValid).toBe(true);
    });
  });
});
