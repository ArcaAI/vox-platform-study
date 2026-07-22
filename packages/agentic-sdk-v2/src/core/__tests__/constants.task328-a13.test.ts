/**
 * Admin user-department + user-profile endpoint guards.
 *
 * Pins the URL shapes, special-char encoding, key-count (so the endpoint
 * surface cannot silently drift), and the package-barrel re-export from
 * `@arcaai/vox/core` (mirrors the ADMIN_USER_ROLES guard).
 *
 * @vitest-environment jsdom
 */

import { describe, expect, it } from 'vitest';
import { ADMIN_USER_DEPARTMENTS_ENDPOINTS, ADMIN_USER_PROFILE_ENDPOINTS } from '../constants';

describe('ADMIN_USER_DEPARTMENTS_ENDPOINTS', () => {
  it('LIST(userId) returns /admin/users/:id/departments', () => {
    expect(ADMIN_USER_DEPARTMENTS_ENDPOINTS.LIST('u-1')).toBe('/admin/users/u-1/departments');
  });

  it('ASSIGN(userId) returns /admin/users/:id/departments (POST target)', () => {
    expect(ADMIN_USER_DEPARTMENTS_ENDPOINTS.ASSIGN('u-1')).toBe('/admin/users/u-1/departments');
  });

  it('UPDATE(userId, assignmentId) returns /admin/users/:id/departments/:assignmentId', () => {
    expect(ADMIN_USER_DEPARTMENTS_ENDPOINTS.UPDATE('u-1', 'a-9')).toBe('/admin/users/u-1/departments/a-9');
  });

  it('REMOVE(userId, assignmentId) returns /admin/users/:id/departments/:assignmentId', () => {
    expect(ADMIN_USER_DEPARTMENTS_ENDPOINTS.REMOVE('u-1', 'a-9')).toBe('/admin/users/u-1/departments/a-9');
  });

  it('encodes special characters in both ids for every helper', () => {
    const userId = 'u/with?chars';
    const assignmentId = 'a&with=chars';
    expect(ADMIN_USER_DEPARTMENTS_ENDPOINTS.LIST(userId)).toBe(`/admin/users/${encodeURIComponent(userId)}/departments`);
    expect(ADMIN_USER_DEPARTMENTS_ENDPOINTS.ASSIGN(userId)).toBe(`/admin/users/${encodeURIComponent(userId)}/departments`);
    expect(ADMIN_USER_DEPARTMENTS_ENDPOINTS.UPDATE(userId, assignmentId)).toBe(
      `/admin/users/${encodeURIComponent(userId)}/departments/${encodeURIComponent(assignmentId)}`,
    );
    expect(ADMIN_USER_DEPARTMENTS_ENDPOINTS.REMOVE(userId, assignmentId)).toBe(
      `/admin/users/${encodeURIComponent(userId)}/departments/${encodeURIComponent(assignmentId)}`,
    );
  });

  it('keys are exactly {LIST, ASSIGN, UPDATE, REMOVE} — no surface drift', () => {
    expect(Object.keys(ADMIN_USER_DEPARTMENTS_ENDPOINTS).sort()).toEqual(['ASSIGN', 'LIST', 'REMOVE', 'UPDATE']);
  });
});

describe('ADMIN_USER_PROFILE_ENDPOINTS', () => {
  it('GET(userId) / UPDATE(userId) return /admin/users/:id/profile', () => {
    expect(ADMIN_USER_PROFILE_ENDPOINTS.GET('u-1')).toBe('/admin/users/u-1/profile');
    expect(ADMIN_USER_PROFILE_ENDPOINTS.UPDATE('u-1')).toBe('/admin/users/u-1/profile');
  });

  it('encodes special characters in the user id', () => {
    const userId = 'u/with?chars';
    expect(ADMIN_USER_PROFILE_ENDPOINTS.GET(userId)).toBe(`/admin/users/${encodeURIComponent(userId)}/profile`);
  });

  it('keys are exactly {GET, UPDATE}', () => {
    expect(Object.keys(ADMIN_USER_PROFILE_ENDPOINTS).sort()).toEqual(['GET', 'UPDATE']);
  });
});

describe('package barrel re-export from @arcaai/vox/core', () => {
  it('exposes ADMIN_USER_DEPARTMENTS_ENDPOINTS + ADMIN_USER_PROFILE_ENDPOINTS from core.ts', async () => {
    const core = await import('../../core.js');
    expect(core.ADMIN_USER_DEPARTMENTS_ENDPOINTS).toBeDefined();
    expect(core.ADMIN_USER_DEPARTMENTS_ENDPOINTS.LIST('u-1')).toBe('/admin/users/u-1/departments');
    expect(core.ADMIN_USER_PROFILE_ENDPOINTS).toBeDefined();
    expect(core.ADMIN_USER_PROFILE_ENDPOINTS.GET('u-1')).toBe('/admin/users/u-1/profile');
  });

  it('exposes the useUserDepartments hook from core.ts', async () => {
    const core = await import('../../core.js');
    expect(typeof core.useUserDepartments).toBe('function');
  });
});
