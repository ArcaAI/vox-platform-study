import { Inject, Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import Redis from 'ioredis';
import { IConfigService } from '../_meta/config';
import { IServiceHealthMonitoringService } from './IServiceHealthMonitoringService';
import { HeartbeatRecord, ServiceStatus, ServiceUptime, SessionsResponse, UptimeResponse } from './dto';

interface ServiceConfig {
  key: string;
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
    // Mirrors the gateway health controller's downstream set
    // (apps/api/.../health/health.controller.ts): the real services are
    // SMR (8862), NLP (8864), STT v2 (8861), TTS (8865), Guardrail (8863)
    // and the Clinical Documentation Harness (8866). Guardrail mounts its
    // health router under `/api` (not `/api/v1`), same as the health controller.
    this.services = [
      {
        key: 'smr',
        name: 'Summarization',
        url: process.env.SMR_SERVICE_URL || process.env.SMR_URL || 'http://localhost:8862',
        healthEndpoint: '/api/v1/health',
      },
      {
        key: 'nlp',
        name: 'Medical NLP',
        url: process.env.NLP_URL || 'http://localhost:8864',
        healthEndpoint: '/api/v1/health',
      },
      {
        key: 'stt',
        name: 'Speech to Text',
        url: process.env.STT_V2_URL || 'http://localhost:8861',
        healthEndpoint: '/api/v1/health',
      },
      {
        key: 'tts',
        name: 'Text to Speech',
        url: process.env.TTS_URL || 'http://localhost:8865',
        healthEndpoint: '/api/v1/health',
      },
      {
        key: 'guardrail',
        name: 'Guardrail',
        url: process.env.GUARDRAIL_URL || 'http://localhost:8863',
        healthEndpoint: '/api/health',
      },
      {
        key: 'harness',
        name: 'Clinical Documentation Harness',
        url: process.env.HARNESS_URL || 'http://localhost:8866',
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

    await this.storeHeartbeat(service.key, { status, responseTime });
  }

  private async storeHeartbeat(serviceKey: string, data: { status: 'up' | 'down'; responseTime: number }): Promise<void> {
    if (!this.redis) {
      this.logger.warn({
        message: 'Heartbeat storage skipped',
        reason: 'redis_unavailable',
        service: serviceKey,
      });
      return;
    }

    const key = `${REDIS_KEY_PREFIX}${serviceKey}`;
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
        service: serviceKey,
        error: error instanceof Error ? error.message : 'Unknown',
      });
    }
  }

  private async getHeartbeats(serviceKey: string): Promise<HeartbeatRecord[]> {
    if (!this.redis) {
      return [];
    }

    try {
      const key = `${REDIS_KEY_PREFIX}${serviceKey}`;
      const data = await this.redis.lrange(key, 0, HEARTBEAT_HISTORY_SIZE - 1);
      return data.map((item) => JSON.parse(item) as HeartbeatRecord);
    } catch (error) {
      this.logger.error({
        message: 'Heartbeat retrieval failed',
        service: serviceKey,
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
      const heartbeats = await this.getHeartbeats(service.key);
      const latestHeartbeat = heartbeats[0];

      services[service.key] = {
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

  async getServiceUptime(serviceKey: string): Promise<ServiceUptime | null> {
    const service = this.services.find((s) => s.key === serviceKey);
    if (!service) return null;

    const heartbeats = await this.getHeartbeats(serviceKey);
    const latestHeartbeat = heartbeats[0];

    return {
      status: this.determineStatus(heartbeats),
      uptime: this.calculateUptime(heartbeats),
      responseTime: latestHeartbeat?.responseTime ?? 0,
      lastCheck: latestHeartbeat?.timestamp ?? new Date().toISOString(),
      heartbeats: heartbeats,
    };
  }

  async getHeartbeatHistory(serviceKey: string): Promise<HeartbeatRecord[]> {
    return this.getHeartbeats(serviceKey);
  }

  async getSessionCounts(): Promise<SessionsResponse> {
    // Cover the real downstream services so sessions stays aligned with
    // uptime/health. Counts are static placeholders — no per-service polling.
    return {
      services: {
        smr: { active: 0 },
        stt: { active: 0 },
        tts: { active: 0 },
        nlp: { active: 0 },
        guardrail: { active: 0 },
        harness: { active: 0 },
      },
      totalUsers: 0,
      refreshedAt: new Date().toISOString(),
    };
  }
}
