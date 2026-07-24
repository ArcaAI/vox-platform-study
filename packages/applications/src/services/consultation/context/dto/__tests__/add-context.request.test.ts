/**
 * AddContextRequest DTO Validation Tests (F-03)
 *
 * `content` is folded verbatim into the harness prompt as
 * `[case note]` / `[work note]` (`harness-internal.service.ts` assemble) with
 * no transformation beyond a label prefix — a `@MaxLength` cap bounds the
 * prompt-injection / unbounded-payload surface (SOTA §5.1/§5.2).
 *
 * Testing Strategy:
 * - Use the REAL class-validator validate() function
 * - NO mocks — these tests verify actual validation behavior
 */

import { describe, it, expect } from 'vitest';
import { validate } from 'class-validator';
import { plainToInstance } from 'class-transformer';
import { ContextItemType } from '@arcaai/domains';
import { AddContextRequest, CONTEXT_CONTENT_MAX_LENGTH } from '../add-context.request';

async function validateDto(data: Record<string, unknown>): Promise<{ isValid: boolean; errors: string[] }> {
  const instance = plainToInstance(AddContextRequest, data);
  const validationErrors = await validate(instance);
  return {
    isValid: validationErrors.length === 0,
    errors: validationErrors.flatMap((e) => Object.values(e.constraints ?? {})),
  };
}

describe('AddContextRequest', () => {
  it('accepts content at exactly the max length', async () => {
    const result = await validateDto({
      type: ContextItemType.WORKNOTE,
      content: 'a'.repeat(CONTEXT_CONTENT_MAX_LENGTH),
    });
    expect(result.isValid).toBe(true);
  });

  it('rejects content one character over the max length', async () => {
    const result = await validateDto({
      type: ContextItemType.WORKNOTE,
      content: 'a'.repeat(CONTEXT_CONTENT_MAX_LENGTH + 1),
    });
    expect(result.isValid).toBe(false);
    expect(result.errors.some((e) => e.toLowerCase().includes('shorter'))).toBe(true);
  });

  it('accepts a normal short content string', async () => {
    const result = await validateDto({
      type: ContextItemType.CASE_NOTE,
      content: 'Patient reports chest pain.',
    });
    expect(result.isValid).toBe(true);
  });

  it('accepts an absent content (optional for media types)', async () => {
    const result = await validateDto({
      type: ContextItemType.ATTACHMENT,
      mediaId: 'media-1',
    });
    expect(result.isValid).toBe(true);
  });
});
