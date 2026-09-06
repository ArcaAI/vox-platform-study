/**
 * Endpoint Constants Tests
 *
 * Verifies the TEXT_ENDPOINTS constant group. Every path is source-verified
 * against its API controller (paths omit the `/api/v1` prefix, which the
 * AgenticClient baseUrl carries).
 *
 * `ADMIN_CONSULTATION_ENDPOINTS`, `ADMIN_TRANSCRIPTION_JOB_ENDPOINTS`,
 * `TENANT_BUCKET_ENDPOINTS`, `STORAGE_KEY_ENDPOINTS` and
 * `TENANT_STORAGE_CONFIG_ENDPOINTS` were removed under TASK-890 (OD-F/OD-K)
 * along with their sole consumers, the admin `useAdminConsultations` /
 * `useAdminTranscriptionJobs` / `useTenantBuckets` / `useStorageKeys` /
 * `useTenantStorageConfig` hooks — `@arcaai/vox` carries no management
 * surface.
 *
 * @vitest-environment jsdom
 */

import { describe, it, expect } from 'vitest';
import { TEXT_ENDPOINTS } from '../constants';

describe('Endpoint Constants', () => {
  describe('TEXT_ENDPOINTS (text-proxy.controller.ts @Controller("text"))', () => {
    it('GENERATE is /text-generations/generate', () => {
      expect(TEXT_ENDPOINTS.GENERATE).toBe('/text-generations/generate');
    });
    it('GENERATE_ASSEMBLED is /text-generations/generate/assembled', () => {
      expect(TEXT_ENDPOINTS.GENERATE_ASSEMBLED).toBe('/text-generations/generate/assembled');
    });
    it('PROVIDERS is /text-generations/providers', () => {
      expect(TEXT_ENDPOINTS.PROVIDERS).toBe('/text-generations/providers');
    });
    it('TASK(id) is /text-generations/tasks/:id', () => {
      expect(TEXT_ENDPOINTS.TASK('t-1')).toBe('/text-generations/tasks/t-1');
    });
    it('TASK_CANCEL(id) is /text-generations/tasks/:id/cancel', () => {
      expect(TEXT_ENDPOINTS.TASK_CANCEL('t-1')).toBe('/text-generations/tasks/t-1/cancel');
    });
    it('TASK_STREAM(id) is /text-generations/tasks/:id/stream', () => {
      expect(TEXT_ENDPOINTS.TASK_STREAM('t-1')).toBe('/text-generations/tasks/t-1/stream');
    });
    it('encodes the task id path param', () => {
      expect(TEXT_ENDPOINTS.TASK('a/b')).toBe(`/text-generations/tasks/${encodeURIComponent('a/b')}`);
    });
  });

  describe('static vs dynamic shape', () => {
    it('static endpoints are strings, dynamic endpoints are functions', () => {
      expect(typeof TEXT_ENDPOINTS.GENERATE_ASSEMBLED).toBe('string');
      expect(typeof TEXT_ENDPOINTS.TASK_STREAM).toBe('function');
    });
  });
});
