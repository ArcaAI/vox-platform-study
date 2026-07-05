import type { MonitoredService } from './types';

export const monitoringKeys = {
    root: ['monitoring'] as const,
    servicesHealth: () => [...monitoringKeys.root, 'services-health'] as const,
    serviceHealth: (service: MonitoredService) => [...monitoringKeys.root, 'services-health', service] as const,
    uptime: () => [...monitoringKeys.root, 'uptime'] as const,
    serviceUptime: (service: MonitoredService) => [...monitoringKeys.root, 'uptime', service] as const,
    heartbeats: (service: MonitoredService) => [...monitoringKeys.root, 'heartbeats', service] as const,
    sessions: () => [...monitoringKeys.root, 'sessions'] as const,
    redis: () => [...monitoringKeys.root, 'redis'] as const,
};
