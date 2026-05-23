/**
 * TASK-210 Phase 6: SDK v2 Constants Route Standardization Tests
 *
 * Verifies all endpoint constants match the new /api/v1/<domain> route convention.
 * Written TDD-first — these tests define the target state before any constants change.
 *
 * @vitest-environment jsdom
 */

import { beforeAll, describe, expect, it } from 'vitest';
import {
  API_KEY_ENDPOINTS,
  AUTH_ENDPOINTS,
  CONSULTATION_ENDPOINTS,
  CONSULTATION_JOB_ENDPOINTS,
  CONTEXT_ENDPOINTS,
  DEPARTMENT_ENDPOINTS,
  DNA_STYLE_ENDPOINTS,
  ENTITY_ENDPOINTS,
  GLOBAL_SETTINGS_ENDPOINTS,
  HEALTH_ENDPOINTS,
  MONITORING_ENDPOINTS,
  MY_TENANT_ENDPOINTS,
  NLP_ENDPOINTS,
  PERSONALIZATION_ENDPOINTS,
  PIPELINE_ENDPOINTS,
  PROMPT_TEMPLATE_ENDPOINTS,
  ROLE_ENDPOINTS,
  SERVICE_HEALTH_ENDPOINTS,
  STORAGE_ENDPOINTS,
  STT_V2_ENDPOINTS,
  SUMMARY_ENDPOINTS,
  TENANT_ENDPOINTS,
  USER_ENDPOINTS,
  USER_SETTINGS_ENDPOINTS,
  VOICE_EMBEDDING_ENDPOINTS,
} from '../constants';

// =============================================================================
// PERSONALIZATION_ENDPOINTS: /users/me -> /user/me
// =============================================================================

describe('TASK-210 Phase 6: SDK v2 route standardization', () => {

  describe('PERSONALIZATION_ENDPOINTS (users/me -> user/me)', () => {
    it('should use /user/me/preferences for GET_PREFERENCES', () => {
      expect(PERSONALIZATION_ENDPOINTS.GET_PREFERENCES).toBe('/user/me/preferences');
    });

    it('should use /user/me/preferences for UPDATE_PREFERENCES', () => {
      expect(PERSONALIZATION_ENDPOINTS.UPDATE_PREFERENCES).toBe('/user/me/preferences');
    });

    it('should NOT use the old /users/me path', () => {
      expect(PERSONALIZATION_ENDPOINTS.GET_PREFERENCES).not.toContain('/users/me');
      expect(PERSONALIZATION_ENDPOINTS.UPDATE_PREFERENCES).not.toContain('/users/me');
    });
  });

  // ===========================================================================
  // STT_V2_ENDPOINTS: /api/v1/transcription-jobs -> /audio/transcription-jobs
  // ===========================================================================

  describe('STT_V2_ENDPOINTS (/api/v1/transcription-jobs -> /audio/transcription-jobs)', () => {
    it('should use /audio/transcription-jobs/stream/session for CREATE_SESSION', () => {
      expect(STT_V2_ENDPOINTS.CREATE_SESSION).toBe('/audio/transcription-jobs/stream/session');
    });

    it('should keep WS_STREAM unchanged at /ws/stt-v2/stream', () => {
      expect(STT_V2_ENDPOINTS.WS_STREAM).toBe('/ws/stt-v2/stream');
    });

    it('should use /audio/transcription-jobs for CREATE_JOB', () => {
      expect(STT_V2_ENDPOINTS.CREATE_JOB).toBe('/audio/transcription-jobs');
    });

    it('should use /audio/transcription-jobs/batch for CREATE_BATCH_JOB', () => {
      expect(STT_V2_ENDPOINTS.CREATE_BATCH_JOB).toBe('/audio/transcription-jobs/batch');
    });

    it('should use /audio/transcription-jobs/streaming for CREATE_STREAMING_JOB', () => {
      expect(STT_V2_ENDPOINTS.CREATE_STREAMING_JOB).toBe('/audio/transcription-jobs/streaming');
    });

    it('should use /audio/transcription-jobs/transcribe for TRANSCRIBE', () => {
      expect(STT_V2_ENDPOINTS.TRANSCRIBE).toBe('/audio/transcription-jobs/transcribe');
    });

    it('should use /audio/transcription-jobs/:id/stream for JOB_STREAM', () => {
      expect(STT_V2_ENDPOINTS.JOB_STREAM('job-123')).toBe('/audio/transcription-jobs/job-123/stream');
    });

    it('should use /audio/transcription-jobs/:id for GET_JOB', () => {
      expect(STT_V2_ENDPOINTS.GET_JOB('job-456')).toBe('/audio/transcription-jobs/job-456');
    });

    it('should use /audio/transcription-jobs for LIST_JOBS', () => {
      expect(STT_V2_ENDPOINTS.LIST_JOBS).toBe('/audio/transcription-jobs');
    });

    it('should use /audio/transcription-jobs/stats for JOB_STATS', () => {
      expect(STT_V2_ENDPOINTS.JOB_STATS).toBe('/audio/transcription-jobs/stats');
    });

    it('should use /audio/transcription-jobs/consultation/:id for JOBS_BY_CONSULTATION', () => {
      expect(STT_V2_ENDPOINTS.JOBS_BY_CONSULTATION('c-789')).toBe('/audio/transcription-jobs/consultation/c-789');
    });

    it('should use /audio/transcription-jobs/status/:status for JOBS_BY_STATUS', () => {
      expect(STT_V2_ENDPOINTS.JOBS_BY_STATUS('completed')).toBe('/audio/transcription-jobs/status/completed');
    });

    it('should use /audio/transcription-jobs/:id/cancel for CANCEL_JOB', () => {
      expect(STT_V2_ENDPOINTS.CANCEL_JOB('job-abc')).toBe('/audio/transcription-jobs/job-abc/cancel');
    });

    it('should use /audio/transcription-jobs/:id/retry for RETRY_JOB', () => {
      expect(STT_V2_ENDPOINTS.RETRY_JOB('job-abc')).toBe('/audio/transcription-jobs/job-abc/retry');
    });

    it('should generate CLOSE_SESSION with /audio/ prefix', () => {
      expect(STT_V2_ENDPOINTS.CLOSE_SESSION('sess-1')).toBe('/audio/transcription-jobs/stream/session/sess-1');
    });

    it('should NOT contain /api/v1/ prefix on any REST endpoint', () => {
      const restEndpoints = [
        STT_V2_ENDPOINTS.CREATE_SESSION,
        STT_V2_ENDPOINTS.CREATE_JOB,
        STT_V2_ENDPOINTS.CREATE_BATCH_JOB,
        STT_V2_ENDPOINTS.CREATE_STREAMING_JOB,
        STT_V2_ENDPOINTS.TRANSCRIBE,
        STT_V2_ENDPOINTS.LIST_JOBS,
        STT_V2_ENDPOINTS.JOB_STATS,
        STT_V2_ENDPOINTS.GET_JOB('x'),
        STT_V2_ENDPOINTS.JOB_STREAM('x'),
        STT_V2_ENDPOINTS.JOBS_BY_CONSULTATION('x'),
        STT_V2_ENDPOINTS.JOBS_BY_STATUS('x'),
        STT_V2_ENDPOINTS.CANCEL_JOB('x'),
        STT_V2_ENDPOINTS.RETRY_JOB('x'),
        STT_V2_ENDPOINTS.CLOSE_SESSION('x'),
      ];
      restEndpoints.forEach(ep => expect(ep).not.toContain('/api/v1/'));
    });
  });

  // ===========================================================================
  // PIPELINE_ENDPOINTS: /api/v1/pipelines -> /admin/audio/pipelines
  // ===========================================================================

  describe('PIPELINE_ENDPOINTS (read: /audio/pipelines, write: /admin/audio/pipelines)', () => {
    it('should use /audio/pipelines for LIST', () => {
      expect(PIPELINE_ENDPOINTS.LIST).toBe('/audio/pipelines');
    });

    it('should use /audio/pipelines/:id for GET', () => {
      expect(PIPELINE_ENDPOINTS.GET('pipe-1')).toBe('/audio/pipelines/pipe-1');
    });

    it('should use /audio/pipelines/slug/:slug for GET_BY_SLUG', () => {
      expect(PIPELINE_ENDPOINTS.GET_BY_SLUG('whisper-streaming')).toBe('/audio/pipelines/slug/whisper-streaming');
    });

    it('should use /admin/audio/pipelines/validate for VALIDATE', () => {
      expect(PIPELINE_ENDPOINTS.VALIDATE).toBe('/admin/audio/pipelines/validate');
    });

    it('should NOT contain /api/v1/ prefix', () => {
      const all = [
        PIPELINE_ENDPOINTS.LIST,
        PIPELINE_ENDPOINTS.VALIDATE,
        PIPELINE_ENDPOINTS.GET('x'),
        PIPELINE_ENDPOINTS.GET_BY_SLUG('x'),
      ];
      all.forEach(ep => expect(ep).not.toContain('/api/v1/'));
    });
  });

  // ===========================================================================
  // GLOBAL_SETTINGS_ENDPOINTS: /global-settings -> /admin/settings
  // ===========================================================================

  describe('GLOBAL_SETTINGS_ENDPOINTS (/global-settings -> /admin/settings)', () => {
    it('should use /admin/settings for LIST', () => {
      expect(GLOBAL_SETTINGS_ENDPOINTS.LIST).toBe('/admin/settings');
    });

    it('should use /admin/settings/:id for GET', () => {
      expect(GLOBAL_SETTINGS_ENDPOINTS.GET('s-1')).toBe('/admin/settings/s-1');
    });

    it('should use /admin/settings for CREATE', () => {
      expect(GLOBAL_SETTINGS_ENDPOINTS.CREATE).toBe('/admin/settings');
    });

    it('should use /admin/settings/:id for UPDATE', () => {
      expect(GLOBAL_SETTINGS_ENDPOINTS.UPDATE('s-1')).toBe('/admin/settings/s-1');
    });

    it('should use /admin/settings/tenant/:tenantId for BY_TENANT', () => {
      expect(GLOBAL_SETTINGS_ENDPOINTS.BY_TENANT('t-1')).toBe('/admin/settings/tenant/t-1');
    });

    it('should use /admin/settings/tenant/:tenantId/config for TENANT_CONFIG', () => {
      expect(GLOBAL_SETTINGS_ENDPOINTS.TENANT_CONFIG('t-1')).toBe('/admin/settings/tenant/t-1/config');
    });

    it('should NOT contain /global-settings path', () => {
      const all = [
        GLOBAL_SETTINGS_ENDPOINTS.LIST,
        GLOBAL_SETTINGS_ENDPOINTS.CREATE,
        GLOBAL_SETTINGS_ENDPOINTS.GET('x'),
        GLOBAL_SETTINGS_ENDPOINTS.UPDATE('x'),
        GLOBAL_SETTINGS_ENDPOINTS.BY_TENANT('x'),
        GLOBAL_SETTINGS_ENDPOINTS.TENANT_CONFIG('x'),
      ];
      all.forEach(ep => expect(ep).not.toContain('/global-settings'));
    });
  });

  // ===========================================================================
  // USER_SETTINGS_ENDPOINTS: /user-settings -> /user/me/settings
  // ===========================================================================

  describe('USER_SETTINGS_ENDPOINTS (/user-settings -> /user/me/settings)', () => {
    // TASK-265 W0-8 / GAP-03 reduced this surface to { list, updateByKey }
    // — see docs/implementation/TASK-265-SDK-Endpoint-Drift/README.md
    it('should use /user/me/settings for list', () => {
      expect(USER_SETTINGS_ENDPOINTS.list).toBe('/user/me/settings');
    });

    it('should NOT contain /user-settings path', () => {
      const all = [
        USER_SETTINGS_ENDPOINTS.list,
        USER_SETTINGS_ENDPOINTS.updateByKey('ns', 'k'),
      ];
      all.forEach(ep => expect(ep).not.toContain('/user-settings'));
    });
  });

  // ===========================================================================
  // API_KEY_ENDPOINTS: /api-keys -> /admin/api-keys
  // ===========================================================================

  describe('API_KEY_ENDPOINTS (/api-keys -> /admin/api-keys)', () => {
    it('should use /admin/api-keys for LIST', () => {
      expect(API_KEY_ENDPOINTS.LIST).toBe('/admin/api-keys');
    });

    it('should use /admin/api-keys/:id for GET', () => {
      expect(API_KEY_ENDPOINTS.GET('k-1')).toBe('/admin/api-keys/k-1');
    });

    it('should use /admin/api-keys for CREATE', () => {
      expect(API_KEY_ENDPOINTS.CREATE).toBe('/admin/api-keys');
    });

    it('should use /admin/api-keys/:id for UPDATE', () => {
      expect(API_KEY_ENDPOINTS.UPDATE('k-1')).toBe('/admin/api-keys/k-1');
    });

    it('should use /admin/api-keys/:id for DELETE', () => {
      expect(API_KEY_ENDPOINTS.DELETE('k-1')).toBe('/admin/api-keys/k-1');
    });

    it('should use /admin/api-keys/:id/revoke for REVOKE', () => {
      expect(API_KEY_ENDPOINTS.REVOKE('k-1')).toBe('/admin/api-keys/k-1/revoke');
    });

    it('should use /admin/api-keys/:id/usage for USAGE', () => {
      expect(API_KEY_ENDPOINTS.USAGE('k-1')).toBe('/admin/api-keys/k-1/usage');
    });
  });

  // ===========================================================================
  // ROLE_ENDPOINTS: /rbac/roles -> /admin/rbac/roles
  // ===========================================================================

  describe('ROLE_ENDPOINTS (/rbac/roles -> /admin/rbac/roles)', () => {
    it('should use /admin/rbac/roles for LIST', () => {
      expect(ROLE_ENDPOINTS.LIST).toBe('/admin/rbac/roles');
    });

    it('should use /admin/rbac/roles/:id for GET', () => {
      expect(ROLE_ENDPOINTS.GET('r-1')).toBe('/admin/rbac/roles/r-1');
    });

    it('should use /admin/rbac/roles for CREATE', () => {
      expect(ROLE_ENDPOINTS.CREATE).toBe('/admin/rbac/roles');
    });

    it('should use /admin/rbac/roles/:id for UPDATE', () => {
      expect(ROLE_ENDPOINTS.UPDATE('r-1')).toBe('/admin/rbac/roles/r-1');
    });

    it('should use /admin/rbac/roles/:id for DELETE', () => {
      expect(ROLE_ENDPOINTS.DELETE('r-1')).toBe('/admin/rbac/roles/r-1');
    });

    it('should use /admin/rbac/roles/:roleId/policies/:policyId for ASSIGN_POLICY', () => {
      expect(ROLE_ENDPOINTS.ASSIGN_POLICY('r-1', 'p-1')).toBe('/admin/rbac/roles/r-1/policies/p-1');
    });

    it('should use /admin/rbac/roles/:roleId/policies/:policyId for REMOVE_POLICY', () => {
      expect(ROLE_ENDPOINTS.REMOVE_POLICY('r-1', 'p-1')).toBe('/admin/rbac/roles/r-1/policies/p-1');
    });

    it('should keep USER_ROLES under /users (not admin)', () => {
      expect(ROLE_ENDPOINTS.USER_ROLES('u-1')).toBe('/users/u-1/roles');
    });

    it('should keep USER_ROLE under /users (not admin)', () => {
      expect(ROLE_ENDPOINTS.USER_ROLE('u-1', 'r-1')).toBe('/users/u-1/roles/r-1');
    });
  });

  // ===========================================================================
  // TENANT_ENDPOINTS: /tenants/configs -> /admin/tenants/configs
  // ===========================================================================

  describe('TENANT_ENDPOINTS (/tenants/configs -> /admin/tenants/configs)', () => {
    it('should use /admin/tenants/configs/:identifier for GET_CONFIGS', () => {
      expect(TENANT_ENDPOINTS.GET_CONFIGS('tenant-1')).toBe('/admin/tenants/configs/tenant-1');
    });

    it('should use /admin/tenants/configs/:identifier for UPDATE_CONFIGS', () => {
      expect(TENANT_ENDPOINTS.UPDATE_CONFIGS('tenant-1')).toBe('/admin/tenants/configs/tenant-1');
    });
  });

  // ===========================================================================
  // DNA_ENDPOINTS: should be removed (deprecated)
  // ===========================================================================

  describe('DNA_ENDPOINTS removal', () => {
    it('should no longer export DNA_ENDPOINTS from constants', async () => {
      const constants = await import('../constants.js');
      expect('DNA_ENDPOINTS' in constants).toBe(false);
    });
  });

  // ===========================================================================
  // Unchanged endpoints — regression guards
  // ===========================================================================

  describe('unchanged endpoints (regression guards)', () => {
    it('CONSULTATION_ENDPOINTS should be unchanged', () => {
      expect(CONSULTATION_ENDPOINTS.OPEN).toBe('/consultations/open');
      expect(CONSULTATION_ENDPOINTS.GET('123')).toBe('/consultations/123');
      expect(CONSULTATION_ENDPOINTS.LIST).toBe('/consultations');
    });

    it('CONTEXT_ENDPOINTS should be unchanged', () => {
      expect(CONTEXT_ENDPOINTS.ADD('123')).toBe('/consultations/123/context');
      expect(CONTEXT_ENDPOINTS.GET('123')).toBe('/consultations/123/context');
    });

    it('SUMMARY_ENDPOINTS should be unchanged', () => {
      expect(SUMMARY_ENDPOINTS.GENERATE('123')).toBe('/consultations/123/summary');
      expect(SUMMARY_ENDPOINTS.LATEST('123')).toBe('/consultations/123/summary/latest');
    });

    it('ENTITY_ENDPOINTS should be unchanged', () => {
      expect(ENTITY_ENDPOINTS.GET_ALL('123')).toBe('/consultations/123/named-entities');
    });

    it('DNA_STYLE_ENDPOINTS should be unchanged', () => {
      expect(DNA_STYLE_ENDPOINTS.GENERATE).toBe('/dna-writing-styles/generate');
      expect(DNA_STYLE_ENDPOINTS.MY_STYLE).toBe('/dna-writing-styles/my-style');
      expect(DNA_STYLE_ENDPOINTS.ADMIN_LIST).toBe('/admin/dna-writing-styles');
    });

    it('PROMPT_TEMPLATE_ENDPOINTS should be unchanged', () => {
      expect(PROMPT_TEMPLATE_ENDPOINTS.LIST).toBe('/prompt-templates');
      expect(PROMPT_TEMPLATE_ENDPOINTS.CREATE).toBe('/prompt-templates');
    });

    it('DEPARTMENT_ENDPOINTS should use admin prefix', () => {
      expect(DEPARTMENT_ENDPOINTS.LIST).toBe('/admin/departments');
      expect(DEPARTMENT_ENDPOINTS.GET('d-1')).toBe('/admin/departments/d-1');
    });

    it('HEALTH_ENDPOINTS should be unchanged', () => {
      expect(HEALTH_ENDPOINTS.HEALTH).toBe('/health');
      expect(HEALTH_ENDPOINTS.LIVE).toBe('/health/live');
      expect(HEALTH_ENDPOINTS.READY).toBe('/health/ready');
    });

    it('MONITORING_ENDPOINTS should be unchanged', () => {
      expect(MONITORING_ENDPOINTS.UPTIME).toBe('/monitoring/uptime');
      expect(MONITORING_ENDPOINTS.SESSIONS).toBe('/monitoring/sessions');
    });

    it('AUTH_ENDPOINTS should be unchanged', () => {
      expect(AUTH_ENDPOINTS.LOGIN).toBe('/auth/login');
      expect(AUTH_ENDPOINTS.LOGOUT).toBe('/auth/logout');
      expect(AUTH_ENDPOINTS.ME).toBe('/auth/me');
      expect(AUTH_ENDPOINTS.IMPERSONATE).toBe('/auth/impersonate');
    });

    it('SERVICE_HEALTH_ENDPOINTS should use consolidated /health/services endpoint', () => {
      expect(SERVICE_HEALTH_ENDPOINTS.SERVICES).toBe('/health/services');
      expect(Object.keys(SERVICE_HEALTH_ENDPOINTS)).toHaveLength(1);
    });

    it('NLP_ENDPOINTS should be unchanged', () => {
      expect(NLP_ENDPOINTS.CLASSIFY_TOKENS).toBe('/nlp/classify/tokens');
      expect(NLP_ENDPOINTS.CLASSIFY_TEXT).toBe('/nlp/classify/text');
    });

    it('CONSULTATION_JOB_ENDPOINTS should be unchanged', () => {
      expect(CONSULTATION_JOB_ENDPOINTS.GET('j-1')).toBe('/consultations/jobs/j-1');
    });

    it('USER_ENDPOINTS should use admin prefix', () => {
      expect(USER_ENDPOINTS.LIST).toBe('/admin/users');
      expect(USER_ENDPOINTS.ME).toBe('/auth/me');
    });

    it('STORAGE_ENDPOINTS should be unchanged', () => {
      expect(STORAGE_ENDPOINTS.LIST_BUCKETS).toBe('/storage/buckets');
      expect(STORAGE_ENDPOINTS.HEALTH).toBe('/storage/health');
    });

    it('VOICE_EMBEDDING_ENDPOINTS targets the /voice-profile API (TASK-265 W0-7)', () => {
      expect(VOICE_EMBEDDING_ENDPOINTS.enroll).toBe('/voice-profile/enroll');
      expect(VOICE_EMBEDDING_ENDPOINTS.list).toBe('/voice-profile');
      expect(VOICE_EMBEDDING_ENDPOINTS.delete('p-1')).toBe('/voice-profile/p-1');
    });
  });

  // ===========================================================================
  // Structural: all endpoints start with / and have no trailing slash
  // ===========================================================================

  describe('structural invariants', () => {
    it('all static changed endpoints should start with /', () => {
      const statics = [
        PERSONALIZATION_ENDPOINTS.GET_PREFERENCES,
        PERSONALIZATION_ENDPOINTS.UPDATE_PREFERENCES,
        STT_V2_ENDPOINTS.CREATE_SESSION,
        STT_V2_ENDPOINTS.CREATE_JOB,
        STT_V2_ENDPOINTS.CREATE_BATCH_JOB,
        STT_V2_ENDPOINTS.CREATE_STREAMING_JOB,
        STT_V2_ENDPOINTS.TRANSCRIBE,
        STT_V2_ENDPOINTS.LIST_JOBS,
        STT_V2_ENDPOINTS.JOB_STATS,
        PIPELINE_ENDPOINTS.LIST,
        PIPELINE_ENDPOINTS.VALIDATE,
        GLOBAL_SETTINGS_ENDPOINTS.LIST,
        GLOBAL_SETTINGS_ENDPOINTS.CREATE,
        USER_SETTINGS_ENDPOINTS.list,
        API_KEY_ENDPOINTS.LIST,
        API_KEY_ENDPOINTS.CREATE,
        ROLE_ENDPOINTS.LIST,
        ROLE_ENDPOINTS.CREATE,
      ];
      statics.forEach(ep => {
        expect(ep).toMatch(/^\//);
        expect(ep).not.toMatch(/\/$/);
      });
    });

    it('all dynamic changed endpoints should return paths starting with /', () => {
      const dynamics = [
        STT_V2_ENDPOINTS.GET_JOB('x'),
        STT_V2_ENDPOINTS.JOB_STREAM('x'),
        STT_V2_ENDPOINTS.JOBS_BY_CONSULTATION('x'),
        STT_V2_ENDPOINTS.JOBS_BY_STATUS('x'),
        STT_V2_ENDPOINTS.CANCEL_JOB('x'),
        STT_V2_ENDPOINTS.RETRY_JOB('x'),
        STT_V2_ENDPOINTS.CLOSE_SESSION('x'),
        PIPELINE_ENDPOINTS.GET('x'),
        PIPELINE_ENDPOINTS.GET_BY_SLUG('x'),
        GLOBAL_SETTINGS_ENDPOINTS.GET('x'),
        GLOBAL_SETTINGS_ENDPOINTS.UPDATE('x'),
        GLOBAL_SETTINGS_ENDPOINTS.BY_TENANT('x'),
        GLOBAL_SETTINGS_ENDPOINTS.TENANT_CONFIG('x'),
        USER_SETTINGS_ENDPOINTS.updateByKey('x', 'y'),
        API_KEY_ENDPOINTS.GET('x'),
        API_KEY_ENDPOINTS.UPDATE('x'),
        API_KEY_ENDPOINTS.DELETE('x'),
        API_KEY_ENDPOINTS.REVOKE('x'),
        API_KEY_ENDPOINTS.USAGE('x'),
        ROLE_ENDPOINTS.GET('x'),
        ROLE_ENDPOINTS.UPDATE('x'),
        ROLE_ENDPOINTS.DELETE('x'),
        ROLE_ENDPOINTS.ASSIGN_POLICY('x', 'y'),
        ROLE_ENDPOINTS.REMOVE_POLICY('x', 'y'),
        TENANT_ENDPOINTS.GET_CONFIGS('x'),
        TENANT_ENDPOINTS.UPDATE_CONFIGS('x'),
      ];
      dynamics.forEach(ep => {
        expect(ep).toMatch(/^\//);
      });
    });
  });

  // ===========================================================================
  // Edge cases: URI encoding on changed endpoints
  // ===========================================================================

  describe('URI encoding on changed endpoints', () => {
    const dangerous = 'id/with?special#chars&more=true';
    const encoded = encodeURIComponent(dangerous);

    it('STT_V2_ENDPOINTS should encode special chars in all dynamic endpoints', () => {
      expect(STT_V2_ENDPOINTS.GET_JOB(dangerous)).toContain(encoded);
      expect(STT_V2_ENDPOINTS.GET_JOB(dangerous)).not.toContain(dangerous);
      expect(STT_V2_ENDPOINTS.JOB_STREAM(dangerous)).toContain(encoded);
      expect(STT_V2_ENDPOINTS.CLOSE_SESSION(dangerous)).toContain(encoded);
      expect(STT_V2_ENDPOINTS.JOBS_BY_CONSULTATION(dangerous)).toContain(encoded);
      expect(STT_V2_ENDPOINTS.JOBS_BY_STATUS(dangerous)).toContain(encoded);
      expect(STT_V2_ENDPOINTS.CANCEL_JOB(dangerous)).toContain(encoded);
      expect(STT_V2_ENDPOINTS.RETRY_JOB(dangerous)).toContain(encoded);
    });

    it('PIPELINE_ENDPOINTS should encode special chars', () => {
      expect(PIPELINE_ENDPOINTS.GET(dangerous)).toContain(encoded);
      expect(PIPELINE_ENDPOINTS.GET_BY_SLUG(dangerous)).toContain(encoded);
    });

    it('GLOBAL_SETTINGS_ENDPOINTS should encode special chars', () => {
      expect(GLOBAL_SETTINGS_ENDPOINTS.GET(dangerous)).toContain(encoded);
      expect(GLOBAL_SETTINGS_ENDPOINTS.UPDATE(dangerous)).toContain(encoded);
      expect(GLOBAL_SETTINGS_ENDPOINTS.BY_TENANT(dangerous)).toContain(encoded);
      expect(GLOBAL_SETTINGS_ENDPOINTS.TENANT_CONFIG(dangerous)).toContain(encoded);
    });

    it('USER_SETTINGS_ENDPOINTS should encode special chars (TASK-265 reduced surface)', () => {
      const path = USER_SETTINGS_ENDPOINTS.updateByKey(dangerous, dangerous);
      expect(path.split(encoded).length - 1).toBe(2);
    });

    it('API_KEY_ENDPOINTS should encode special chars', () => {
      expect(API_KEY_ENDPOINTS.GET(dangerous)).toContain(encoded);
      expect(API_KEY_ENDPOINTS.UPDATE(dangerous)).toContain(encoded);
      expect(API_KEY_ENDPOINTS.DELETE(dangerous)).toContain(encoded);
      expect(API_KEY_ENDPOINTS.REVOKE(dangerous)).toContain(encoded);
      expect(API_KEY_ENDPOINTS.USAGE(dangerous)).toContain(encoded);
    });

    it('ROLE_ENDPOINTS should encode special chars in both parameters', () => {
      expect(ROLE_ENDPOINTS.GET(dangerous)).toContain(encoded);
      expect(ROLE_ENDPOINTS.UPDATE(dangerous)).toContain(encoded);
      expect(ROLE_ENDPOINTS.DELETE(dangerous)).toContain(encoded);
      const assignPath = ROLE_ENDPOINTS.ASSIGN_POLICY(dangerous, dangerous);
      const occurrences = assignPath.split(encoded).length - 1;
      expect(occurrences).toBe(2);
    });

    it('TENANT_ENDPOINTS should encode special chars', () => {
      expect(TENANT_ENDPOINTS.GET_CONFIGS(dangerous)).toContain(encoded);
      expect(TENANT_ENDPOINTS.UPDATE_CONFIGS(dangerous)).toContain(encoded);
    });

  });

  // ===========================================================================
  // Edge cases: UUID-format IDs on changed endpoints
  // ===========================================================================

  describe('UUID-format IDs on changed endpoints', () => {
    const uuid = '550e8400-e29b-41d4-a716-446655440000';

    it('STT_V2_ENDPOINTS should handle UUID IDs', () => {
      expect(STT_V2_ENDPOINTS.GET_JOB(uuid)).toBe(`/audio/transcription-jobs/${uuid}`);
      expect(STT_V2_ENDPOINTS.CANCEL_JOB(uuid)).toBe(`/audio/transcription-jobs/${uuid}/cancel`);
      expect(STT_V2_ENDPOINTS.RETRY_JOB(uuid)).toBe(`/audio/transcription-jobs/${uuid}/retry`);
      expect(STT_V2_ENDPOINTS.JOB_STREAM(uuid)).toBe(`/audio/transcription-jobs/${uuid}/stream`);
      expect(STT_V2_ENDPOINTS.CLOSE_SESSION(uuid)).toBe(`/audio/transcription-jobs/stream/session/${uuid}`);
    });

    it('PIPELINE_ENDPOINTS should handle UUID IDs', () => {
      expect(PIPELINE_ENDPOINTS.GET(uuid)).toBe(`/audio/pipelines/${uuid}`);
    });

    it('admin endpoints should handle UUID IDs', () => {
      expect(GLOBAL_SETTINGS_ENDPOINTS.GET(uuid)).toBe(`/admin/settings/${uuid}`);
      expect(API_KEY_ENDPOINTS.GET(uuid)).toBe(`/admin/api-keys/${uuid}`);
      expect(API_KEY_ENDPOINTS.REVOKE(uuid)).toBe(`/admin/api-keys/${uuid}/revoke`);
      expect(ROLE_ENDPOINTS.GET(uuid)).toBe(`/admin/rbac/roles/${uuid}`);
      expect(TENANT_ENDPOINTS.GET_CONFIGS(uuid)).toBe(`/admin/tenants/configs/${uuid}`);
    });
  });

  // ===========================================================================
  // Edge cases: empty string parameters
  // ===========================================================================

  describe('empty string parameters on changed endpoints', () => {
    it('should not throw for empty string IDs', () => {
      expect(() => STT_V2_ENDPOINTS.GET_JOB('')).not.toThrow();
      expect(() => PIPELINE_ENDPOINTS.GET('')).not.toThrow();
      expect(() => GLOBAL_SETTINGS_ENDPOINTS.GET('')).not.toThrow();
      expect(() => USER_SETTINGS_ENDPOINTS.updateByKey('', '')).not.toThrow();
      expect(() => API_KEY_ENDPOINTS.GET('')).not.toThrow();
      expect(() => ROLE_ENDPOINTS.GET('')).not.toThrow();
      expect(() => TENANT_ENDPOINTS.GET_CONFIGS('')).not.toThrow();
    });

    it('should still produce valid path structure with empty IDs', () => {
      expect(STT_V2_ENDPOINTS.GET_JOB('')).toMatch(/^\/audio\/transcription-jobs\//);
      expect(GLOBAL_SETTINGS_ENDPOINTS.GET('')).toMatch(/^\/admin\/settings\//);
      expect(API_KEY_ENDPOINTS.GET('')).toMatch(/^\/admin\/api-keys\//);
      expect(ROLE_ENDPOINTS.GET('')).toMatch(/^\/admin\/rbac\/roles\//);
      expect(TENANT_ENDPOINTS.GET_CONFIGS('')).toMatch(/^\/admin\/tenants\/configs\//);
    });
  });

  // ===========================================================================
  // Edge cases: no double slashes in any changed endpoint
  // ===========================================================================

  describe('no double slashes in changed endpoints', () => {
    it('static endpoints should not contain //', () => {
      const statics = [
        PERSONALIZATION_ENDPOINTS.GET_PREFERENCES,
        PERSONALIZATION_ENDPOINTS.UPDATE_PREFERENCES,
        STT_V2_ENDPOINTS.CREATE_SESSION,
        STT_V2_ENDPOINTS.CREATE_JOB,
        STT_V2_ENDPOINTS.CREATE_BATCH_JOB,
        STT_V2_ENDPOINTS.CREATE_STREAMING_JOB,
        STT_V2_ENDPOINTS.TRANSCRIBE,
        STT_V2_ENDPOINTS.LIST_JOBS,
        STT_V2_ENDPOINTS.JOB_STATS,
        PIPELINE_ENDPOINTS.LIST,
        PIPELINE_ENDPOINTS.VALIDATE,
        GLOBAL_SETTINGS_ENDPOINTS.LIST,
        GLOBAL_SETTINGS_ENDPOINTS.CREATE,
        USER_SETTINGS_ENDPOINTS.list,
        API_KEY_ENDPOINTS.LIST,
        API_KEY_ENDPOINTS.CREATE,
        ROLE_ENDPOINTS.LIST,
        ROLE_ENDPOINTS.CREATE,
      ];
      statics.forEach(ep => {
        expect(ep).not.toMatch(/\/\//);
      });
    });

    it('dynamic endpoints with valid IDs should not contain //', () => {
      const id = 'test-id';
      const dynamics = [
        STT_V2_ENDPOINTS.GET_JOB(id),
        STT_V2_ENDPOINTS.JOB_STREAM(id),
        STT_V2_ENDPOINTS.CLOSE_SESSION(id),
        STT_V2_ENDPOINTS.CANCEL_JOB(id),
        STT_V2_ENDPOINTS.RETRY_JOB(id),
        STT_V2_ENDPOINTS.JOBS_BY_CONSULTATION(id),
        STT_V2_ENDPOINTS.JOBS_BY_STATUS(id),
        PIPELINE_ENDPOINTS.GET(id),
        PIPELINE_ENDPOINTS.GET_BY_SLUG(id),
        GLOBAL_SETTINGS_ENDPOINTS.GET(id),
        GLOBAL_SETTINGS_ENDPOINTS.UPDATE(id),
        GLOBAL_SETTINGS_ENDPOINTS.BY_TENANT(id),
        GLOBAL_SETTINGS_ENDPOINTS.TENANT_CONFIG(id),
        USER_SETTINGS_ENDPOINTS.updateByKey(id, id),
        API_KEY_ENDPOINTS.GET(id),
        API_KEY_ENDPOINTS.UPDATE(id),
        API_KEY_ENDPOINTS.DELETE(id),
        API_KEY_ENDPOINTS.REVOKE(id),
        API_KEY_ENDPOINTS.USAGE(id),
        ROLE_ENDPOINTS.GET(id),
        ROLE_ENDPOINTS.UPDATE(id),
        ROLE_ENDPOINTS.DELETE(id),
        ROLE_ENDPOINTS.ASSIGN_POLICY(id, id),
        ROLE_ENDPOINTS.REMOVE_POLICY(id, id),
        TENANT_ENDPOINTS.GET_CONFIGS(id),
        TENANT_ENDPOINTS.UPDATE_CONFIGS(id),
      ];
      dynamics.forEach(ep => {
        expect(ep).not.toMatch(/\/\//);
      });
    });
  });

  // ===========================================================================
  // Key count completeness for changed constant groups
  // ===========================================================================

  describe('key count completeness (structural drift guard)', () => {
    it('PERSONALIZATION_ENDPOINTS should have exactly 2 keys', () => {
      expect(Object.keys(PERSONALIZATION_ENDPOINTS)).toHaveLength(2);
    });

    it('STT_V2_ENDPOINTS should have exactly 15 keys', () => {
      expect(Object.keys(STT_V2_ENDPOINTS)).toHaveLength(15);
      expect(Object.keys(STT_V2_ENDPOINTS)).toEqual(expect.arrayContaining([
        'CREATE_SESSION', 'CLOSE_SESSION', 'WS_STREAM', 'CREATE_JOB',
        'CREATE_BATCH_JOB', 'CREATE_STREAMING_JOB', 'TRANSCRIBE',
        'JOB_STREAM', 'GET_JOB', 'LIST_JOBS', 'JOB_STATS',
        'JOBS_BY_CONSULTATION', 'JOBS_BY_STATUS', 'CANCEL_JOB', 'RETRY_JOB',
      ]));
    });

    it('PIPELINE_ENDPOINTS should have exactly 9 keys', () => {
      expect(Object.keys(PIPELINE_ENDPOINTS)).toHaveLength(9);
    });

    it('GLOBAL_SETTINGS_ENDPOINTS should have exactly 7 keys', () => {
      expect(Object.keys(GLOBAL_SETTINGS_ENDPOINTS)).toHaveLength(7);
    });

    it('USER_SETTINGS_ENDPOINTS should have exactly 2 keys (TASK-265 W0-8 reduction)', () => {
      expect(Object.keys(USER_SETTINGS_ENDPOINTS)).toHaveLength(2);
      expect(Object.keys(USER_SETTINGS_ENDPOINTS).sort()).toEqual(['list', 'updateByKey']);
    });

    it('API_KEY_ENDPOINTS should have exactly 7 keys', () => {
      expect(Object.keys(API_KEY_ENDPOINTS)).toHaveLength(7);
    });

    it('ROLE_ENDPOINTS should have exactly 11 keys', () => {
      expect(Object.keys(ROLE_ENDPOINTS)).toHaveLength(11);
    });

    it('TENANT_ENDPOINTS should have exactly 8 keys', () => {
      expect(Object.keys(TENANT_ENDPOINTS)).toHaveLength(8);
    });
  });

  // ===========================================================================
  // Stale old-path string literal sweep
  // ===========================================================================

  describe('stale old-path sweep (source-level regression)', () => {
    let constantsSource: string;

    beforeAll(async () => {
      const fs = await import('fs');
      const path = await import('path');
      constantsSource = fs.readFileSync(
        path.resolve(__dirname, '../constants.ts'),
        'utf-8',
      );
    });

    function codeLines(src: string): string[] {
      return src.split('\n').filter(l => {
        const t = l.trimStart();
        return !t.startsWith('*') && !t.startsWith('//') && !t.startsWith('/**');
      });
    }

    it('should not contain /api/v1/ai-models in any code line', () => {
      const code = codeLines(constantsSource);
      const matches = code.filter(l => l.includes('/api/v1/ai-models'));
      expect(matches).toHaveLength(0);
    });

    it('should not contain /api/v1/transcription-jobs in any code line', () => {
      const code = codeLines(constantsSource);
      const matches = code.filter(l => l.includes('/api/v1/transcription-jobs'));
      expect(matches).toHaveLength(0);
    });

    it('should not contain /api/v1/pipelines in any code line', () => {
      const code = codeLines(constantsSource);
      const matches = code.filter(l => l.includes('/api/v1/pipelines'));
      expect(matches).toHaveLength(0);
    });

    it('should not contain /users/me/preferences in any code line', () => {
      const code = codeLines(constantsSource);
      const matches = code.filter(l => l.includes('/users/me/preferences'));
      expect(matches).toHaveLength(0);
    });

    it('should not contain /global-settings as endpoint path in any code line', () => {
      const code = codeLines(constantsSource);
      const matches = code.filter(l =>
        l.includes("'/global-settings") || l.includes('`/global-settings')
      );
      expect(matches).toHaveLength(0);
    });

    it('should not contain /user-settings as endpoint path in any code line', () => {
      const code = codeLines(constantsSource);
      const matches = code.filter(l =>
        l.includes("'/user-settings") || l.includes('`/user-settings')
      );
      expect(matches).toHaveLength(0);
    });

    it('should not contain bare /api-keys (without /admin prefix) as endpoint path', () => {
      const lines = constantsSource.split('\n');
      const endpointLines = lines.filter(l =>
        (l.includes("'/api-keys") || l.includes('`/api-keys')) &&
        !l.includes('/admin/api-keys') &&
        !l.trimStart().startsWith('*') &&
        !l.trimStart().startsWith('//')
      );
      expect(endpointLines).toHaveLength(0);
    });

    it('should not contain bare /rbac/roles (without /admin prefix) as endpoint path', () => {
      const lines = constantsSource.split('\n');
      const endpointLines = lines.filter(l =>
        (l.includes("'/rbac/roles") || l.includes('`/rbac/roles')) &&
        !l.includes('/admin/rbac/roles') &&
        !l.trimStart().startsWith('*') &&
        !l.trimStart().startsWith('//')
      );
      expect(endpointLines).toHaveLength(0);
    });

    it('should not contain bare /tenants/configs (without /admin prefix) as endpoint path', () => {
      const lines = constantsSource.split('\n');
      const endpointLines = lines.filter(l =>
        (l.includes("'/tenants/configs") || l.includes('`/tenants/configs')) &&
        !l.includes('/admin/tenants/configs') &&
        !l.trimStart().startsWith('*') &&
        !l.trimStart().startsWith('//')
      );
      expect(endpointLines).toHaveLength(0);
    });

    it('should not contain DNA_ENDPOINTS export', () => {
      expect(constantsSource).not.toMatch(/export\s+const\s+DNA_ENDPOINTS/);
    });
  });

  // ===========================================================================
  // Re-export completeness (core.ts should export all, and only, expected constants)
  // ===========================================================================

  describe('re-export completeness', () => {
    it('should export all endpoint constant groups from constants module', async () => {
      const constants = await import('../constants.js');
      const expectedExports = [
        'CONSULTATION_ENDPOINTS',
        'CONTEXT_ENDPOINTS',
        'SUMMARY_ENDPOINTS',
        'ENTITY_ENDPOINTS',
        'PERSONALIZATION_ENDPOINTS',
        'DNA_STYLE_ENDPOINTS',
        'PROMPT_TEMPLATE_ENDPOINTS',
        'DEPARTMENT_ENDPOINTS',
        'HEALTH_ENDPOINTS',
        'MONITORING_ENDPOINTS',
        'TENANT_ENDPOINTS',
        'STT_V2_ENDPOINTS',
        'PIPELINE_ENDPOINTS',
        'NLP_ENDPOINTS',
        'AUTH_ENDPOINTS',
        'SERVICE_HEALTH_ENDPOINTS',
        'GLOBAL_SETTINGS_ENDPOINTS',
        'USER_SETTINGS_ENDPOINTS',
        'CONSULTATION_JOB_ENDPOINTS',
        'USER_ENDPOINTS',
        'API_KEY_ENDPOINTS',
        'STORAGE_ENDPOINTS',
        'ROLE_ENDPOINTS',
        'VOICE_EMBEDDING_ENDPOINTS',
        'MY_TENANT_ENDPOINTS',
      ];
      expectedExports.forEach(name => {
        expect(constants).toHaveProperty(name);
      });
    });

    it('should NOT export DNA_ENDPOINTS', async () => {
      const constants = await import('../constants.js');
      expect('DNA_ENDPOINTS' in constants).toBe(false);
    });
  });

  // ===========================================================================
  // Backend route alignment: SDK paths must match @Controller() paths from Phase 3
  // ===========================================================================

  describe('backend route alignment', () => {
    it('audio domain endpoints should use /audio/ prefix (matching audio/* controllers)', () => {
      expect(STT_V2_ENDPOINTS.CREATE_JOB).toMatch(/^\/audio\//);
    });

    it('admin endpoints should use /admin/ prefix (matching admin/* controllers)', () => {
      expect(GLOBAL_SETTINGS_ENDPOINTS.LIST).toMatch(/^\/admin\//);
      expect(API_KEY_ENDPOINTS.LIST).toMatch(/^\/admin\//);
      expect(ROLE_ENDPOINTS.LIST).toMatch(/^\/admin\//);
      expect(TENANT_ENDPOINTS.GET_CONFIGS('x')).toMatch(/^\/admin\//);
      expect(PIPELINE_ENDPOINTS.CREATE).toMatch(/^\/admin\//);
    });

    it('user self-service endpoints should use /user/me/ prefix', () => {
      expect(PERSONALIZATION_ENDPOINTS.GET_PREFERENCES).toMatch(/^\/user\/me\//);
      expect(USER_SETTINGS_ENDPOINTS.list).toMatch(/^\/user\/me\//);
    });

    it('WS_STREAM should NOT use /audio/ prefix (WebSocket bypasses global prefix)', () => {
      expect(STT_V2_ENDPOINTS.WS_STREAM).toMatch(/^\/ws\//);
      expect(STT_V2_ENDPOINTS.WS_STREAM).not.toMatch(/^\/audio\//);
    });

    it('ROLE_ENDPOINTS.USER_ROLES should stay under /users/ (not /admin/)', () => {
      expect(ROLE_ENDPOINTS.USER_ROLES('u-1')).toMatch(/^\/users\//);
      expect(ROLE_ENDPOINTS.USER_ROLES('u-1')).not.toMatch(/^\/admin\//);
    });

    it('MY_TENANT_ENDPOINTS should use /tenant/me/ prefix (auth-based, not admin)', () => {
      expect(MY_TENANT_ENDPOINTS.INFO).toMatch(/^\/tenant\/me/);
      expect(MY_TENANT_ENDPOINTS.CONFIG).toMatch(/^\/tenant\/me\//);
      expect(MY_TENANT_ENDPOINTS.INFO).not.toMatch(/^\/admin\//);
      expect(MY_TENANT_ENDPOINTS.CONFIG).not.toMatch(/^\/admin\//);
    });
  });
});
