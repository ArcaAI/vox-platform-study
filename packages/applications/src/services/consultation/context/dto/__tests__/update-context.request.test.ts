/**
 * UpdateContextRequest DTO Validation Tests (F-03)
 *
 * The update path feeds the SAME harness prompt as the create path
 * (`harness-internal.service.ts` assemble, `[case note]` / `[work note]`),
 * so `content` carries the same `@MaxLength` cap. Without it the create-path
 * bound is bypassable: POST a short note, then PATCH it to any size.
 *
 * Testing Strategy:
 * - Use the REAL class-validator validate() function
 * - NO mocks — these tests verify actual validation behavior
 */

import { describe, it, expect } from 'vitest';
import { validate } from 'class-validator';
import { plainToInstance } from 'class-transformer';
import { CONTEXT_CONTENT_MAX_LENGTH } from '../add-context.request';
import { UpdateContextRequest } from '../update-context.request';

async function validateDto(data: Record<string, unknown>): Promise<{ isValid: boolean; errors: string[] }> {
  const instance = plainToInstance(UpdateContextRequest, data);
  const validationErrors = await validate(instance);
  return {
    isValid: validationErrors.length === 0,
    errors: validationErrors.flatMap((e) => Object.values(e.constraints ?? {})),
  };
}

describe('UpdateContextRequest', () => {
  it('accepts content at exactly the max length', async () => {
    const result = await validateDto({ expectedVersion: 1, content: 'a'.repeat(CONTEXT_CONTENT_MAX_LENGTH) });
    expect(result.isValid).toBe(true);
  });

  it('rejects content one character over the max length', async () => {
    const result = await validateDto({ expectedVersion: 1, content: 'a'.repeat(CONTEXT_CONTENT_MAX_LENGTH + 1) });
    expect(result.isValid).toBe(false);
    expect(result.errors.some((e) => e.toLowerCase().includes('shorter'))).toBe(true);
  });

  it('accepts a normal short content string', async () => {
    const result = await validateDto({ expectedVersion: 1, content: 'Patient reports chest pain.' });
    expect(result.isValid).toBe(true);
  });

  it('accepts an absent content (all update fields are optional)', async () => {
    const result = await validateDto({ expectedVersion: 1, changeReason: 'typo fix' });
    expect(result.isValid).toBe(true);
  });
});
