/**
 * RedisService Unit Tests
 *
 * Tests for the BullMQ job queue service implementation.
 */

import { describe, it, expect, beforeEach, afterEach, vi, Mock } from 'vitest';
import { RedisService } from '../redis.service';
import { RedisConfigurationException } from '../redis-config.exception';
import { IConfigService } from '../../_meta/config';
import type { ModuleRef } from '@nestjs/core';

// Mock BullMQ
vi.mock('@nestjs/bullmq', () => ({
    getQueueToken: vi.fn((name: string) => `QUEUE_${name}`),
}));

vi.mock('bullmq', () => ({
    Queue: vi.fn(),
}));

import { getQueueToken } from '@nestjs/bullmq';

describe('RedisService', () => {
    let service: RedisService;
    let mockConfigService: IConfigService;
    let mockModuleRef: Partial<ModuleRef>;
    let mockQueue: any;

    const createMockConfigService = (configured: boolean = true): IConfigService => ({
        isRedisConfigured: vi.fn().mockReturnValue(configured),
        getRedisConfig: vi.fn().mockReturnValue({
            host: 'localhost',
            port: 6379,
            password: 'testpass',
        }),
        getConfiguration: vi.fn().mockReturnValue({}),
    } as unknown as IConfigService);

    beforeEach(() => {
        vi.clearAllMocks();

        mockQueue = {
            add: vi.fn().mockResolvedValue({ id: 'job-1' }),
        };

        mockModuleRef = {
            get: vi.fn().mockReturnValue(mockQueue),
        };

        mockConfigService = createMockConfigService();
    });

    afterEach(() => {
        vi.restoreAllMocks();
    });

    describe('constructor', () => {
        it('should create service with queue names', () => {
            service = new RedisService(
                ['queue1', 'queue2'],
                mockConfigService,
                mockModuleRef as ModuleRef
            );
            expect(service).toBeDefined();
        });

        it('should create service with empty queue names', () => {
            service = new RedisService(
                [],
                mockConfigService,
                mockModuleRef as ModuleRef
            );
            expect(service).toBeDefined();
        });
    });

    describe('onModuleInit', () => {
        it('should throw RedisConfigurationException when Redis is not configured', async () => {
            mockConfigService = createMockConfigService(false);
            service = new RedisService(
                ['queue1'],
                mockConfigService,
                mockModuleRef as ModuleRef
            );

            await expect(service.onModuleInit()).rejects.toThrow(RedisConfigurationException);
        });

        it('should initialize queues when Redis is configured', async () => {
            service = new RedisService(
                ['queue1', 'queue2'],
                mockConfigService,
                mockModuleRef as ModuleRef
            );

            await service.onModuleInit();

            expect(mockModuleRef.get).toHaveBeenCalledTimes(2);
            expect(getQueueToken).toHaveBeenCalledWith('queue1');
            expect(getQueueToken).toHaveBeenCalledWith('queue2');
        });

        it('should log Redis configuration', async () => {
            service = new RedisService(
                ['queue1'],
                mockConfigService,
                mockModuleRef as ModuleRef
            );

            await service.onModuleInit();

            expect(mockConfigService.getRedisConfig).toHaveBeenCalled();
        });

        it('should throw RedisConfigurationException when queue initialization fails', async () => {
            mockModuleRef.get = vi.fn().mockImplementation(() => {
                throw new Error('Queue not found');
            });

            service = new RedisService(
                ['queue1'],
                mockConfigService,
                mockModuleRef as ModuleRef
            );

            await expect(service.onModuleInit()).rejects.toThrow(RedisConfigurationException);
        });

        it('should handle empty queue names array', async () => {
            service = new RedisService(
                [],
                mockConfigService,
                mockModuleRef as ModuleRef
            );

            await service.onModuleInit();

            expect(mockModuleRef.get).not.toHaveBeenCalled();
        });
    });

    describe('addJob', () => {
        beforeEach(async () => {
            service = new RedisService(
                ['queue1', 'queue2'],
                mockConfigService,
                mockModuleRef as ModuleRef
            );
            await service.onModuleInit();
        });

        it('should add job to specified queue', async () => {
            await service.addJob({
                queueName: 'queue1',
                jobType: 'process-data',
                data: { id: 123 },
            });

            expect(mockQueue.add).toHaveBeenCalledWith(
                'process-data',
                { id: 123 },
                undefined
            );
        });

        it('should add job with options', async () => {
            const options = { delay: 1000, attempts: 3 };

            await service.addJob({
                queueName: 'queue1',
                jobType: 'process-data',
                data: { id: 123 },
                options,
            });

            expect(mockQueue.add).toHaveBeenCalledWith(
                'process-data',
                { id: 123 },
                options
            );
        });

        it('should throw error when queue not found', async () => {
            await expect(
                service.addJob({
                    queueName: 'non-existent-queue',
                    jobType: 'process-data',
                    data: { id: 123 },
                })
            ).rejects.toThrow('Queue non-existent-queue not found');
        });

        it('should throw RedisConfigurationException on ECONNREFUSED error', async () => {
            const connectionError = new Error('connect ECONNREFUSED 127.0.0.1:6379');
            mockQueue.add.mockRejectedValue(connectionError);

            await expect(
                service.addJob({
                    queueName: 'queue1',
                    jobType: 'process-data',
                    data: { id: 123 },
                })
            ).rejects.toThrow(RedisConfigurationException);
        });

        it('should re-throw other errors', async () => {
            const otherError = new Error('Some other error');
            mockQueue.add.mockRejectedValue(otherError);

            await expect(
                service.addJob({
                    queueName: 'queue1',
                    jobType: 'process-data',
                    data: { id: 123 },
                })
            ).rejects.toThrow('Some other error');
        });

        it('should handle different data types', async () => {
            // String data
            await service.addJob({
                queueName: 'queue1',
                jobType: 'process-string',
                data: 'string-data',
            });

            expect(mockQueue.add).toHaveBeenCalledWith(
                'process-string',
                'string-data',
                undefined
            );

            // Array data
            await service.addJob({
                queueName: 'queue1',
                jobType: 'process-array',
                data: [1, 2, 3],
            });

            expect(mockQueue.add).toHaveBeenCalledWith(
                'process-array',
                [1, 2, 3],
                undefined
            );
        });
    });

    describe('error handling', () => {
        it('should include available queues in error message', async () => {
            service = new RedisService(
                ['queue1', 'queue2'],
                mockConfigService,
                mockModuleRef as ModuleRef
            );
            await service.onModuleInit();

            try {
                await service.addJob({
                    queueName: 'missing-queue',
                    jobType: 'test',
                    data: {},
                });
            } catch (error) {
                expect((error as Error).message).toContain('queue1');
                expect((error as Error).message).toContain('queue2');
            }
        });

        it('should include Redis host/port in connection error', async () => {
            service = new RedisService(
                ['queue1'],
                mockConfigService,
                mockModuleRef as ModuleRef
            );
            await service.onModuleInit();

            const connectionError = new Error('connect ECONNREFUSED');
            mockQueue.add.mockRejectedValue(connectionError);

            try {
                await service.addJob({
                    queueName: 'queue1',
                    jobType: 'test',
                    data: {},
                });
            } catch (error) {
                expect(error).toBeInstanceOf(RedisConfigurationException);
                expect((error as Error).message).toContain('localhost');
                expect((error as Error).message).toContain('6379');
            }
        });
    });
});
