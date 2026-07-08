/**
 * TASK-446 — AI inference request DTO validation, driven through the REAL
 * global ValidationPipe config (main.ts: transform + whitelist +
 * forbidNonWhitelisted + forbidUnknownValues). The controller unit tests call
 * methods directly and bypass the pipe, so this file is the only unit-level
 * coverage of the class-validator contract (the rest lives in the e2e, which
 * needs a running gateway).
 */

import { BadRequestException, ValidationPipe } from '@nestjs/common';
import { describe, expect, it } from 'vitest';
import { AnalyzeGuardrailRequest } from '../dto/analyze-guardrail.request';
import { ExtractEntitiesRequest } from '../dto/extract-entities.request';

const PIPE_CFG = { transform: true, whitelist: true, forbidNonWhitelisted: true, forbidUnknownValues: true } as const;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function runPipe(metatype: any, value: unknown): Promise<unknown> {
  const pipe = new ValidationPipe(PIPE_CFG);
  return pipe.transform(value, { type: 'body', metatype } as never);
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function expectRejected(metatype: any, value: unknown): Promise<void> {
  await expect(runPipe(metatype, value)).rejects.toBeInstanceOf(BadRequestException);
}

describe('AnalyzeGuardrailRequest validation', () => {
  it('accepts text alone (guardrailType optional)', async () => {
    await expect(runPipe(AnalyzeGuardrailRequest, { text: 'hello' })).resolves.toMatchObject({ text: 'hello' });
  });

  it('accepts a whitelisted guardrailType', async () => {
    await expect(runPipe(AnalyzeGuardrailRequest, { text: 'x', guardrailType: 'pii_detection' })).resolves.toMatchObject({
      guardrailType: 'pii_detection',
    });
  });

  it('rejects missing text', async () => {
    await expectRejected(AnalyzeGuardrailRequest, { guardrailType: 'comprehensive' });
  });

  it('rejects empty text (IsNotEmpty)', async () => {
    await expectRejected(AnalyzeGuardrailRequest, { text: '' });
  });

  it('rejects an unknown guardrailType (IsIn whitelist)', async () => {
    await expectRejected(AnalyzeGuardrailRequest, { text: 'x', guardrailType: 'not_a_type' });
  });

  it('rejects text over the 20k length cap', async () => {
    await expectRejected(AnalyzeGuardrailRequest, { text: 'a'.repeat(20_001) });
  });

  it('rejects an unknown/smuggled field (forbidNonWhitelisted)', async () => {
    await expectRejected(AnalyzeGuardrailRequest, { text: 'x', guardrail_type: 'comprehensive' });
  });
});

describe('ExtractEntitiesRequest validation', () => {
  it('accepts text alone', async () => {
    await expect(runPipe(ExtractEntitiesRequest, { text: 'aspirin' })).resolves.toMatchObject({ text: 'aspirin' });
  });

  it('accepts optional aggregationStrategy + language', async () => {
    await expect(runPipe(ExtractEntitiesRequest, { text: 'x', aggregationStrategy: 'max', language: 'vi' })).resolves.toMatchObject({
      aggregationStrategy: 'max',
      language: 'vi',
    });
  });

  it('rejects missing text', async () => {
    await expectRejected(ExtractEntitiesRequest, { aggregationStrategy: 'simple' });
  });

  it('rejects empty text', async () => {
    await expectRejected(ExtractEntitiesRequest, { text: '' });
  });

  it('rejects an unknown/smuggled field (forbidNonWhitelisted)', async () => {
    await expectRejected(ExtractEntitiesRequest, { text: 'x', aggregation_strategy: 'simple' });
  });
});
