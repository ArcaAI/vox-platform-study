/**
 * TASK-1057 — the platform write DTO: `mode: null` is the RESET signal and must validate, while an
 * absent or unknown mode is refused. `@IsDefined` used to reject null, so reset could never succeed.
 */
import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { describe, expect, it } from 'vitest';
import { ActionConfirmationWriteRequest } from '../dto/action-confirmations.dto';

const errorsFor = async (body: Record<string, unknown>) =>
  (await validate(plainToInstance(ActionConfirmationWriteRequest, body), { whitelist: true, forbidNonWhitelisted: true })).map((e) => e.property);

describe('ActionConfirmationWriteRequest', () => {
  it('accepts null as the reset signal', async () => {
    expect(await errorsFor({ actionId: 'promptTemplate.update', mode: null })).toEqual([]);
  });

  it('accepts a mode', async () => {
    expect(await errorsFor({ actionId: 'promptTemplate.update', mode: 'required', expectedVersion: 3 })).toEqual([]);
  });

  it('refuses an absent or unknown mode', async () => {
    expect(await errorsFor({ actionId: 'promptTemplate.update' })).toContain('mode');
    expect(await errorsFor({ actionId: 'promptTemplate.update', mode: 'sometimes' })).toContain('mode');
  });
});
