/**
 * SDK Exports Verification Tests (TASK-279 follow-up / Wave-2A C4)
 *
 * The TASK-279 split (B6) introduced `ADMIN_USER_ROLES_ENDPOINTS` for the
 * admin user-role-assignment surface (`/admin/users/:id/roles[/:assignmentId]`).
 * The constant is defined in `core/constants.ts` and re-exported via the
 * inner `core/index.ts` barrel, but was NOT re-exported from the package
 * barrel `core.ts` (TASK-279 README §7.3). External consumers therefore
 * could not do `import { ADMIN_USER_ROLES_ENDPOINTS } from '@arcaai/vox/core'`
 * even though every sibling endpoint group (`ROLE_ENDPOINTS`,
 * `USER_ENDPOINTS`, `AUTH_ENDPOINTS`, …) is exposed there.
 *
 * This test pins the barrel-level re-export.
 *
 * @vitest-environment jsdom
 */

import { describe, it, expect } from 'vitest';

describe('TASK-279 — ADMIN_USER_ROLES_ENDPOINTS exported from package barrel', () => {
    it('should export ADMIN_USER_ROLES_ENDPOINTS from core.ts', async () => {
        const core = await import('../core.js');
        expect(core.ADMIN_USER_ROLES_ENDPOINTS).toBeDefined();
        expect(typeof core.ADMIN_USER_ROLES_ENDPOINTS).toBe('object');
    });

    it('LIST builder returns the admin URL', async () => {
        const core = await import('../core.js');
        expect(core.ADMIN_USER_ROLES_ENDPOINTS.LIST('u-1')).toBe('/admin/users/u-1/roles');
    });

    it('ASSIGN builder returns the admin URL', async () => {
        const core = await import('../core.js');
        expect(core.ADMIN_USER_ROLES_ENDPOINTS.ASSIGN('u-1')).toBe('/admin/users/u-1/roles');
    });

    it('REMOVE builder returns the admin URL with assignmentId', async () => {
        const core = await import('../core.js');
        expect(core.ADMIN_USER_ROLES_ENDPOINTS.REMOVE('u-1', 'a-9')).toBe('/admin/users/u-1/roles/a-9');
    });
});
