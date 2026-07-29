/** Service health + uptime reads (capabilities-matrix row 2). */

import { getJson } from '@/shared/api';
import type {
  HealthServices,
  HeartbeatRecord,
  MonitoredService,
  RedisHealthInfo,
  ServiceProbe,
  ServiceUptime,
  SessionsOverview,
  UptimeOverview,
} from './types';

export function getServicesHealth(): Promise<HealthServices> {
  return getJson('health/services');
}

export function getServiceHealth(service: MonitoredService): Promise<ServiceProbe & { timestamp: string }> {
  return getJson(`health/services/${service}`);
}

export function getUptime(): Promise<UptimeOverview> {
  return getJson('monitoring/uptime');
}

export function getServiceUptime(service: MonitoredService): Promise<ServiceUptime> {
  return getJson(`monitoring/uptime/${service}`);
}

export function listHeartbeats(service: MonitoredService): Promise<HeartbeatRecord[]> {
  return getJson(`monitoring/heartbeats/${service}`);
}

export function getSessions(): Promise<SessionsOverview> {
  return getJson('monitoring/sessions');
}

export function getRedisHealth(): Promise<RedisHealthInfo> {
  return getJson('admin/queues/health/redis');
}
