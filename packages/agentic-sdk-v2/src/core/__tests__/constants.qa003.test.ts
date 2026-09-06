/**
 * QA-003 Constants Tests: POLICY_ENDPOINTS
 *
 * `AUDIT_LOG_ENDPOINTS` and `ROLE_ENDPOINTS` were removed under TASK-890
 * (OD-F/OD-K) along with their sole consumers, the admin `useAuditLog` and
 * `useRoles` hooks — `@arcaai/vox` carries no management surface.
 * `POLICY_ENDPOINTS` survives: `usePolicies` is not part of that removal.
 *
 * @vitest-environment jsdom
 */

import { describe, it, expect } from 'vitest';
import { POLICY_ENDPOINTS } from '../constants';

describe('QA-003: RBAC Constants Enhancements', () => {
  describe('existing POLICY_ENDPOINTS unchanged', () => {
    it('LIST path preserved', () => {
      expect(POLICY_ENDPOINTS.LIST).toBe('/admin/rbac/policies');
    });

    it('VALIDATE path preserved', () => {
      expect(POLICY_ENDPOINTS.VALIDATE).toBe('/admin/rbac/policies/validate');
    });
  });
});
