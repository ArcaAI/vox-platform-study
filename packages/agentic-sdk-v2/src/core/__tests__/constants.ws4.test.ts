/**
 * @arcaai/vox - WS-4 Endpoint Constants Tests
 *
 * Tests for new endpoint constants added by SDK-207 WS-4.
 * Matches WS-2 (Prompt + DNA) and WS-3 (Department PATCH) backend routes.
 *
 * @vitest-environment jsdom
 */

import { describe, it, expect } from 'vitest';
import {
  CONSULTATION_ENDPOINTS,
  DNA_STYLE_ENDPOINTS,
  PROMPT_TEMPLATE_ENDPOINTS,
  DEPARTMENT_ENDPOINTS,
  SUMMARY_ENDPOINTS,
  HEALTH_ENDPOINTS,
  MONITORING_ENDPOINTS,
  TENANT_ENDPOINTS,
} from '../constants';

// =============================================================================
// DNA_STYLE_ENDPOINTS (replaces deprecated DNA_ENDPOINTS)
// =============================================================================

describe('WS-4 endpoint constants', () => {
  describe('DNA_STYLE_ENDPOINTS', () => {
    it('should have GENERATE endpoint', () => {
      expect(DNA_STYLE_ENDPOINTS.GENERATE).toBe('/dna-writing-styles/generate');
    });

    it('should generate GENERATE_FOR_DOCTOR endpoint', () => {
      expect(DNA_STYLE_ENDPOINTS.GENERATE_FOR_DOCTOR('doc-123')).toBe(
        '/admin/dna-writing-styles/generate/doc-123'
      );
    });

    it('should have MY_STYLE endpoint', () => {
      expect(DNA_STYLE_ENDPOINTS.MY_STYLE).toBe('/dna-writing-styles/my-style');
    });

    it('should generate UPDATE endpoint', () => {
      expect(DNA_STYLE_ENDPOINTS.UPDATE('report-1')).toBe(
        '/dna-writing-styles/report-1'
      );
    });

    it('should generate VERSIONS endpoint', () => {
      expect(DNA_STYLE_ENDPOINTS.VERSIONS('report-1')).toBe(
        '/dna-writing-styles/report-1/versions'
      );
    });

    it('should have ADMIN_LIST endpoint', () => {
      expect(DNA_STYLE_ENDPOINTS.ADMIN_LIST).toBe('/admin/dna-writing-styles');
    });

    it('should generate ADMIN_JOB_STATUS endpoint', () => {
      expect(DNA_STYLE_ENDPOINTS.ADMIN_JOB_STATUS('job-1')).toBe(
        '/admin/dna-writing-styles/jobs/job-1'
      );
    });
  });

  // ===========================================================================
  // PROMPT_TEMPLATE_ENDPOINTS
  // ===========================================================================

  describe('PROMPT_TEMPLATE_ENDPOINTS', () => {
    it('should have CREATE endpoint', () => {
      expect(PROMPT_TEMPLATE_ENDPOINTS.CREATE).toBe('/admin/prompt-templates');
    });

    it('should have LIST endpoint', () => {
      expect(PROMPT_TEMPLATE_ENDPOINTS.LIST).toBe('/admin/prompt-templates');
    });

    it('should generate GET endpoint', () => {
      expect(PROMPT_TEMPLATE_ENDPOINTS.GET('pt-1')).toBe('/admin/prompt-templates/pt-1');
    });

    it('should generate UPDATE endpoint', () => {
      expect(PROMPT_TEMPLATE_ENDPOINTS.UPDATE('pt-1')).toBe('/admin/prompt-templates/pt-1');
    });

    it('should generate DELETE endpoint', () => {
      expect(PROMPT_TEMPLATE_ENDPOINTS.DELETE('pt-1')).toBe('/admin/prompt-templates/pt-1');
    });

    it('should generate VERSIONS endpoint', () => {
      expect(PROMPT_TEMPLATE_ENDPOINTS.VERSIONS('pt-1')).toBe(
        '/admin/prompt-templates/pt-1/versions'
      );
    });

    it('should generate VERSION endpoint for specific version number', () => {
      expect(PROMPT_TEMPLATE_ENDPOINTS.VERSION('pt-1', 3)).toBe(
        '/admin/prompt-templates/pt-1/versions/3'
      );
    });

    it('should have ASSIGN_DEPARTMENT endpoint', () => {
      expect(PROMPT_TEMPLATE_ENDPOINTS.ASSIGN_DEPARTMENT).toBe(
        '/admin/prompt-templates/assign-department'
      );
    });
  });

  // ===========================================================================
  // DEPARTMENT_ENDPOINTS
  // ===========================================================================

  describe('DEPARTMENT_ENDPOINTS', () => {
    it('should have LIST endpoint', () => {
      expect(DEPARTMENT_ENDPOINTS.LIST).toBe('/admin/departments');
    });

    it('should generate GET endpoint', () => {
      expect(DEPARTMENT_ENDPOINTS.GET('dept-1')).toBe('/admin/departments/dept-1');
    });

    it('should generate UPDATE endpoint', () => {
      expect(DEPARTMENT_ENDPOINTS.UPDATE('dept-1')).toBe('/admin/departments/dept-1');
    });
  });

  // ===========================================================================
  // Extended CONSULTATION_ENDPOINTS
  // ===========================================================================

  describe('CONSULTATION_ENDPOINTS extensions', () => {
    it('should generate CHAIN endpoint', () => {
      expect(CONSULTATION_ENDPOINTS.CHAIN('consult-1')).toBe(
        '/consultations/consult-1/chain'
      );
    });
  });

  // ===========================================================================
  // Extended SUMMARY_ENDPOINTS
  // ===========================================================================

  describe('SUMMARY_ENDPOINTS extensions', () => {
    it('should generate VERSIONS endpoint', () => {
      expect(SUMMARY_ENDPOINTS.VERSIONS('consult-1', 'ctx-1')).toBe(
        '/consultations/consult-1/summary/ctx-1/versions'
      );
    });
  });

  // ===========================================================================
  // HEALTH_ENDPOINTS
  // ===========================================================================

  describe('HEALTH_ENDPOINTS', () => {
    it('should have HEALTH endpoint', () => {
      expect(HEALTH_ENDPOINTS.HEALTH).toBe('/health');
    });

    it('should have LIVE endpoint', () => {
      expect(HEALTH_ENDPOINTS.LIVE).toBe('/health/live');
    });

    it('should have READY endpoint', () => {
      expect(HEALTH_ENDPOINTS.READY).toBe('/health/ready');
    });
  });

  // ===========================================================================
  // MONITORING_ENDPOINTS
  // ===========================================================================

  describe('MONITORING_ENDPOINTS', () => {
    it('should have UPTIME endpoint', () => {
      expect(MONITORING_ENDPOINTS.UPTIME).toBe('/monitoring/uptime');
    });

    it('should generate SERVICE_UPTIME endpoint', () => {
      expect(MONITORING_ENDPOINTS.SERVICE_UPTIME('api')).toBe(
        '/monitoring/uptime/api'
      );
    });

    it('should generate HEARTBEATS endpoint', () => {
      expect(MONITORING_ENDPOINTS.HEARTBEATS('stt')).toBe(
        '/monitoring/heartbeats/stt'
      );
    });

    it('should have SESSIONS endpoint', () => {
      expect(MONITORING_ENDPOINTS.SESSIONS).toBe('/monitoring/sessions');
    });
  });

  // ===========================================================================
  // TENANT_ENDPOINTS
  // ===========================================================================

  describe('TENANT_ENDPOINTS', () => {
    it('should generate GET_CONFIGS endpoint', () => {
      expect(TENANT_ENDPOINTS.GET_CONFIGS('tenant-1')).toBe(
        '/admin/tenants/configs/tenant-1'
      );
    });

    it('should generate UPDATE_CONFIGS endpoint', () => {
      expect(TENANT_ENDPOINTS.UPDATE_CONFIGS('tenant-1')).toBe(
        '/admin/tenants/configs/tenant-1'
      );
    });
  });

  // ===========================================================================
  // Edge cases: dynamic endpoint functions with various input types
  // ===========================================================================

  describe('dynamic endpoint edge cases', () => {
    const uuid = '550e8400-e29b-41d4-a716-446655440000';

    it('should handle UUID-style IDs in DNA_STYLE_ENDPOINTS', () => {
      expect(DNA_STYLE_ENDPOINTS.UPDATE(uuid)).toBe(`/dna-writing-styles/${uuid}`);
      expect(DNA_STYLE_ENDPOINTS.VERSIONS(uuid)).toBe(`/dna-writing-styles/${uuid}/versions`);
      expect(DNA_STYLE_ENDPOINTS.GENERATE_FOR_DOCTOR(uuid)).toBe(`/admin/dna-writing-styles/generate/${uuid}`);
      expect(DNA_STYLE_ENDPOINTS.ADMIN_JOB_STATUS(uuid)).toBe(`/admin/dna-writing-styles/jobs/${uuid}`);
    });

    it('should handle UUID-style IDs in PROMPT_TEMPLATE_ENDPOINTS', () => {
      expect(PROMPT_TEMPLATE_ENDPOINTS.GET(uuid)).toBe(`/admin/prompt-templates/${uuid}`);
      expect(PROMPT_TEMPLATE_ENDPOINTS.UPDATE(uuid)).toBe(`/admin/prompt-templates/${uuid}`);
      expect(PROMPT_TEMPLATE_ENDPOINTS.DELETE(uuid)).toBe(`/admin/prompt-templates/${uuid}`);
      expect(PROMPT_TEMPLATE_ENDPOINTS.VERSIONS(uuid)).toBe(`/admin/prompt-templates/${uuid}/versions`);
    });

    it('should handle UUID-style IDs in DEPARTMENT_ENDPOINTS', () => {
      expect(DEPARTMENT_ENDPOINTS.GET(uuid)).toBe(`/admin/departments/${uuid}`);
      expect(DEPARTMENT_ENDPOINTS.UPDATE(uuid)).toBe(`/admin/departments/${uuid}`);
    });

    it('should handle UUID-style IDs in CONSULTATION_ENDPOINTS.CHAIN', () => {
      expect(CONSULTATION_ENDPOINTS.CHAIN(uuid)).toBe(`/consultations/${uuid}/chain`);
    });

    it('should handle UUID-style IDs in SUMMARY_ENDPOINTS.VERSIONS', () => {
      expect(SUMMARY_ENDPOINTS.VERSIONS(uuid, uuid)).toBe(
        `/consultations/${uuid}/summary/${uuid}/versions`
      );
    });

    it('should handle empty string inputs without throwing', () => {
      expect(DNA_STYLE_ENDPOINTS.UPDATE('')).toBe('/dna-writing-styles/');
      expect(PROMPT_TEMPLATE_ENDPOINTS.GET('')).toBe('/admin/prompt-templates/');
      expect(DEPARTMENT_ENDPOINTS.GET('')).toBe('/admin/departments/');
      expect(CONSULTATION_ENDPOINTS.CHAIN('')).toBe('/consultations//chain');
      expect(MONITORING_ENDPOINTS.SERVICE_UPTIME('')).toBe('/monitoring/uptime/');
      expect(MONITORING_ENDPOINTS.HEARTBEATS('')).toBe('/monitoring/heartbeats/');
      expect(TENANT_ENDPOINTS.GET_CONFIGS('')).toBe('/admin/tenants/configs/');
      expect(TENANT_ENDPOINTS.UPDATE_CONFIGS('')).toBe('/admin/tenants/configs/');
    });

    it('should handle IDs with special characters', () => {
      const specialId = 'id-with-special_chars.v2';
      expect(DNA_STYLE_ENDPOINTS.UPDATE(specialId)).toBe(`/dna-writing-styles/${specialId}`);
      expect(PROMPT_TEMPLATE_ENDPOINTS.GET(specialId)).toBe(`/admin/prompt-templates/${specialId}`);
      expect(MONITORING_ENDPOINTS.SERVICE_UPTIME('stt-v2')).toBe('/monitoring/uptime/stt-v2');
    });

    it('should handle very long IDs', () => {
      const longId = 'a'.repeat(200);
      expect(DEPARTMENT_ENDPOINTS.GET(longId)).toBe(`/admin/departments/${longId}`);

      expect(TENANT_ENDPOINTS.GET_CONFIGS(longId)).toBe(`/admin/tenants/configs/${longId}`);
    });
  });

  // ===========================================================================
  // Structural completeness: verify all expected keys exist
  // ===========================================================================

  describe('structural completeness', () => {
    it('DNA_STYLE_ENDPOINTS should have exactly 16 keys', () => {
      // TASK-329 P5 added MINE + SET_DEFAULT (12 -> 14) for the playground.
      // TASK-388 #13 added ADMIN_BY_DOCTOR + ADMIN_VERSIONS (14 -> 16) for admin cross-user PHI reads.
      const keys = Object.keys(DNA_STYLE_ENDPOINTS);
      expect(keys).toHaveLength(16);
      expect(keys).toEqual(expect.arrayContaining([
        'GENERATE', 'GENERATE_FOR_DOCTOR', 'JOB_STATUS', 'JOB_STREAM', 'MY_STYLE', 'MINE', 'UPDATE',
        'SET_DEFAULT', 'VERSIONS', 'ADMIN_LIST', 'ADMIN_JOB_STATUS', 'ADMIN_JOB_STREAM', 'ADMIN_DASHBOARD', 'BY_DOCTOR',
      ]));
    });

    it('PROMPT_TEMPLATE_ENDPOINTS should have exactly 15 keys', () => {
      const keys = Object.keys(PROMPT_TEMPLATE_ENDPOINTS);
      // TASK-328 A4 added TEST + USAGE_ANALYTICS (10 -> 12).
      // TASK-331 doc-09 added AVAILABLE — the end-user (clinician) plane (12 -> 13).
      // TASK-389 #14 (AG8/A3) added DIFF — the server-side version-diff route (13 -> 14).
      // TASK-407 added USAGE_RECORDS — tenant-wide agent-run history (14 -> 15).
      expect(keys).toHaveLength(15);
      expect(keys).toEqual(expect.arrayContaining([
        'CREATE', 'LIST', 'AVAILABLE', 'GET', 'UPDATE', 'DELETE', 'VERSIONS', 'VERSION',
        'ASSIGN_DEPARTMENT', 'USAGE', 'ACTIVATE_VERSION', 'TEST', 'USAGE_ANALYTICS', 'DIFF',
        'USAGE_RECORDS',
      ]));
    });

    it('should generate TEST endpoint (TASK-328 A4)', () => {
      expect(PROMPT_TEMPLATE_ENDPOINTS.TEST('pt-1')).toBe('/admin/prompt-templates/pt-1/test');
    });

    it('should have USAGE_ANALYTICS endpoint (TASK-328 A4)', () => {
      expect(PROMPT_TEMPLATE_ENDPOINTS.USAGE_ANALYTICS).toBe('/admin/prompt-templates/analytics/usage');
    });

    it('DEPARTMENT_ENDPOINTS should have exactly 10 keys', () => {
      // TASK-387 (#6 / D2) added USERS (9 -> 10) for the reverse dept->users listing.
      const keys = Object.keys(DEPARTMENT_ENDPOINTS);
      expect(keys).toHaveLength(10);
      expect(keys).toEqual(expect.arrayContaining([
        'LIST', 'GET', 'CREATE', 'UPDATE', 'DELETE', 'ROOTS', 'CHILDREN', 'BY_CODE', 'PROMPT_CONFIG',
      ]));
    });

    it('HEALTH_ENDPOINTS should have exactly 3 keys', () => {
      const keys = Object.keys(HEALTH_ENDPOINTS);
      expect(keys).toHaveLength(3);
      expect(keys).toEqual(expect.arrayContaining(['HEALTH', 'LIVE', 'READY']));
    });

    it('MONITORING_ENDPOINTS should have exactly 4 keys', () => {
      const keys = Object.keys(MONITORING_ENDPOINTS);
      expect(keys).toHaveLength(4);
      expect(keys).toEqual(expect.arrayContaining([
        'UPTIME', 'SERVICE_UPTIME', 'HEARTBEATS', 'SESSIONS',
      ]));
    });

    // TASK-386 (E5) added USAGE (8 -> 9).
    // TASK-387 (#1 / F6) added SUSPEND + ARCHIVE + RESTORE and (#2 / F9) added TAGS (9 -> 13).
    it('TENANT_ENDPOINTS should have exactly 13 keys', () => {
      const keys = Object.keys(TENANT_ENDPOINTS);
      expect(keys).toHaveLength(13);
      expect(keys).toEqual(expect.arrayContaining([
        'LIST', 'GET', 'GET_BY_CODE_NAME', 'CREATE', 'UPDATE', 'DELETE',
        'GET_CONFIGS', 'UPDATE_CONFIGS', 'USAGE',
      ]));
    });

    it('should use /admin/tenants/:id/usage for USAGE (TASK-386 E5)', () => {
      expect(TENANT_ENDPOINTS.USAGE('tenant-1')).toBe('/admin/tenants/tenant-1/usage');
    });

    it('static endpoints should be strings', () => {
      expect(typeof DNA_STYLE_ENDPOINTS.GENERATE).toBe('string');
      expect(typeof DNA_STYLE_ENDPOINTS.MY_STYLE).toBe('string');
      expect(typeof DNA_STYLE_ENDPOINTS.ADMIN_LIST).toBe('string');
      expect(typeof PROMPT_TEMPLATE_ENDPOINTS.CREATE).toBe('string');
      expect(typeof PROMPT_TEMPLATE_ENDPOINTS.LIST).toBe('string');
      expect(typeof PROMPT_TEMPLATE_ENDPOINTS.ASSIGN_DEPARTMENT).toBe('string');
      expect(typeof DEPARTMENT_ENDPOINTS.LIST).toBe('string');
      expect(typeof HEALTH_ENDPOINTS.HEALTH).toBe('string');
      expect(typeof HEALTH_ENDPOINTS.LIVE).toBe('string');
      expect(typeof HEALTH_ENDPOINTS.READY).toBe('string');
      expect(typeof MONITORING_ENDPOINTS.UPTIME).toBe('string');
      expect(typeof MONITORING_ENDPOINTS.SESSIONS).toBe('string');
    });

    it('dynamic endpoints should be functions', () => {
      expect(typeof DNA_STYLE_ENDPOINTS.GENERATE_FOR_DOCTOR).toBe('function');
      expect(typeof DNA_STYLE_ENDPOINTS.UPDATE).toBe('function');
      expect(typeof DNA_STYLE_ENDPOINTS.VERSIONS).toBe('function');
      expect(typeof DNA_STYLE_ENDPOINTS.ADMIN_JOB_STATUS).toBe('function');
      expect(typeof PROMPT_TEMPLATE_ENDPOINTS.GET).toBe('function');
      expect(typeof PROMPT_TEMPLATE_ENDPOINTS.UPDATE).toBe('function');
      expect(typeof PROMPT_TEMPLATE_ENDPOINTS.DELETE).toBe('function');
      expect(typeof PROMPT_TEMPLATE_ENDPOINTS.VERSIONS).toBe('function');
      expect(typeof PROMPT_TEMPLATE_ENDPOINTS.VERSION).toBe('function');
      expect(typeof DEPARTMENT_ENDPOINTS.GET).toBe('function');
      expect(typeof DEPARTMENT_ENDPOINTS.UPDATE).toBe('function');
      expect(typeof CONSULTATION_ENDPOINTS.CHAIN).toBe('function');
      expect(typeof SUMMARY_ENDPOINTS.VERSIONS).toBe('function');
      expect(typeof MONITORING_ENDPOINTS.SERVICE_UPTIME).toBe('function');
      expect(typeof MONITORING_ENDPOINTS.HEARTBEATS).toBe('function');
      expect(typeof TENANT_ENDPOINTS.GET_CONFIGS).toBe('function');
      expect(typeof TENANT_ENDPOINTS.UPDATE_CONFIGS).toBe('function');
    });

    it('all static endpoints should start with /', () => {
      const staticEndpoints = [
        DNA_STYLE_ENDPOINTS.GENERATE,
        DNA_STYLE_ENDPOINTS.MY_STYLE,
        DNA_STYLE_ENDPOINTS.ADMIN_LIST,
        PROMPT_TEMPLATE_ENDPOINTS.CREATE,
        PROMPT_TEMPLATE_ENDPOINTS.LIST,
        PROMPT_TEMPLATE_ENDPOINTS.ASSIGN_DEPARTMENT,
        DEPARTMENT_ENDPOINTS.LIST,
        HEALTH_ENDPOINTS.HEALTH,
        HEALTH_ENDPOINTS.LIVE,
        HEALTH_ENDPOINTS.READY,
        MONITORING_ENDPOINTS.UPTIME,
        MONITORING_ENDPOINTS.SESSIONS,
      ];
      staticEndpoints.forEach(endpoint => {
        expect(endpoint).toMatch(/^\//);
      });
    });

    it('all dynamic endpoints should return paths starting with /', () => {
      const dynamicResults = [
        DNA_STYLE_ENDPOINTS.GENERATE_FOR_DOCTOR('x'),
        DNA_STYLE_ENDPOINTS.UPDATE('x'),
        DNA_STYLE_ENDPOINTS.VERSIONS('x'),
        DNA_STYLE_ENDPOINTS.ADMIN_JOB_STATUS('x'),
        PROMPT_TEMPLATE_ENDPOINTS.GET('x'),
        PROMPT_TEMPLATE_ENDPOINTS.UPDATE('x'),
        PROMPT_TEMPLATE_ENDPOINTS.DELETE('x'),
        PROMPT_TEMPLATE_ENDPOINTS.VERSIONS('x'),
        DEPARTMENT_ENDPOINTS.GET('x'),
        DEPARTMENT_ENDPOINTS.UPDATE('x'),
        CONSULTATION_ENDPOINTS.CHAIN('x'),
        SUMMARY_ENDPOINTS.VERSIONS('x', 'y'),
        MONITORING_ENDPOINTS.SERVICE_UPTIME('x'),
        MONITORING_ENDPOINTS.HEARTBEATS('x'),
        TENANT_ENDPOINTS.GET_CONFIGS('x'),
        TENANT_ENDPOINTS.UPDATE_CONFIGS('x'),
      ];
      dynamicResults.forEach(path => {
        expect(path).toMatch(/^\//);
      });
    });
  });
});
