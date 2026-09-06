/**
 * Endpoint Constants Tests
 *
 * Verifies the business-plane endpoint constants added for WS-G features.
 *
 * `USER_ENDPOINTS`, `API_KEY_ENDPOINTS`, `ROLE_ENDPOINTS` and
 * `DNA_STYLE_ENDPOINTS` were removed under TASK-890 (OD-F/OD-K) along with
 * their sole consumers, the admin `useUsers`/`useApiKeys`/`useRoles`/
 * `useDnaStyle`/`useDnaDashboard` hooks — `@arcaai/vox` carries no
 * management surface.
 *
 * @vitest-environment jsdom
 */

import { describe, it, expect } from 'vitest';
import { STORAGE_ENDPOINTS, CONSULTATION_ENDPOINTS, CONSULTATION_JOB_ENDPOINTS } from '../constants';

describe('Endpoint Constants', () => {
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

  describe('CONSULTATION_ENDPOINTS (new LIST key)', () => {
    it('should have LIST as /consultations', () => {
      expect(CONSULTATION_ENDPOINTS.LIST).toBe('/consultations');
    });
    it('should still have existing OPEN', () => {
      expect(CONSULTATION_ENDPOINTS.OPEN).toBe('/consultations/open');
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
    it('should handle empty string IDs without crashing', () => {
      expect(STORAGE_ENDPOINTS.GET_FILE('', '')).toBe('/storage/buckets//files/');
    });

    it('should handle IDs with special characters', () => {
      expect(STORAGE_ENDPOINTS.GET_BUCKET('my-bucket-123')).toBe('/storage/buckets/my-bucket-123');
      expect(STORAGE_ENDPOINTS.GET_FILE('bucket', 'path/to/file.pdf')).toBe(
        `/storage/buckets/bucket/files/${encodeURIComponent('path/to/file.pdf')}`,
      );
    });

    it('static endpoints should be strings, dynamic endpoints should be functions', () => {
      expect(typeof STORAGE_ENDPOINTS.LIST_BUCKETS).toBe('string');
      expect(typeof STORAGE_ENDPOINTS.GET_BUCKET).toBe('function');
      expect(typeof STORAGE_ENDPOINTS.HEALTH).toBe('string');
    });
  });
});
