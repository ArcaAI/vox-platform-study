/**
 * TASK-759 — `MonitoringController` route-taxonomy pin (P2).
 *
 * The controller requires `manage:all | read:TenantTelemetry` — an
 * administrative capability — so under rule P2 it MUST carry the `admin`
 * prefix. This suite pins the prefix AND every gate that moves with it: the
 * move is a re-filing, not a re-authorization. In particular the `@CanAny`
 * must stay `OR`-mode so a TENANT_ADMIN holding `read:TenantTelemetry` keeps
 * reaching it (asserted end-to-end in `tenant-dashboard-sources.spec.ts`).
 *
 * Metadata only — no instantiation, so this suite never touches the
 * `@arcaai/applications` runtime graph.
 *
 * @vitest-environment node
 */

import { PATH_METADATA } from '@nestjs/common/constants';
import { describe, expect, it } from 'vitest';

import { MonitoringController } from '../monitoring.controller';

const REQUIRED_PERMISSIONS_KEY = 'required_permissions';
const PERMISSION_MODE_KEY = 'permission_mode';
const API_KEY_FORBIDDEN = 'apiKeyForbidden';
const THROTTLER_LIMIT = 'THROTTLER:LIMIT';
const THROTTLER_TTL = 'THROTTLER:TTL';

describe('MonitoringController route taxonomy (TASK-759)', () => {
  it('is mounted on the admin plane at `admin/monitoring`', () => {
    expect(Reflect.getMetadata(PATH_METADATA, MonitoringController)).toBe('admin/monitoring');
  });

  it('keeps the CanAny(manage:all | read:TenantTelemetry) gate unchanged by the move', () => {
    expect(Reflect.getMetadata(REQUIRED_PERMISSIONS_KEY, MonitoringController)).toEqual([
      { action: 'manage', subject: 'all' },
      { action: 'read', subject: 'TenantTelemetry' },
    ]);
    // OR, not AND: narrowing this to SUPER_ADMIN is the regression the move
    // could plausibly introduce.
    expect(Reflect.getMetadata(PERMISSION_MODE_KEY, MonitoringController)).toBe('OR');
  });

  it('keeps @ForbidApiKey() — already the A2 posture the admin plane requires', () => {
    expect(Reflect.getMetadata(API_KEY_FORBIDDEN, MonitoringController)).toBe(true);
  });

  it('keeps its own 300/60s throttle (not the health-probe cap)', () => {
    expect(Reflect.getMetadata(THROTTLER_LIMIT + 'default', MonitoringController)).toBe(300);
    expect(Reflect.getMetadata(THROTTLER_TTL + 'default', MonitoringController)).toBe(60000);
  });

  it('keeps all four handler sub-paths', () => {
    const p = (m: keyof MonitoringController) => Reflect.getMetadata(PATH_METADATA, MonitoringController.prototype[m]);
    expect(p('getUptime')).toBe('uptime');
    expect(p('getServiceUptime')).toBe('uptime/:service');
    expect(p('getHeartbeats')).toBe('heartbeats/:service');
    expect(p('getSessions')).toBe('sessions');
  });
});
