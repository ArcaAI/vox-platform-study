import { Inject, Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import Redis from 'ioredis';
import { IConfigService } from '../_meta/config';
import { IServiceHealthMonitoringService } from './IServiceHealthMonitoringService';
import { HeartbeatRecord, ServiceStatus, ServiceUptime, SessionsResponse, UptimeResponse } from './dto';

interface ServiceConfig {
  name: string;
  url: string;
  healthEndpoint: string;
}

const HEARTBEAT_HISTORY_SIZE = 90;
const HEARTBEAT_TTL_SECONDS = 86400;
const REDIS_KEY_PREFIX = 'monitoring:heartbeat:';

@Injectable()
export class ServiceHealthMonitoringService implements IServiceHealthMonitoringService, OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(ServiceHealthMonitoringService.name);
  private redis: Redis | null = null;
  private services: ServiceConfig[] = [];

  constructor(@Inject(IConfigService) private readonly configService: IConfigService) {
    this.logger.log({ message: 'Service initialized' });
  }

  async onModuleInit(): Promise<void> {
    await this.initializeRedis();
    this.initializeServices();
    await this.performHealthChecks();
  }

  async onModuleDestroy(): Promise<void> {
    if (this.redis) {
      await this.redis.quit();
      this.redis = null;
    }
  }

  private async initializeRedis(): Promise<void> {
    try {
      const redisConfig = this.configService.getRedisConfig();
      this.redis = new Redis({
        host: redisConfig.host,
        port: redisConfig.port,
        password: redisConfig.password,
        lazyConnect: true,
        retryStrategy: (times) => Math.min(times * 100, 3000),
      });

      await this.redis.connect();
      this.logger.log({
        message: 'Redis connected for health monitoring',
        host: redisConfig.host,
        port: redisConfig.port,
      });
    } catch (error) {
      this.logger.warn({
        message: 'Redis connection failed for health monitoring',
        error: error instanceof Error ? error.message : 'Unknown error',
      });
      this.redis = null;
    }
  }

  private initializeServices(): void {
    this.services = [
      {
        name: 'Text to Speech',
        // eslint-disable-next-line turbo/no-undeclared-env-vars
        url: process.env.TTS_URL || 'http://localhost:8863',
        healthEndpoint: '/api/v1/health',
      },
      {
        name: 'Summarization',
        // eslint-disable-next-line turbo/no-undeclared-env-vars
        url: process.env.SMR_SERVICE_URL || process.env.SMR_URL || 'http://localhost:8862',
        healthEndpoint: '/api/v1/health',
      },
      {
        name: 'Medical NLP',
        url: process.env.NLP_URL || 'http://localhost:8864',
        healthEndpoint: '/api/v1/health',
      },
      {
        name: 'Speech to Text',
        url: process.env.STT_V2_URL || 'http://localhost:8861',
        healthEndpoint: '/api/v1/health',
      },
    ];

    this.logger.log({
      message: 'Services configured for health monitoring',
      count: this.services.length,
      services: this.services.map((s) => s.name),
    });
  }

  /**
   * Scheduled health check - runs every 30 seconds
   */
  @Cron(CronExpression.EVERY_30_SECONDS)
  async performHealthChecks(): Promise<void> {
    this.logger.debug({
      message: 'Health checks started',
      serviceCount: this.services.length,
    });

    const checkPromises = this.services.map((service) => this.checkServiceHealth(service));
    await Promise.allSettled(checkPromises);
  }

  private async checkServiceHealth(service: ServiceConfig): Promise<void> {
    const startTime = Date.now();
    let status: 'up' | 'down' = 'down';
    let responseTime = 0;

    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 5000);

      const response = await fetch(`${service.url}${service.healthEndpoint}`, {
        method: 'GET',
        signal: controller.signal,
      });

      clearTimeout(timeoutId);
      responseTime = Date.now() - startTime;
      status = response.ok ? 'up' : 'down';

      this.logger.debug({
        message: 'Health check completed',
        service: service.name,
        status,
        responseTimeMs: responseTime,
      });
    } catch (error) {
      responseTime = Date.now() - startTime;
      this.logger.debug({
        message: 'Health check failed',
        service: service.name,
        status: 'down',
        responseTimeMs: responseTime,
        error: error instanceof Error ? error.message : 'timeout',
      });
    }

    await this.storeHeartbeat(service.name, { status, responseTime });
  }

  private async storeHeartbeat(serviceName: string, data: { status: 'up' | 'down'; responseTime: number }): Promise<void> {
    if (!this.redis) {
      this.logger.warn({
        message: 'Heartbeat storage skipped',
        reason: 'redis_unavailable',
        service: serviceName,
      });
      return;
    }

    const key = `${REDIS_KEY_PREFIX}${serviceName}`;
    const heartbeat: HeartbeatRecord = {
      timestamp: new Date().toISOString(),
      status: data.status,
      responseTime: data.responseTime,
    };

    try {
      await this.redis.lpush(key, JSON.stringify(heartbeat));
      await this.redis.ltrim(key, 0, HEARTBEAT_HISTORY_SIZE - 1);
      await this.redis.expire(key, HEARTBEAT_TTL_SECONDS);
    } catch (error) {
      this.logger.error({
        message: 'Heartbeat storage failed',
        service: serviceName,
        error: error instanceof Error ? error.message : 'Unknown',
      });
    }
  }

  private async getHeartbeats(serviceName: string): Promise<HeartbeatRecord[]> {
    if (!this.redis) {
      return [];
    }

    try {
      const key = `${REDIS_KEY_PREFIX}${serviceName}`;
      const data = await this.redis.lrange(key, 0, HEARTBEAT_HISTORY_SIZE - 1);
      return data.map((item) => JSON.parse(item) as HeartbeatRecord);
    } catch (error) {
      this.logger.error({
        message: 'Heartbeat retrieval failed',
        service: serviceName,
        error: error instanceof Error ? error.message : 'Unknown',
      });
      return [];
    }
  }

  private calculateUptime(heartbeats: HeartbeatRecord[]): number {
    if (heartbeats.length === 0) return 0;
    const upCount = heartbeats.filter((h) => h.status === 'up').length;
    return Math.round((upCount / heartbeats.length) * 100 * 100) / 100;
  }

  private determineStatus(heartbeats: HeartbeatRecord[]): ServiceStatus {
    if (heartbeats.length === 0) return 'unknown';

    const recent = heartbeats.slice(0, 3);
    const upCount = recent.filter((h) => h.status === 'up').length;

    if (upCount === recent.length) return 'healthy';
    if (upCount === 0) return 'down';
    return 'degraded';
  }

  async getUptime(): Promise<UptimeResponse> {
    const services: Record<string, ServiceUptime> = {};

    for (const service of this.services) {
      const heartbeats = await this.getHeartbeats(service.name);
      const latestHeartbeat = heartbeats[0];

      services[service.name] = {
        status: this.determineStatus(heartbeats),
        uptime: this.calculateUptime(heartbeats),
        responseTime: latestHeartbeat?.responseTime ?? 0,
        lastCheck: latestHeartbeat?.timestamp ?? new Date().toISOString(),
        heartbeats: heartbeats,
      };
    }

    return {
      services,
      refreshedAt: new Date().toISOString(),
    };
  }

  async getServiceUptime(serviceName: string): Promise<ServiceUptime | null> {
    const service = this.services.find((s) => s.name === serviceName);
    if (!service) return null;

    const heartbeats = await this.getHeartbeats(serviceName);
    const latestHeartbeat = heartbeats[0];

    return {
      status: this.determineStatus(heartbeats),
      uptime: this.calculateUptime(heartbeats),
      responseTime: latestHeartbeat?.responseTime ?? 0,
      lastCheck: latestHeartbeat?.timestamp ?? new Date().toISOString(),
      heartbeats: heartbeats,
    };
  }

  async getHeartbeatHistory(serviceName: string): Promise<HeartbeatRecord[]> {
    return this.getHeartbeats(serviceName);
  }

  async getSessionCounts(): Promise<SessionsResponse> {
    // OB-13: cover all four downstream services so sessions stays aligned with
    // uptime/health. Counts are static placeholders — no per-service polling.
    return {
      services: {
        tts: { active: 0 },
        smr: { active: 0 },
        stt: { active: 0 },
        nlp: { active: 0 },
      },
      totalUsers: 0,
      refreshedAt: new Date().toISOString(),
    };
  }
}
