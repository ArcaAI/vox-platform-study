import { describe, it, expect } from 'vitest';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { ProvisionTenantRequest } from '../dto/provisionTenant.request';

describe('ProvisionTenantRequest validation', () => {
  it('is valid for mode=existing with a userId', async () => {
    const dto = plainToInstance(ProvisionTenantRequest, {
      tenantName: 'Acme Health',
      admin: { mode: 'existing', userId: 'user-1' },
    });

    expect(await validate(dto)).toHaveLength(0);
  });

  it('is valid for mode=new-local with email + password', async () => {
    const dto = plainToInstance(ProvisionTenantRequest, {
      tenantName: 'Acme Health',
      admin: { mode: 'new-local', email: 'admin@acme.test', password: 'S3cret!Pass' },
    });

    expect(await validate(dto)).toHaveLength(0);
  });

  it('rejects mode=existing without a userId', async () => {
    const dto = plainToInstance(ProvisionTenantRequest, {
      tenantName: 'Acme Health',
      admin: { mode: 'existing' },
    });

    const errors = await validate(dto);
    expect(errors.length).toBeGreaterThan(0);
  });

  it('rejects mode=new-local without email/password', async () => {
    const dto = plainToInstance(ProvisionTenantRequest, {
      tenantName: 'Acme Health',
      admin: { mode: 'new-local' },
    });

    const errors = await validate(dto);
    expect(errors.length).toBeGreaterThan(0);
  });

  it('rejects a reserved tenantKey', async () => {
    const dto = plainToInstance(ProvisionTenantRequest, {
      tenantName: 'Acme Health',
      tenantKey: '__GLOBAL__',
      admin: { mode: 'existing', userId: 'user-1' },
    });

    const errors = await validate(dto);
    expect(errors.some((e) => e.property === 'tenantKey')).toBe(true);
  });

  it('rejects a missing admin block', async () => {
    const dto = plainToInstance(ProvisionTenantRequest, { tenantName: 'Acme Health' });

    const errors = await validate(dto);
    expect(errors.some((e) => e.property === 'admin')).toBe(true);
  });
});
