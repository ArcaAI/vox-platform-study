/**
 * The SDK ↔ `AddContextRequest` wire contract.
 *
 * The gateway's global pipe runs `whitelist + forbidNonWhitelisted +
 * forbidUnknownValues` (`apps/api/src/main.ts`), so ANY field the DTO does not
 * declare rejects the whole request with a 400. The SDK sent `structuredData`,
 * which is not declared — every per-segment transcript POST 400'd, silently,
 * for as long as the field has existed.
 *
 * These tests replay the exact SDK bodies through a pipe configured identically
 * to `main.ts`, so the mismatch cannot come back unnoticed.
 */
import { describe, it, expect } from 'vitest';
import { ValidationPipe, BadRequestException } from '@nestjs/common';

import { AddContextRequest } from '../dto/add-context.request';

const pipe = new ValidationPipe({
  transform: true,
  whitelist: true,
  forbidNonWhitelisted: true,
  forbidUnknownValues: true,
});

const metatype = { type: 'body' as const, metatype: AddContextRequest };

describe('AddContextRequest — SDK wire contract', () => {
  it('accepts the per-segment transcript body the audio hook posts', async () => {
    const body = {
      type: 'TRANSCRIPT',
      content: 'Patient reports chest pain.',
      source: 'TRANSCRIPTION',
      metadata: {
        subType: 'TRANSCRIPT_SEGMENT',
        segments: [{ start: 0, end: 1.2, text: 'Patient reports chest pain.' }],
        speakerId: 'spk_0',
        pipelineId: 'pipeline-1',
      },
    };

    await expect(pipe.transform(body, metatype)).resolves.toMatchObject({ type: 'TRANSCRIPT' });
  });

  it('accepts the case-note / attachment bodies the context hooks post', async () => {
    await expect(pipe.transform({ type: 'CASE_NOTE', content: 'note', source: 'USER', metadata: { severity: 'high' } }, metatype)).resolves.toBeDefined();
    await expect(
      pipe.transform({ type: 'ATTACHMENT', content: 'a lab result', source: 'USER', metadata: { subType: 'LAB_RESULT' }, mediaId: 'media-1' }, metatype),
    ).resolves.toBeDefined();
  });

  it('still rejects the old `structuredData` spelling — the field is undeclared by design', async () => {
    const body = {
      type: 'TRANSCRIPT',
      content: 'Patient reports chest pain.',
      source: 'TRANSCRIPTION',
      structuredData: { speakerId: 'spk_0' },
    };

    await expect(pipe.transform(body, metatype)).rejects.toBeInstanceOf(BadRequestException);
  });
});
