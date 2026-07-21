/**
 * UpdateTenantConfigRequest — `expectedVersion` validation.
 *
 * Carries the optimistic-concurrency token from the prior GET. Required so
 * the strict global ValidationPipe
 * (forbidNonWhitelisted) does not reject a smuggled `expectedVersion`, but
 * once required it must be a positive integer.
 */
import { describe, it, expect } from 'vitest';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { UpdateTenantConfigRequest } from '../updateTenantConfigRequest';

describe('UpdateTenantConfigRequest — expectedVersion (TASK-302 Stream D Phase C)', () => {
  it('rejects payloads missing expectedVersion', async () => {
    const dto = plainToInstance(UpdateTenantConfigRequest, {
      id: '00000000-0000-7000-8000-000000000001',
      value: 'v1',
    });
    const errors = await validate(dto);
    expect(errors.some((e) => e.property === 'expectedVersion')).toBe(true);
  });

  it('accepts a positive integer expectedVersion', async () => {
    const dto = plainToInstance(UpdateTenantConfigRequest, {
      id: '00000000-0000-7000-8000-000000000001',
      value: 'v1',
      expectedVersion: 3,
    });
    const errors = await validate(dto);
    expect(errors).toHaveLength(0);
  });

  it('rejects non-integer expectedVersion', async () => {
    const dto = plainToInstance(UpdateTenantConfigRequest, {
      id: '00000000-0000-7000-8000-000000000001',
      value: 'v1',
      expectedVersion: 3.5,
    });
    const errors = await validate(dto);
    expect(errors.some((e) => e.property === 'expectedVersion')).toBe(true);
  });

  it('rejects expectedVersion below 1', async () => {
    const dto = plainToInstance(UpdateTenantConfigRequest, {
      id: '00000000-0000-7000-8000-000000000001',
      value: 'v1',
      expectedVersion: 0,
    });
    const errors = await validate(dto);
    expect(errors.some((e) => e.property === 'expectedVersion')).toBe(true);
  });

  it('rejects negative expectedVersion', async () => {
    const dto = plainToInstance(UpdateTenantConfigRequest, {
      id: '00000000-0000-7000-8000-000000000001',
      value: 'v1',
      expectedVersion: -1,
    });
    const errors = await validate(dto);
    expect(errors.some((e) => e.property === 'expectedVersion')).toBe(true);
  });
});
