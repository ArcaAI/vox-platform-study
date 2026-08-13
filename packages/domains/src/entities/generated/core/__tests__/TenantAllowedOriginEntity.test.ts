/**
 * TenantAllowedOrigin entity/factory behavior (CORS control plane).
 *
 * Locks change-tracking through `setProperty` (so `repository.update`
 * persists only `entity.changes`), factory defaults, and the structural
 * `validate()` backstop. `validate()` deliberately does NOT reimplement
 * origin grammar — that is `normalizeOrigin`'s job
 * (`packages/applications/src/services/origin-registry/origin-normalizer.ts`)
 * — it only rejects values that plainly never went
 * through it (empty, padded with whitespace, trailing slash).
 */
import { describe, it, expect } from 'vitest';
import { TenantAllowedOriginFactory } from '../../../../factories/generated/core/TenantAllowedOriginFactory';
import { TenantAllowedOriginEntity } from '../TenantAllowedOriginEntity';

describe('TenantAllowedOriginEntity', () => {
  it('factory: generated id, tenant scope, no changes, optional description defaults to null', () => {
    const entity = TenantAllowedOriginFactory.CreateTenantAllowedOrigin({
      tenantId: 't-1',
      origin: 'https://arcaai-u2204.bcmch.org',
      label: 'BCMCH production',
    });

    expect(entity.id).toBeTruthy();
    expect(entity.tenantId).toBe('t-1');
    expect(entity.origin).toBe('https://arcaai-u2204.bcmch.org');
    expect(entity.label).toBe('BCMCH production');
    expect(entity.description).toBeNull();
    expect(entity.hasChanges).toBe(false);
  });

  it('factory: carries an explicit description through', () => {
    const entity = TenantAllowedOriginFactory.CreateTenantAllowedOrigin({
      tenantId: 't-1',
      origin: 'https://mi-preproduction.bcmch.org:4433',
      label: 'BCMCH pre-production',
      description: 'Non-standard port — exact origin match required.',
    });

    expect(entity.description).toBe('Non-standard port — exact origin match required.');
  });

  it('setters route through setProperty (change-tracked)', () => {
    const entity = TenantAllowedOriginFactory.CreateTenantAllowedOrigin({
      tenantId: 't-1',
      origin: 'https://arcaai-u2204.bcmch.org',
      label: 'BCMCH production',
    });

    entity.label = 'BCMCH production (renamed)';
    entity.description = 'Updated note';

    expect(entity.hasChanges).toBe(true);
    expect(entity.changes).toMatchObject({
      label: 'BCMCH production (renamed)',
      description: 'Updated note',
    });
  });

  describe('validate()', () => {
    const build = (overrides: Partial<{ origin: string; label: string; tenantId: string }> = {}) =>
      new TenantAllowedOriginEntity({
        id: 'row-1',
        tenantId: overrides.tenantId ?? 't-1',
        origin: overrides.origin ?? 'https://arcaai-u2204.bcmch.org',
        label: overrides.label ?? 'BCMCH production',
        description: null,
        createdBy: null,
        updatedBy: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      });

    it('accepts a well-formed, already-normalized origin', () => {
      expect(() => build().validate()).not.toThrow();
    });

    it('rejects an empty origin', () => {
      expect(() => build({ origin: '' }).validate()).toThrow('Origin is required');
    });

    it('rejects an origin with leading/trailing whitespace', () => {
      expect(() => build({ origin: ' https://arcaai-u2204.bcmch.org ' }).validate()).toThrow(
        'Origin must not have leading/trailing whitespace',
      );
    });

    it('rejects an origin with a trailing slash', () => {
      expect(() => build({ origin: 'https://arcaai-u2204.bcmch.org/' }).validate()).toThrow(
        'Origin must not have a trailing slash',
      );
    });

    it('rejects an empty label', () => {
      expect(() => build({ label: '' }).validate()).toThrow('Label is required');
    });

    it('rejects a missing tenantId (BaseTenantEntity backstop)', () => {
      expect(() => build({ tenantId: '' }).validate()).toThrow('missing tenant context');
    });
  });
});
