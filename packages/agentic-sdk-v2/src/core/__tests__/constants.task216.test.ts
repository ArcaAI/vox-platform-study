/**
 * Endpoint Constants Tests (updated for consolidated health)
 *
 * SERVICE_HEALTH_ENDPOINTS uses a single consolidated endpoint at /admin/health/services
 * on the API gateway. The gateway fans out health checks to all downstream
 * Python microservices (TTS, SMR, NLP, STT) and returns aggregated results.
 *
 * This replaces the previous per-service proxy approach where the SDK hit
 * 4 separate endpoints (/speech/health, /nlp/health, /text/api/v2/health,
 * /audio/stt/health) -- none of which had corresponding API controllers.
 *
 * @vitest-environment jsdom
 */

import { describe, it, expect } from 'vitest';
import { SERVICE_HEALTH_ENDPOINTS } from '../constants';

describe('SERVICE_HEALTH_ENDPOINTS (consolidated health check)', () => {
  it('should have SERVICES pointing to /admin/health/services (moved by TASK-759)', () => {
    expect(SERVICE_HEALTH_ENDPOINTS.SERVICES).toBe('/admin/health/services');
  });

  it('should have exactly 1 key (consolidated endpoint)', () => {
    expect(Object.keys(SERVICE_HEALTH_ENDPOINTS)).toHaveLength(1);
  });

  it('should NOT have per-service keys (removed broken proxies)', () => {
    expect('TTS' in SERVICE_HEALTH_ENDPOINTS).toBe(false);
    expect('NLP' in SERVICE_HEALTH_ENDPOINTS).toBe(false);
    expect('SMR' in SERVICE_HEALTH_ENDPOINTS).toBe(false);
    expect('STT' in SERVICE_HEALTH_ENDPOINTS).toBe(false);
  });

  it('should start with / and have no trailing slash', () => {
    expect(SERVICE_HEALTH_ENDPOINTS.SERVICES).toMatch(/^\//);
    expect(SERVICE_HEALTH_ENDPOINTS.SERVICES).not.toMatch(/\/$/);
  });
});
