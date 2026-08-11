/**
 * DepartmentAgentVersionEntity + DepartmentAgentVersionFactory unit tests
 * (TASK-659) — the immutable loop-config snapshot table.
 */
import { describe, it, expect } from 'vitest';
import { DepartmentAgentVersionFactory } from '../../../../factories/generated/core/DepartmentAgentVersionFactory';

const baseProps = {
  tenantId: 't-1',
  agentId: 'agent-1',
  versionNumber: 1,
  configSnapshot: { role: 'PRIMARY', subscribedKinds: null, writeScope: null, goal: null, guardrailProfile: null, alwaysActions: null, neverActions: null },
  checksum: 'a'.repeat(64),
};

describe('DepartmentAgentVersionFactory', () => {
  it('generates a UUIDv7 id and carries the supplied snapshot verbatim', () => {
    const version = DepartmentAgentVersionFactory.CreateDepartmentAgentVersion(baseProps);
    expect(version.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(version.agentId).toBe('agent-1');
    expect(version.versionNumber).toBe(1);
    expect(version.configSnapshot).toEqual(baseProps.configSnapshot);
    expect(version.checksum).toBe(baseProps.checksum);
    expect(version.changeReason).toBeNull();
  });

  it('defaults updatedBy to null (immutable row — never updated after insert)', () => {
    const version = DepartmentAgentVersionFactory.CreateDepartmentAgentVersion(baseProps);
    expect(version.updatedBy).toBeNull();
  });
});

describe('DepartmentAgentVersionEntity.validate', () => {
  it('passes for a well-formed version', () => {
    const version = DepartmentAgentVersionFactory.CreateDepartmentAgentVersion(baseProps);
    expect(() => version.validate()).not.toThrow();
  });

  it('rejects a missing agentId', () => {
    const version = DepartmentAgentVersionFactory.CreateDepartmentAgentVersion({ ...baseProps, agentId: '' });
    expect(() => version.validate()).toThrow(/Agent ID/i);
  });

  it('rejects a non-positive versionNumber', () => {
    const version = DepartmentAgentVersionFactory.CreateDepartmentAgentVersion({ ...baseProps, versionNumber: 0 });
    expect(() => version.validate()).toThrow(/versionNumber/i);
  });

  it('rejects a non-object configSnapshot', () => {
    const version = DepartmentAgentVersionFactory.CreateDepartmentAgentVersion({
      ...baseProps,
      configSnapshot: 'not-an-object' as never,
    });
    expect(() => version.validate()).toThrow(/configSnapshot/i);
  });

  it('rejects a missing checksum', () => {
    const version = DepartmentAgentVersionFactory.CreateDepartmentAgentVersion({ ...baseProps, checksum: '' });
    expect(() => version.validate()).toThrow(/checksum/i);
  });
});
