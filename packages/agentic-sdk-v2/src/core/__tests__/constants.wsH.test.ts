/**
 * Constants Tests — Workstream H additions
 *
 * Tests for new endpoint constants added in WS-H.
 *
 * `DNA_STYLE_ENDPOINTS` was removed under TASK-890 (OD-F/OD-K) along with
 * its sole consumers, the admin `useDnaStyle`/`useDnaDashboard` hooks —
 * `@arcaai/vox` carries no management surface.
 *
 * @vitest-environment jsdom
 */

import { describe, it, expect } from 'vitest';
import { CONSULTATION_ENDPOINTS } from '../constants';

describe('WS-H Constants', () => {
  describe('CONSULTATION_ENDPOINTS.LIST', () => {
    it('should be defined as a string', () => {
      expect(CONSULTATION_ENDPOINTS.LIST).toBeDefined();
      expect(typeof CONSULTATION_ENDPOINTS.LIST).toBe('string');
    });

    it('should point to /consultations', () => {
      expect(CONSULTATION_ENDPOINTS.LIST).toBe('/consultations');
    });
  });

  describe('CONSULTATION_ENDPOINTS completeness', () => {
    it('should have all expected keys including LIST', () => {
      const keys = Object.keys(CONSULTATION_ENDPOINTS);
      expect(keys).toEqual(expect.arrayContaining(['OPEN', 'GET', 'PATIENT_HISTORY', 'PATIENT_DATE', 'TIMELINE', 'CHAIN', 'LIST']));
    });
  });
});
