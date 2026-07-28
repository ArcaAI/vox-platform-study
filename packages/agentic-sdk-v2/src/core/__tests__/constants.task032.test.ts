/**
 * Endpoint Constants Tests
 *
 * Verifies all new endpoint constants added for WS-G features.
 *
 * @vitest-environment jsdom
 */

import { describe, it, expect } from 'vitest';
import {
  USER_ENDPOINTS,
  API_KEY_ENDPOINTS,
  STORAGE_ENDPOINTS,
  ROLE_ENDPOINTS,
  CONSULTATION_ENDPOINTS,
  DNA_STYLE_ENDPOINTS,
  CONSULTATION_JOB_ENDPOINTS,
} from '../constants';

describe('Endpoint Constants', () => {
  describe('USER_ENDPOINTS', () => {
    it('should have LIST as /admin/users', () => {
      expect(USER_ENDPOINTS.LIST).toBe('/admin/users');
    });
    it('should have GET as function returning /admin/users/:id', () => {
      expect(USER_ENDPOINTS.GET('u-1')).toBe('/admin/users/u-1');
    });
    it('should have CREATE as /admin/users', () => {
      expect(USER_ENDPOINTS.CREATE).toBe('/admin/users');
    });
    it('should have UPDATE as function returning /admin/users/:id', () => {
      expect(USER_ENDPOINTS.UPDATE('u-1')).toBe('/admin/users/u-1');
    });
    it('should have DELETE as function returning /admin/users/:id', () => {
      expect(USER_ENDPOINTS.DELETE('u-1')).toBe('/admin/users/u-1');
    });
    it('should have ME as /auth/me', () => {
      expect(USER_ENDPOINTS.ME).toBe('/auth/me');
    });
    it('should have BY_TENANT as function returning /admin/users/tenant/:tenantId', () => {
      expect(USER_ENDPOINTS.BY_TENANT('t-1')).toBe('/admin/users/tenant/t-1');
    });
  });

  describe('API_KEY_ENDPOINTS', () => {
    it('should have LIST as /admin/api-keys', () => {
      expect(API_KEY_ENDPOINTS.LIST).toBe('/admin/api-keys');
    });
    it('should have GET as function returning /admin/api-keys/:id', () => {
      expect(API_KEY_ENDPOINTS.GET('k-1')).toBe('/admin/api-keys/k-1');
    });
    it('should have CREATE as /admin/api-keys', () => {
      expect(API_KEY_ENDPOINTS.CREATE).toBe('/admin/api-keys');
    });
    it('should have UPDATE as function returning /admin/api-keys/:id', () => {
      expect(API_KEY_ENDPOINTS.UPDATE('k-1')).toBe('/admin/api-keys/k-1');
    });
    it('should have DELETE as function returning /admin/api-keys/:id', () => {
      expect(API_KEY_ENDPOINTS.DELETE('k-1')).toBe('/admin/api-keys/k-1');
    });
    it('should have REVOKE as function returning /admin/api-keys/:id/revoke', () => {
      expect(API_KEY_ENDPOINTS.REVOKE('k-1')).toBe('/admin/api-keys/k-1/revoke');
    });
  });

  describe('STORAGE_ENDPOINTS', () => {
    it('should have LIST_BUCKETS as /storage/buckets', () => {
      expect(STORAGE_ENDPOINTS.LIST_BUCKETS).toBe('/storage/buckets');
    });
    it('should have GET_BUCKET as function', () => {
      expect(STORAGE_ENDPOINTS.GET_BUCKET('my-bucket')).toBe('/storage/buckets/my-bucket');
    });
    it('should have LIST_FILES as function', () => {
      expect(STORAGE_ENDPOINTS.LIST_FILES('my-bucket')).toBe('/storage/buckets/my-bucket/files');
    });
    it('should have UPLOAD_FILE as function', () => {
      expect(STORAGE_ENDPOINTS.UPLOAD_FILE('my-bucket')).toBe('/storage/buckets/my-bucket/files');
    });
    it('should have GET_FILE as function with bucket and key', () => {
      expect(STORAGE_ENDPOINTS.GET_FILE('my-bucket', 'doc.pdf')).toBe('/storage/buckets/my-bucket/files/doc.pdf');
    });
    it('should have DELETE_FILE as function with bucket and key', () => {
      expect(STORAGE_ENDPOINTS.DELETE_FILE('my-bucket', 'doc.pdf')).toBe('/storage/buckets/my-bucket/files/doc.pdf');
    });
    it('should have HEALTH as /storage/health', () => {
      expect(STORAGE_ENDPOINTS.HEALTH).toBe('/storage/health');
    });
  });

  describe('ROLE_ENDPOINTS', () => {
    it('should have LIST as /admin/rbac/roles', () => {
      expect(ROLE_ENDPOINTS.LIST).toBe('/admin/rbac/roles');
    });
    it('should have GET as function returning /admin/rbac/roles/:id', () => {
      expect(ROLE_ENDPOINTS.GET('r-1')).toBe('/admin/rbac/roles/r-1');
    });
    it('should have CREATE as /admin/rbac/roles', () => {
      expect(ROLE_ENDPOINTS.CREATE).toBe('/admin/rbac/roles');
    });
    it('should have UPDATE as function', () => {
      expect(ROLE_ENDPOINTS.UPDATE('r-1')).toBe('/admin/rbac/roles/r-1');
    });
    it('should have DELETE as function', () => {
      expect(ROLE_ENDPOINTS.DELETE('r-1')).toBe('/admin/rbac/roles/r-1');
    });
    it('should have ASSIGN_POLICY as function with roleId and policyId', () => {
      expect(ROLE_ENDPOINTS.ASSIGN_POLICY('r-1', 'p-1')).toBe('/admin/rbac/roles/r-1/policies/p-1');
    });
    it('should have REMOVE_POLICY as function with roleId and policyId', () => {
      expect(ROLE_ENDPOINTS.REMOVE_POLICY('r-1', 'p-1')).toBe('/admin/rbac/roles/r-1/policies/p-1');
    });
  });

  describe('CONSULTATION_ENDPOINTS (new LIST key)', () => {
    it('should have LIST as /consultations', () => {
      expect(CONSULTATION_ENDPOINTS.LIST).toBe('/consultations');
    });
    it('should still have existing OPEN', () => {
      expect(CONSULTATION_ENDPOINTS.OPEN).toBe('/consultations/open');
    });
  });

  describe('DNA_STYLE_ENDPOINTS (new BY_DOCTOR key)', () => {
    it('should have BY_DOCTOR as function', () => {
      expect(DNA_STYLE_ENDPOINTS.BY_DOCTOR('doc-1')).toBe('/dna-writing-styles/doctor/doc-1');
    });
    it('should still have existing GENERATE', () => {
      expect(DNA_STYLE_ENDPOINTS.GENERATE).toBe('/dna-writing-styles/generate');
    });
  });

  describe('CONSULTATION_JOB_ENDPOINTS', () => {
    it('should have GET as function', () => {
      expect(CONSULTATION_JOB_ENDPOINTS.GET('job-1')).toBe('/consultations/jobs/job-1');
    });
    it('should have CANCEL as function', () => {
      expect(CONSULTATION_JOB_ENDPOINTS.CANCEL('job-1')).toBe('/consultations/jobs/job-1/cancel');
    });
    it('should have SSE as function', () => {
      expect(CONSULTATION_JOB_ENDPOINTS.SSE('job-1')).toBe('/consultations/jobs/job-1/stream');
    });
  });

  describe('dynamic endpoint edge cases', () => {
    it('should handle UUID-style IDs', () => {
      const uuid = '550e8400-e29b-41d4-a716-446655440000';
      expect(USER_ENDPOINTS.GET(uuid)).toBe(`/admin/users/${uuid}`);
      expect(API_KEY_ENDPOINTS.REVOKE(uuid)).toBe(`/admin/api-keys/${uuid}/revoke`);
      expect(ROLE_ENDPOINTS.ASSIGN_POLICY(uuid, uuid)).toBe(`/admin/rbac/roles/${uuid}/policies/${uuid}`);
    });

    it('should handle empty string IDs without crashing', () => {
      expect(USER_ENDPOINTS.GET('')).toBe('/admin/users/');
      expect(STORAGE_ENDPOINTS.GET_FILE('', '')).toBe('/storage/buckets//files/');
    });

    it('should handle IDs with special characters', () => {
      expect(STORAGE_ENDPOINTS.GET_BUCKET('my-bucket-123')).toBe('/storage/buckets/my-bucket-123');
      expect(STORAGE_ENDPOINTS.GET_FILE('bucket', 'path/to/file.pdf')).toBe(
        `/storage/buckets/bucket/files/${encodeURIComponent('path/to/file.pdf')}`,
      );
    });

    it('static endpoints should be strings, dynamic endpoints should be functions', () => {
      expect(typeof USER_ENDPOINTS.LIST).toBe('string');
      expect(typeof USER_ENDPOINTS.GET).toBe('function');
      expect(typeof USER_ENDPOINTS.CREATE).toBe('string');
      expect(typeof USER_ENDPOINTS.UPDATE).toBe('function');
      expect(typeof USER_ENDPOINTS.DELETE).toBe('function');
      expect(typeof USER_ENDPOINTS.ME).toBe('string');

      expect(typeof STORAGE_ENDPOINTS.LIST_BUCKETS).toBe('string');
      expect(typeof STORAGE_ENDPOINTS.GET_BUCKET).toBe('function');
      expect(typeof STORAGE_ENDPOINTS.HEALTH).toBe('string');
    });
  });
});
