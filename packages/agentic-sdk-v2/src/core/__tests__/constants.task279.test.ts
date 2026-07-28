/**
 * R-05 ROLE_ENDPOINTS split (user-self vs admin)
 *
 * The SDK previously exposed user-role assignment URLs only via
 * `ROLE_ENDPOINTS.USER_ROLES(userId)` / `ROLE_ENDPOINTS.USER_ROLE(userId, roleId)`,
 * rooted at `/users/:userId/roles/...`. The backend never exposed that path —
 * the real admin route is `/admin/users/:id/roles[/:assignmentId]` (see
 * `apps/api/src/modules/user/user.controller.ts`). At the same time, the
 * end-user "my roles" surface (canonical `/users/:id/roles`) is currently
 * served only by `/auth/me.roles`.
 *
 * This test pins the new shape:
 *   - `ROLE_ENDPOINTS.USER_ROLES` / `USER_ROLE` are kept at the user-self path
 *     (forward-looking placeholder) with the second arg of `USER_ROLE`
 *     renamed to `assignmentId` to match the join-table semantics.
 *   - A new `ADMIN_USER_ROLES_ENDPOINTS` block targets `/admin/users/:id/roles`.
 *
 * Tests are written RED-first; constants source is updated until every
 * assertion below passes.
 *
 * @vitest-environment jsdom
 */

import { describe, expect, it } from 'vitest';
import { ADMIN_USER_ROLES_ENDPOINTS, ROLE_ENDPOINTS } from '../constants';

// ---------------------------------------------------------------------------
// User-self surface preserved on ROLE_ENDPOINTS
// ---------------------------------------------------------------------------

describe('ROLE_ENDPOINTS user-self surface', () => {
  it('USER_ROLES(userId) targets the canonical user-self path /users/:id/roles', () => {
    expect(ROLE_ENDPOINTS.USER_ROLES('u-1')).toBe('/users/u-1/roles');
  });

  it('USER_ROLE(userId, assignmentId) preserves the user-self path with assignment id', () => {
    // Second argument is semantically `assignmentId` (a join-table row id),
    // NOT a roleId. Pass an arbitrary value to confirm it lands in the URL.
    expect(ROLE_ENDPOINTS.USER_ROLE('u-1', 'a-9')).toBe('/users/u-1/roles/a-9');
  });

  it('USER_ROLES(userId) encodes special characters in user id', () => {
    const dangerous = 'id/with?special#chars&more=true';
    expect(ROLE_ENDPOINTS.USER_ROLES(dangerous)).toBe('/users/' + encodeURIComponent(dangerous) + '/roles');
  });

  it('USER_ROLE(userId, assignmentId) encodes special characters in both ids', () => {
    const userId = 'u/with?chars';
    const assignmentId = 'a&with=chars';
    expect(ROLE_ENDPOINTS.USER_ROLE(userId, assignmentId)).toBe(
      '/users/' + encodeURIComponent(userId) + '/roles/' + encodeURIComponent(assignmentId),
    );
  });
});

// ---------------------------------------------------------------------------
// Admin surface — new ADMIN_USER_ROLES_ENDPOINTS block
// ---------------------------------------------------------------------------

describe('ADMIN_USER_ROLES_ENDPOINTS admin RBAC surface', () => {
  it('LIST(userId) returns /admin/users/:id/roles', () => {
    expect(ADMIN_USER_ROLES_ENDPOINTS.LIST('u-1')).toBe('/admin/users/u-1/roles');
  });

  it('ASSIGN(userId) returns /admin/users/:id/roles (POST target)', () => {
    expect(ADMIN_USER_ROLES_ENDPOINTS.ASSIGN('u-1')).toBe('/admin/users/u-1/roles');
  });

  it('REMOVE(userId, assignmentId) returns /admin/users/:id/roles/:assignmentId', () => {
    expect(ADMIN_USER_ROLES_ENDPOINTS.REMOVE('u-1', 'a-9')).toBe('/admin/users/u-1/roles/a-9');
  });

  it('encodes special characters in both userId and assignmentId for every helper', () => {
    const userId = 'u/with?chars';
    const assignmentId = 'a&with=chars';
    expect(ADMIN_USER_ROLES_ENDPOINTS.LIST(userId)).toBe('/admin/users/' + encodeURIComponent(userId) + '/roles');
    expect(ADMIN_USER_ROLES_ENDPOINTS.ASSIGN(userId)).toBe('/admin/users/' + encodeURIComponent(userId) + '/roles');
    expect(ADMIN_USER_ROLES_ENDPOINTS.REMOVE(userId, assignmentId)).toBe(
      '/admin/users/' + encodeURIComponent(userId) + '/roles/' + encodeURIComponent(assignmentId),
    );
  });

  it('keys are exactly {LIST, ASSIGN, REMOVE} — no listing endpoint surface drift', () => {
    expect(Object.keys(ADMIN_USER_ROLES_ENDPOINTS).sort()).toEqual(['ASSIGN', 'LIST', 'REMOVE']);
  });

  it('admin endpoints do NOT collide with the user-self path (different roots)', () => {
    expect(ADMIN_USER_ROLES_ENDPOINTS.LIST('u-1')).toMatch(/^\/admin\/users\//);
    expect(ROLE_ENDPOINTS.USER_ROLES('u-1')).toMatch(/^\/users\//);
    expect(ROLE_ENDPOINTS.USER_ROLES('u-1')).not.toMatch(/^\/admin\//);
  });
});
