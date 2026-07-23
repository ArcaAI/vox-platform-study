/**
 * DepartmentAgentEntity + DepartmentAgentFactory unit tests (TASK-546).
 */
import { describe, it, expect } from 'vitest';
import { DepartmentAgentFactory } from '../../../../factories/generated/core/DepartmentAgentFactory';
import { DepartmentAgentDnaPolicy } from '../../../../enums/generated/DepartmentAgentDnaPolicy';

const baseProps = {
  tenantId: 't-1',
  departmentId: 'dept-1',
  name: 'Cardiology SOAP',
  slug: 'cardiology-soap',
  promptTemplateId: 'tpl-1',
};

describe('DepartmentAgentFactory', () => {
  it('generates a UUIDv7 id and applies defaults', () => {
    const agent = DepartmentAgentFactory.CreateDepartmentAgent(baseProps);
    // UUIDv7 — version nibble is 7.
    expect(agent.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(agent.pinnedVersionNumber).toBeNull();
    expect(agent.dnaStylePolicy).toBe(DepartmentAgentDnaPolicy.INHERIT);
    expect(agent.isDefault).toBe(false);
    expect(agent.templateLocked).toBe(false);
    expect(agent.tags).toEqual([]);
  });

  it('GenerateSlug normalizes a name', () => {
    expect(DepartmentAgentFactory.GenerateSlug('Cardiology SOAP!')).toBe('cardiology-soap');
  });
});

describe('DepartmentAgentEntity metaData (TASK-548 clone lineage)', () => {
  it('round-trips metaData through the factory (clone lineage carrier)', () => {
    const agent = DepartmentAgentFactory.CreateDepartmentAgent({
      ...baseProps,
      metaData: { sourceTemplateVersionNumber: 3 },
    });
    expect(agent.metaData).toEqual({ sourceTemplateVersionNumber: 3 });
  });

  it('defaults metaData to null and tracks changes through setProperty', () => {
    const agent = DepartmentAgentFactory.CreateDepartmentAgent(baseProps);
    expect(agent.metaData ?? null).toBeNull();
    agent.metaData = { sourceTemplateVersionNumber: 2 };
    expect(agent.hasChanges).toBe(true);
    expect(agent.changes).toHaveProperty('metaData');
    expect(agent.metaData).toEqual({ sourceTemplateVersionNumber: 2 });
  });
});

describe('DepartmentAgentEntity.validate', () => {
  it('passes for a well-formed agent', () => {
    const agent = DepartmentAgentFactory.CreateDepartmentAgent(baseProps);
    expect(() => agent.validate()).not.toThrow();
  });

  it('rejects a missing tenantId (BaseTenantEntity backstop)', () => {
    const agent = DepartmentAgentFactory.CreateDepartmentAgent({ ...baseProps, tenantId: '' });
    expect(() => agent.validate()).toThrow(/tenant/i);
  });

  it('rejects a missing promptTemplateId', () => {
    const agent = DepartmentAgentFactory.CreateDepartmentAgent({ ...baseProps, promptTemplateId: '' });
    expect(() => agent.validate()).toThrow(/promptTemplateId/i);
  });

  it('rejects a non-slug-shaped slug', () => {
    const agent = DepartmentAgentFactory.CreateDepartmentAgent({ ...baseProps, slug: 'Not A Slug' });
    expect(() => agent.validate()).toThrow(/slug/i);
  });

  it('rejects a non-positive pinnedVersionNumber', () => {
    const agent = DepartmentAgentFactory.CreateDepartmentAgent({ ...baseProps, pinnedVersionNumber: 0 });
    expect(() => agent.validate()).toThrow(/pinnedVersionNumber/i);
  });

  it('change tracking routes through setProperty', () => {
    const agent = DepartmentAgentFactory.CreateDepartmentAgent(baseProps);
    agent.pinnedVersionNumber = 2;
    expect(agent.hasChanges).toBe(true);
    expect(agent.changes).toMatchObject({ pinnedVersionNumber: 2 });
  });
});
