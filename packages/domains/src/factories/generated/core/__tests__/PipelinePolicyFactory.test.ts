/**
 * PipelinePolicyFactory Unit Tests
 *
 * A freshly-built row defaults to the TENANT tier with ALL toggles `null`
 * (overrides nothing — the cascade keeps inheriting). Overrides are built by
 * passing the scope + scopeId and only the toggles to pin.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { PipelinePolicyFactory } from '../PipelinePolicyFactory';
import { PipelinePolicyScope } from '../../../../enums';

const TEST_TENANT_ID = '00000000-0000-0000-0000-000000000001';

vi.mock('../../../../utils', () => ({
  generateId: vi.fn(() => 'generated-uuid-7'),
}));

describe('PipelinePolicyFactory', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('creates a row with a generated UUIDv7 id', () => {
    const entity = PipelinePolicyFactory.CreatePipelinePolicy({ tenantId: TEST_TENANT_ID });
    expect(entity.id).toBe('generated-uuid-7');
  });

  it('defaults to the TENANT tier with all toggles null (overrides nothing)', () => {
    const entity = PipelinePolicyFactory.CreatePipelinePolicy({ tenantId: TEST_TENANT_ID });
    expect(entity.scope).toBe(PipelinePolicyScope.TENANT);
    expect(entity.scopeId).toBeNull();
    expect(entity.autoSummaryEnabled).toBeNull();
    expect(entity.autoNerEnabled).toBeNull();
    expect(entity.harnessEnabled).toBeNull();
    expect(entity.dnaStyleEnabled).toBeNull();
  });

  it('builds a DOCTOR override pinning only the toggles provided', () => {
    const entity = PipelinePolicyFactory.CreatePipelinePolicy({
      tenantId: TEST_TENANT_ID,
      scope: PipelinePolicyScope.DOCTOR,
      scopeId: 'doctor-9',
      autoSummaryEnabled: false,
      dnaStyleEnabled: true,
    });
    expect(entity.scope).toBe(PipelinePolicyScope.DOCTOR);
    expect(entity.scopeId).toBe('doctor-9');
    expect(entity.autoSummaryEnabled).toBe(false);
    expect(entity.dnaStyleEnabled).toBe(true);
    // unspecified toggles stay null (inherit)
    expect(entity.autoNerEnabled).toBeNull();
    expect(entity.harnessEnabled).toBeNull();
  });
});
