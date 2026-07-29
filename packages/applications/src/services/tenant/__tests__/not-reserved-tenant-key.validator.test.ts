import { describe, it, expect } from 'vitest';
import { NotReservedTenantKeyConstraint } from '../validators/not-reserved-tenant-key.validator';

describe('NotReservedTenantKeyConstraint', () => {
  const constraint = new NotReservedTenantKeyConstraint();

  it('rejects the reserved __SYSTEM__ key', () => {
    expect(constraint.validate('__SYSTEM__')).toBe(false);
  });

  it('rejects the reserved __GLOBAL__ key', () => {
    expect(constraint.validate('__GLOBAL__')).toBe(false);
  });

  it('rejects any __*__-shaped key', () => {
    expect(constraint.validate('__anything__')).toBe(false);
  });

  it('accepts an ordinary explicit key', () => {
    expect(constraint.validate('ARCAAI')).toBe(true);
  });

  it('accepts a legacy underscore-bearing key that is not dunder-wrapped', () => {
    expect(constraint.validate('NEW_TENANT')).toBe(true);
  });

  it('is a no-op for a non-string value (leaves type checking to @IsString)', () => {
    expect(constraint.validate(undefined as unknown as string)).toBe(true);
  });

  it('provides a descriptive error message', () => {
    expect(constraint.defaultMessage()).toMatch(/reserved/i);
  });
});
