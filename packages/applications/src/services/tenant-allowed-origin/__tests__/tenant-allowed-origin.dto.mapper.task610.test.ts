import { describe, it, expect } from 'vitest';
import { SYSTEM_TENANT_ID, TenantAllowedOriginEntity } from '@arcaai/domains';
import { TenantAllowedOriginDtoMapper } from '../tenant-allowed-origin.dto.mapper';

function buildEntity(overrides: Partial<Record<string, unknown>> = {}): TenantAllowedOriginEntity {
  return {
    id: 'origin-1',
    tenantId: 'tenant-1',
    origin: 'https://arcaai-staging.bcmch.org',
    label: 'ArcaAI staging',
    description: null,
    resourceStatus: 'ENABLED',
    createdAt: new Date('2026-08-04T00:00:00Z'),
    updatedAt: new Date('2026-08-04T00:00:00Z'),
    version: 1,
    ...overrides,
  } as unknown as TenantAllowedOriginEntity;
}

describe('TenantAllowedOriginDtoMapper', () => {
  it('maps every entity field to the response DTO with ISO-string timestamps', () => {
    const response = TenantAllowedOriginDtoMapper.toResponse(buildEntity());

    expect(response).toEqual({
      id: 'origin-1',
      tenantId: 'tenant-1',
      isPlatform: false,
      origin: 'https://arcaai-staging.bcmch.org',
      label: 'ArcaAI staging',
      description: undefined,
      resourceStatus: 'ENABLED',
      createdAt: '2026-08-04T00:00:00.000Z',
      updatedAt: '2026-08-04T00:00:00.000Z',
      version: 1,
    });
  });

  it('marks a SYSTEM-tenant row as platform-owned', () => {
    const response = TenantAllowedOriginDtoMapper.toResponse(buildEntity({ tenantId: SYSTEM_TENANT_ID }));

    expect(response.isPlatform).toBe(true);
  });

  it('normalizes a null description to undefined (never leaks null through the DTO)', () => {
    const response = TenantAllowedOriginDtoMapper.toResponse(buildEntity({ description: null }));

    expect(response.description).toBeUndefined();
  });

  it('passes through a populated description', () => {
    const response = TenantAllowedOriginDtoMapper.toResponse(buildEntity({ description: 'Pre-production BCMCH origin' }));

    expect(response.description).toBe('Pre-production BCMCH origin');
  });
});
