import { describe, expect, it } from 'vitest';
import { SERVICE_ORDER, buildServiceRows, healthStateToRole } from '../service-table';

describe('platform service-table (health + uptime → Services rows)', () => {
  describe('healthStateToRole', () => {
    it('maps each normalized state to its semantic role', () => {
      expect(healthStateToRole('healthy')).toBe('success');
      expect(healthStateToRole('degraded')).toBe('warning');
      expect(healthStateToRole('unhealthy')).toBe('destructive');
      expect(healthStateToRole('checking')).toBe('info');
      expect(healthStateToRole('unknown')).toBe('neutral');
    });
  });

  describe('buildServiceRows', () => {
    const services = {
      api: { status: 'healthy', uptime_seconds: 100 },
      apiLive: { status: 'healthy' },
      stt: { status: 'up' },
      smr: { status: 'degraded' },
      nlp: { status: 'healthy' },
      guardrail: { status: 'healthy' },
      harness: { status: 'healthy' },
    };

    it('returns the 6 canonical services in display order (no apiLive row)', () => {
      const rows = buildServiceRows(services);
      expect(rows.map((r) => r.key)).toEqual([...SERVICE_ORDER]);
      expect(rows.map((r) => r.name)).toEqual(['API', 'STT', 'SMR', 'NLP', 'Guardrail', 'Harness']);
    });

    it('normalizes status and resolves the matching role (SMR degraded)', () => {
      const rows = buildServiceRows(services);
      const stt = rows.find((r) => r.key === 'stt');
      const smr = rows.find((r) => r.key === 'smr');
      expect(stt).toMatchObject({ status: 'healthy', role: 'success' });
      expect(smr).toMatchObject({ status: 'degraded', role: 'warning' });
    });

    it('joins uptime, preferring monitoring uptimeSeconds over health uptime_seconds', () => {
      const rows = buildServiceRows(services, [{ service: 'API', uptimeSeconds: 5000 }]);
      expect(rows.find((r) => r.key === 'api')?.uptimeSeconds).toBe(5000);
      // No monitoring entry for STT → falls back to (absent) health uptime_seconds.
      expect(rows.find((r) => r.key === 'stt')?.uptimeSeconds).toBeUndefined();
    });

    it('falls back to the health uptime_seconds when monitoring has no entry', () => {
      const rows = buildServiceRows(services);
      expect(rows.find((r) => r.key === 'api')?.uptimeSeconds).toBe(100);
    });

    it('marks services absent from the health map as unknown/neutral with no uptime', () => {
      const rows = buildServiceRows({});
      expect(rows).toHaveLength(SERVICE_ORDER.length);
      expect(rows.every((r) => r.status === 'unknown' && r.role === 'neutral')).toBe(true);
      expect(rows.every((r) => r.uptimeSeconds === undefined)).toBe(true);
    });

    it('tolerates a null/undefined services map', () => {
      expect(buildServiceRows(null)).toHaveLength(SERVICE_ORDER.length);
      expect(buildServiceRows(undefined)).toHaveLength(SERVICE_ORDER.length);
    });

    // TASK-404 — version passthrough for the ServiceStatusBar/table.
    it('passes the health-map version through to the row', () => {
      const rows = buildServiceRows({ api: { status: 'healthy', version: '2.1.0' } });
      expect(rows.find((r) => r.key === 'api')?.version).toBe('2.1.0');
    });

    it('leaves version undefined when the health map has none', () => {
      const rows = buildServiceRows(services);
      expect(rows.find((r) => r.key === 'api')?.version).toBeUndefined();
    });
  });
});
