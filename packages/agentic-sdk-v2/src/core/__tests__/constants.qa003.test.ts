/**
 * QA-003 Constants Tests: AUDIT_LOG_ENDPOINTS + ROLE_ENDPOINTS hierarchy
 *
 * @vitest-environment jsdom
 */

import { describe, it, expect } from 'vitest';
import { ROLE_ENDPOINTS, POLICY_ENDPOINTS, AUDIT_LOG_ENDPOINTS } from '../constants';

describe('QA-003: RBAC Constants Enhancements', () => {
  describe('AUDIT_LOG_ENDPOINTS', () => {
    it('should have LIST endpoint', () => {
      expect(AUDIT_LOG_ENDPOINTS.LIST).toBe('/admin/audit-logs');
    });

    it('should have EXPORT endpoint', () => {
      expect(AUDIT_LOG_ENDPOINTS.EXPORT).toBe('/admin/audit-logs/export');
    });

    it('should have CURSOR endpoint', () => {
      expect(AUDIT_LOG_ENDPOINTS.CURSOR).toBe('/admin/audit-logs/cursor');
    });

    it('should expose exactly the expected endpoint keys (guard)', () => {
      expect(Object.keys(AUDIT_LOG_ENDPOINTS).sort()).toEqual(['BY_RESOURCE', 'BY_USER', 'CURSOR', 'EXPORT', 'GET', 'LIST'].sort());
    });

    it('should have GET endpoint with id', () => {
      expect(AUDIT_LOG_ENDPOINTS.GET('log-123')).toBe('/admin/audit-logs/log-123');
    });

    it('should have BY_RESOURCE endpoint', () => {
      expect(AUDIT_LOG_ENDPOINTS.BY_RESOURCE('Role', 'r-1')).toBe('/admin/audit-logs/resource/Role/r-1');
    });

    it('should have BY_USER endpoint', () => {
      expect(AUDIT_LOG_ENDPOINTS.BY_USER('u-1')).toBe('/admin/audit-logs/user/u-1');
    });

    it('should encode special characters in id params', () => {
      expect(AUDIT_LOG_ENDPOINTS.GET('log/special')).toBe('/admin/audit-logs/log%2Fspecial');
    });

    it('should encode special characters in resource params', () => {
      expect(AUDIT_LOG_ENDPOINTS.BY_RESOURCE('Role', 'r/1')).toBe('/admin/audit-logs/resource/Role/r%2F1');
    });
  });

  describe('ROLE_ENDPOINTS hierarchy extensions', () => {
    it('should have CHILDREN endpoint', () => {
      expect(ROLE_ENDPOINTS.CHILDREN('r-parent')).toBe('/admin/rbac/roles/r-parent/children');
    });

    it('should have HIERARCHY endpoint', () => {
      expect(ROLE_ENDPOINTS.HIERARCHY('r-1')).toBe('/admin/rbac/roles/r-1/hierarchy');
    });

    it('should encode special characters in CHILDREN', () => {
      expect(ROLE_ENDPOINTS.CHILDREN('role/special')).toBe('/admin/rbac/roles/role%2Fspecial/children');
    });

    it('should encode special characters in HIERARCHY', () => {
      expect(ROLE_ENDPOINTS.HIERARCHY('role/special')).toBe('/admin/rbac/roles/role%2Fspecial/hierarchy');
    });
  });

  describe('existing ROLE_ENDPOINTS unchanged', () => {
    it('LIST path preserved', () => {
      expect(ROLE_ENDPOINTS.LIST).toBe('/admin/rbac/roles');
    });

    it('CREATE path preserved', () => {
      expect(ROLE_ENDPOINTS.CREATE).toBe('/admin/rbac/roles');
    });

    it('ASSIGN_POLICY path preserved', () => {
      expect(ROLE_ENDPOINTS.ASSIGN_POLICY('r-1', 'p-1')).toBe('/admin/rbac/roles/r-1/policies/p-1');
    });
  });

  describe('existing POLICY_ENDPOINTS unchanged', () => {
    it('LIST path preserved', () => {
      expect(POLICY_ENDPOINTS.LIST).toBe('/admin/rbac/policies');
    });

    it('VALIDATE path preserved', () => {
      expect(POLICY_ENDPOINTS.VALIDATE).toBe('/admin/rbac/policies/validate');
    });
  });
});
