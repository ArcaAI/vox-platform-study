/**
 * TestPromptTemplateRequest DTO Validation Tests 
 *
 * Tests the class-validator decorators on the request DTO, incl. the new
 * `provider`/`model`/`dryRun`/`versionNumber`/`goldenCaseId` fields. Uses the
 * REAL class-validator `validate()` — no mocks.
 */

import { describe, it, expect } from 'vitest';
import { validate } from 'class-validator';
import { plainToInstance } from 'class-transformer';
import { TestPromptTemplateRequest } from '../dto/test-prompt-template.request';

async function validateDto(data: Record<string, unknown>): Promise<{ isValid: boolean; errors: string[] }> {
  const instance = plainToInstance(TestPromptTemplateRequest, data);
  const validationErrors = await validate(instance);
  return {
    isValid: validationErrors.length === 0,
    errors: validationErrors.flatMap((e) => Object.values(e.constraints ?? {})),
  };
}

describe('TestPromptTemplateRequest', () => {
  it('accepts an empty body (every new field is optional)', async () => {
    expect((await validateDto({})).isValid).toBe(true);
  });

  describe('provider/model', () => {
    it('accepts a string provider/model pair', async () => {
      expect((await validateDto({ provider: 'lm-studio', model: 'medgemma-27b' })).isValid).toBe(true);
    });

    it('rejects a non-string provider or model', async () => {
      expect((await validateDto({ provider: 123 })).isValid).toBe(false);
      expect((await validateDto({ model: 123 })).isValid).toBe(false);
    });
  });

  describe('dryRun', () => {
    it('accepts a boolean value', async () => {
      expect((await validateDto({ dryRun: true })).isValid).toBe(true);
      expect((await validateDto({ dryRun: false })).isValid).toBe(true);
    });

    it('rejects a non-boolean value', async () => {
      expect((await validateDto({ dryRun: 'yes' })).isValid).toBe(false);
    });
  });

  describe('versionNumber', () => {
    it('accepts a positive integer', async () => {
      expect((await validateDto({ versionNumber: 1 })).isValid).toBe(true);
      expect((await validateDto({ versionNumber: 42 })).isValid).toBe(true);
    });

    it('rejects zero, negative, and non-integer values', async () => {
      expect((await validateDto({ versionNumber: 0 })).isValid).toBe(false);
      expect((await validateDto({ versionNumber: -1 })).isValid).toBe(false);
      expect((await validateDto({ versionNumber: 1.5 })).isValid).toBe(false);
    });
  });

  describe('goldenCaseId', () => {
    it('accepts a UUID', async () => {
      expect((await validateDto({ goldenCaseId: '11111111-1111-4111-8111-111111111111' })).isValid).toBe(true);
    });

    it('rejects a non-UUID string', async () => {
      expect((await validateDto({ goldenCaseId: 'not-a-uuid' })).isValid).toBe(false);
    });
  });
});
