/**
 * UpdatePromptTemplateRequest DTO Validation Tests
 *
 * Tests the class-validator decorators on the request DTO.
 *
 * Testing Strategy:
 * - Use the REAL class-validator validate() function
 * - NO mocks — these tests verify actual validation behavior
 *
 * The OCC token `expectedVersion` is OPTIONAL on this DTO,
 * mirroring `UpdateDnaReportRequest`. The PATCH route is `@RequiresIfMatch()`
 * and folds the `If-Match` header value over the body at the controller, so the
 * canonical request carries the version in the header and omits it from the
 * body. A required body field would 400 that header-first request before the
 * controller could fold the header in — the asymmetry this aligns away.
 */

import { describe, it, expect } from 'vitest';
import { validate } from 'class-validator';
import { plainToInstance } from 'class-transformer';
import { UpdatePromptTemplateRequest } from '../dto/update-prompt-template.request';
import { CreatePromptTemplateRequest } from '../dto/create-prompt-template.request';
import { UpdateDnaReportRequest } from '../../dna-writing-style/dto/update-dna-report.request';

async function validateDto<T extends object>(cls: new () => T, data: Record<string, any>): Promise<{ isValid: boolean; errors: string[] }> {
  const instance = plainToInstance(cls, data);
  const validationErrors = await validate(instance);
  return {
    isValid: validationErrors.length === 0,
    errors: validationErrors.flatMap((e) => Object.values(e.constraints ?? {})),
  };
}

describe('UpdatePromptTemplateRequest', () => {
  describe('expectedVersion (OCC contract)', () => {
    it('accepts a header-first body that omits expectedVersion', async () => {
      const result = await validateDto(UpdatePromptTemplateRequest, {
        content: 'Updated content',
        changeReason: 'Fix typo',
      });
      expect(result.isValid).toBe(true);
    });

    it('accepts a valid body-supplied expectedVersion (service-to-service fallback)', async () => {
      const result = await validateDto(UpdatePromptTemplateRequest, { expectedVersion: 7 });
      expect(result.isValid).toBe(true);
    });

    it('rejects a present-but-invalid expectedVersion (must be an int >= 1)', async () => {
      const zero = await validateDto(UpdatePromptTemplateRequest, { expectedVersion: 0 });
      expect(zero.isValid).toBe(false);

      const notInt = await validateDto(UpdatePromptTemplateRequest, { expectedVersion: 1.5 });
      expect(notInt.isValid).toBe(false);
    });
  });

  // Lock the symmetric contract: the prompt + DNA update DTOs treat
  // `expectedVersion` identically (optional, header-first; invalid values
  // still rejected), so the two OCC routes share one contract.
  describe('parity with UpdateDnaReportRequest', () => {
    it('both DTOs accept an omitted expectedVersion', async () => {
      const prompt = await validateDto(UpdatePromptTemplateRequest, { content: 'x' });
      const dna = await validateDto(UpdateDnaReportRequest, { styleText: 'x' });
      expect(prompt.isValid).toBe(true);
      expect(dna.isValid).toBe(true);
    });

    it('both DTOs reject expectedVersion = 0', async () => {
      const prompt = await validateDto(UpdatePromptTemplateRequest, { expectedVersion: 0 });
      const dna = await validateDto(UpdateDnaReportRequest, { expectedVersion: 0 });
      expect(prompt.isValid).toBe(false);
      expect(dna.isValid).toBe(false);
    });
  });

  // The prompt body is folded verbatim into the clinical LLM prompt, so an
  // unbounded field is a cost + prompt-injection surface (F-03). Both the
  // create and update DTOs cap content at 50,000 chars.
  describe('content length cap (F-03)', () => {
    it('accepts content at the 50,000-char cap', async () => {
      const atCap = await validateDto(UpdatePromptTemplateRequest, { content: 'x'.repeat(50000) });
      expect(atCap.isValid).toBe(true);
    });

    it('rejects content over the 50,000-char cap', async () => {
      const overCap = await validateDto(UpdatePromptTemplateRequest, { content: 'x'.repeat(50001) });
      expect(overCap.isValid).toBe(false);
      expect(overCap.errors.join(' ')).toMatch(/content/i);
    });

    it('CreatePromptTemplateRequest enforces the same content cap', async () => {
      const over = await validateDto(CreatePromptTemplateRequest, {
        name: 'n',
        content: 'x'.repeat(50001),
        category: 'SUMMARY',
      });
      expect(over.isValid).toBe(false);

      const ok = await validateDto(CreatePromptTemplateRequest, {
        name: 'n',
        content: 'x'.repeat(50000),
        category: 'SUMMARY',
      });
      expect(ok.isValid).toBe(true);
    });
  });

  // TASK-890 §3.6 (OD-K) — `variables` is now an ARRAY of typed declarations.
  // The pre-ticket legacy shape (`{ [name]: { type, required } }`) has NO
  // read-side normaliser and must be REJECTED by the global pipe, not
  // silently accepted the way it was before this ticket.
  describe('typed variable declarations (TASK-890 §3.6, OD-K)', () => {
    it('rejects the retired legacy MAP shape ({ name: { type, required } })', async () => {
      const legacyMap = await validateDto(UpdatePromptTemplateRequest, {
        variables: { topic: { type: 'string', required: true } },
      });
      expect(legacyMap.isValid).toBe(false);

      const legacyMapOnCreate = await validateDto(CreatePromptTemplateRequest, {
        name: 'n',
        content: 'x',
        category: 'SUMMARY',
        variables: { topic: { type: 'string', required: true } },
      });
      expect(legacyMapOnCreate.isValid).toBe(false);
    });

    it('accepts a well-formed array of typed declarations', async () => {
      const result = await validateDto(UpdatePromptTemplateRequest, {
        variables: [
          { name: 'topic', type: 'string', required: true },
          { name: 'age', type: 'number', required: false, default: '0', description: 'Patient age', source: { kind: 'context', path: 'context.patientAge' } },
        ],
      });
      expect(result.isValid).toBe(true);
    });

    it('rejects a declaration with an invalid name (not a bare identifier)', async () => {
      const result = await validateDto(UpdatePromptTemplateRequest, {
        variables: [{ name: '1-bad-name', type: 'string', required: true }],
      });
      expect(result.isValid).toBe(false);
    });

    it('rejects a declaration with an unknown type', async () => {
      const result = await validateDto(UpdatePromptTemplateRequest, {
        variables: [{ name: 'topic', type: 'currency', required: true }],
      });
      expect(result.isValid).toBe(false);
    });

    it('accepts an empty declarations array', async () => {
      const result = await validateDto(UpdatePromptTemplateRequest, { variables: [] });
      expect(result.isValid).toBe(true);
    });
  });
});
