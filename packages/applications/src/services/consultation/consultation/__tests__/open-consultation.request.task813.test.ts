/**
 * point 2 — the SDK ↔ `OpenConsultationRequest` wire contract for
 * the workflow selector.
 *
 * The gateway's global pipe runs `whitelist + forbidNonWhitelisted +
 * forbidUnknownValues` (`apps/api/src/main.ts`), so a selector the DTO does not
 * declare does not "fall through to the cascade" — it REJECTS THE WHOLE OPEN
 * with a 400, exactly as the @deprecated `department` field still does. These
 * tests replay bodies through a pipe configured identically to `main.ts`, so
 * the mismatch cannot come back unnoticed.
 */
import { describe, it, expect } from 'vitest';
import { ValidationPipe, BadRequestException } from '@nestjs/common';

import { OpenConsultationRequest } from '../dto/open-consultation.request';

const pipe = new ValidationPipe({
  transform: true,
  whitelist: true,
  forbidNonWhitelisted: true,
  forbidUnknownValues: true,
});

const metatype = { type: 'body' as const, metatype: OpenConsultationRequest };

describe('OpenConsultationRequest —  workflow selector wire contract', () => {
  it('accepts the selector the SDK sends as `OpenSessionInput.workflowDefinitionSlug`', async () => {
    await expect(pipe.transform({ patientId: 'p-1', workflowDefinitionSlug: 'arcaai_consultation_v1' }, metatype)).resolves.toMatchObject({
      workflowDefinitionSlug: 'arcaai_consultation_v1',
    });
  });

  it('still opens with no selector at all — the assignment cascade stays the default', async () => {
    await expect(pipe.transform({ patientId: 'p-1' }, metatype)).resolves.toMatchObject({ patientId: 'p-1' });
  });

  it('rejects a non-string selector', async () => {
    await expect(pipe.transform({ patientId: 'p-1', workflowDefinitionSlug: { slug: 'x' } }, metatype)).rejects.toBeInstanceOf(BadRequestException);
  });

  it('accepts the hyphenated slugs every seeded workflow actually carries ', async () => {
    // AMENDED: reused the node-id grammar, which admits no hyphen, while
    // every seeded definition is hyphenated — so no real workflow could ever be selected.
    for (const slug of ['arcaai-consultation-medical-ner', 'arcaai-consultation-soap', 'platform-default-summarization']) {
      await expect(pipe.transform({ patientId: 'p-1', workflowDefinitionSlug: slug }, metatype)).resolves.toMatchObject({ workflowDefinitionSlug: slug });
    }
  });

  it('rejects a selector that is not a well-formed slug — the grammar is the same one `CreateWorkflowDefinitionRequest` enforces', async () => {
    // WORKFLOW_DEFINITION_SLUG_PATTERN: lowercase alphanumerics, `-` and `_`, 2–80 chars.
    // Anything else could never name a real row, so it is refused at the edge rather than
    // carried down to a repository lookup.
    for (const bad of ['Caller_Picked', 'a', '../etc/passwd', 'a'.repeat(81), '', '-leading', 'trailing-']) {
      await expect(pipe.transform({ patientId: 'p-1', workflowDefinitionSlug: bad }, metatype)).rejects.toBeInstanceOf(BadRequestException);
    }
  });

  it('still rejects the @deprecated `department` field — undeclared by design, and this ticket does not change that', async () => {
    await expect(pipe.transform({ patientId: 'p-1', department: 'cardiology' }, metatype)).rejects.toBeInstanceOf(BadRequestException);
  });
});
