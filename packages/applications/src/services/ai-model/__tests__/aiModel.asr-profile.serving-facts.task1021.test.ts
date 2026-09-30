/**
 * TASK-1010 phase B (OD-6 / OD-8) — the admin WRITE boundary for the two serving facts on
 * `AiModel._metadata.asr`, and the vLLM serving target (`asr-vllm`, renamed `vllm` by TASK-1021).
 *
 * `AsrProfileRequest` is strict (400 naming the field), unlike the lenient read-side parser:
 * an admin must be told their value was refused rather than have it silently dropped.
 */
import { describe, expect, it } from 'vitest';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { AI_MODEL_SERVED_BY } from '../constants';
import { AsrProfileRequest } from '../dto';

async function errorsFor(body: Record<string, unknown>) {
  return validate(plainToInstance(AsrProfileRequest, body), { whitelist: true, forbidNonWhitelisted: true });
}

describe('AsrProfileRequest — serving facts (TASK-1010)', () => {
  it.each(['none', 'fp8', 'awq', 'gptq', 'int8'])('accepts quantization %s', async (quantization) => {
    expect(await errorsFor({ quantization })).toHaveLength(0);
  });

  it('accepts a whole maxModelLen of at least 1, beside the decode profile', async () => {
    expect(await errorsFor({ maxModelLen: 448 })).toHaveLength(0);
    expect(await errorsFor({ maxModelLen: 1 })).toHaveLength(0);
    expect(await errorsFor({ maxDecodeWindowSec: 7, quantization: 'none', maxModelLen: 448 })).toHaveLength(0);
  });

  it.each([['FP8'], ['bf16'], [''], [8]])('rejects an unknown quantization %j, naming the field', async (quantization) => {
    const errors = await errorsFor({ quantization });
    expect(errors.map((error) => error.property)).toEqual(['quantization']);
  });

  it.each([[0], [-1], [2.5], ['448']])('rejects an invalid maxModelLen %j, naming the field', async (maxModelLen) => {
    const errors = await errorsFor({ maxModelLen });
    expect(errors.map((error) => error.property)).toEqual(['maxModelLen']);
  });
});

describe('AI_MODEL_SERVED_BY — the vllm serving target (TASK-1010 OD-9, renamed by TASK-1021 D-13)', () => {
  it('lists vllm as a workload that executes a registry row', () => {
    expect(AI_MODEL_SERVED_BY).toContain('vllm');
  });

  it('no longer lists the retired asr-vllm name', () => {
    expect(AI_MODEL_SERVED_BY).not.toContain('asr-vllm');
  });
});
