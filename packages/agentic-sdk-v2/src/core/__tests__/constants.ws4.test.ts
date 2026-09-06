/**
 * @arcaai/vox - WS-4 Endpoint Constants Tests
 *
 * Tests for new endpoint constants added by SDK-207 WS-4.
 * Matches WS-2 (Prompt + DNA) and WS-3 (Department PATCH) backend routes.
 *
 * `DNA_STYLE_ENDPOINTS`, `PROMPT_TEMPLATE_ENDPOINTS`, the admin CRUD surface
 * of `DEPARTMENT_ENDPOINTS`, `MONITORING_ENDPOINTS` and `TENANT_ENDPOINTS`
 * were removed under TASK-890 (OD-F/OD-K) along with their sole consumers,
 * the admin `useDnaStyle`/`useDnaDashboard`/`usePrompts`/`useDepartments`/
 * `useMonitoring`/`useTenants` hooks — `@arcaai/vox` carries no management
 * surface.
 *
 * @vitest-environment jsdom
 */

import { describe, it, expect } from 'vitest';
import { CONSULTATION_ENDPOINTS, SUMMARY_ENDPOINTS, HEALTH_ENDPOINTS } from '../constants';

// =============================================================================
// Extended CONSULTATION_ENDPOINTS / SUMMARY_ENDPOINTS / HEALTH_ENDPOINTS
// =============================================================================

describe('WS-4 endpoint constants', () => {
  describe('CONSULTATION_ENDPOINTS extensions', () => {
    it('should generate CHAIN endpoint', () => {
      expect(CONSULTATION_ENDPOINTS.CHAIN('consult-1')).toBe('/consultations/consult-1/chain');
    });
  });

  describe('SUMMARY_ENDPOINTS extensions', () => {
    it('should generate VERSIONS endpoint', () => {
      expect(SUMMARY_ENDPOINTS.VERSIONS('consult-1', 'ctx-1')).toBe('/consultations/consult-1/summary/ctx-1/versions');
    });
  });

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
  // Edge cases: dynamic endpoint functions with various input types
  // ===========================================================================

  describe('dynamic endpoint edge cases', () => {
    const uuid = '550e8400-e29b-41d4-a716-446655440000';

    it('should handle UUID-style IDs in CONSULTATION_ENDPOINTS.CHAIN', () => {
      expect(CONSULTATION_ENDPOINTS.CHAIN(uuid)).toBe(`/consultations/${uuid}/chain`);
    });

    it('should handle UUID-style IDs in SUMMARY_ENDPOINTS.VERSIONS', () => {
      expect(SUMMARY_ENDPOINTS.VERSIONS(uuid, uuid)).toBe(`/consultations/${uuid}/summary/${uuid}/versions`);
    });

    it('should handle empty string inputs without throwing', () => {
      expect(CONSULTATION_ENDPOINTS.CHAIN('')).toBe('/consultations//chain');
    });
  });

  // ===========================================================================
  // Structural completeness: verify all expected keys exist
  // ===========================================================================

  describe('structural completeness', () => {
    it('HEALTH_ENDPOINTS should have exactly 3 keys', () => {
      const keys = Object.keys(HEALTH_ENDPOINTS);
      expect(keys).toHaveLength(3);
      expect(keys).toEqual(expect.arrayContaining(['HEALTH', 'LIVE', 'READY']));
    });

    it('static endpoints should be strings', () => {
      expect(typeof HEALTH_ENDPOINTS.HEALTH).toBe('string');
      expect(typeof HEALTH_ENDPOINTS.LIVE).toBe('string');
      expect(typeof HEALTH_ENDPOINTS.READY).toBe('string');
    });

    it('dynamic endpoints should be functions', () => {
      expect(typeof CONSULTATION_ENDPOINTS.CHAIN).toBe('function');
      expect(typeof SUMMARY_ENDPOINTS.VERSIONS).toBe('function');
    });

    it('all static endpoints should start with /', () => {
      const staticEndpoints = [HEALTH_ENDPOINTS.HEALTH, HEALTH_ENDPOINTS.LIVE, HEALTH_ENDPOINTS.READY];
      staticEndpoints.forEach((endpoint) => {
        expect(endpoint).toMatch(/^\//);
      });
    });

    it('all dynamic endpoints should return paths starting with /', () => {
      const dynamicResults = [CONSULTATION_ENDPOINTS.CHAIN('x'), SUMMARY_ENDPOINTS.VERSIONS('x', 'y')];
      dynamicResults.forEach((path) => {
        expect(path).toMatch(/^\//);
      });
    });
  });
});
