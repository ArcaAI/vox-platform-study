import { Inject, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { AddJobProps, IRedisService } from './IRedisService';
import { getQueueToken } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { ModuleRef } from '@nestjs/core';
import { IConfigService } from '../_meta/config';
import { RedisConfigurationException } from './redis-config.exception';

@Injectable()
export class RedisService implements IRedisService, OnModuleInit {
  private readonly logger = new Logger(RedisService.name);
  private readonly queues: { [key: string]: Queue } = {};

  constructor(
    @Inject('QUEUE_NAMES') private readonly queueNames: string[],
    @Inject(IConfigService) private readonly configService: IConfigService,
    private readonly moduleRef: ModuleRef,
  ) {
    this.logger.log({
      message: 'Service created',
      service: RedisService.name,
    });
  }

  async onModuleInit() {
    try {
      // Check if Redis is configured
      if (!this.configService.isRedisConfigured()) {
        throw new RedisConfigurationException('Redis configuration is not available. Please check REDIS_HOST and REDIS_PORT environment variables.');
      }

      // Log Redis configuration (without password)
      const redisConfig = this.configService.getRedisConfig();
      this.logger.log({
        message: 'Initializing Redis service',
        host: redisConfig.host,
        port: redisConfig.port,
      });

      this.initQueues();
      this.logger.log({
        message: 'Redis service initialized',
        service: RedisService.name,
        queueCount: this.queueNames.length,
        queues: this.queueNames,
      });
    } catch (error) {
      this.logger.error({
        message: 'Failed to initialize Redis service',
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  private initQueues() {
    this.queueNames.forEach((queueName) => {
      try {
        this.logger.log({
          message: 'Initializing queue',
          queueName,
        });
        const queueToken = getQueueToken(queueName);
        this.queues[queueName] = this.moduleRef.get<Queue>(queueToken, {
          strict: false,
        });
        this.logger.debug({
          message: 'Queue initialized successfully',
          queueName,
        });
      } catch (error) {
        this.logger.error({
          message: 'Failed to initialize queue',
          queueName,
          error: error instanceof Error ? error.message : String(error),
        });
        throw new RedisConfigurationException(`Failed to initialize Redis queue: ${queueName}. Please check Redis connection and configuration.`);
      }
    });
  }

  public async addJob<T>({ queueName, jobType, data, options }: AddJobProps<T>): Promise<void> {
    const queue = this.queues[queueName];
    if (!queue) {
      this.logger.error({
        message: 'Queue not found',
        queueName,
        availableQueues: Object.keys(this.queues),
      });
      throw new Error(`Queue ${queueName} not found. Available queues: ${Object.keys(this.queues).join(', ')}`);
    }

    try {
      await queue.add(jobType as string, data, options);
      this.logger.log({
        message: 'Job added to queue',
        queueName,
        jobType,
      });
    } catch (error) {
      this.logger.error({
        message: 'Failed to add job to queue',
        queueName,
        jobType,
        error: error instanceof Error ? error.message : String(error),
      });

      // Check if it's a Redis connection error
      if (error instanceof Error && error.message.includes('ECONNREFUSED')) {
        const redisConfig = this.configService.getRedisConfig();
        throw new RedisConfigurationException(
          `Failed to connect to Redis server at ${redisConfig.host}:${redisConfig.port}. Please verify Redis is running and configuration is correct.`,
        );
      }

      throw error; // Re-throw the error for better error handling
    }
  }
}
