import { DynamicModule, Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { RedisService } from './redis.service';
import { IRedisService } from './IRedisService';
import { ConfigModule, IConfigService } from '../_meta/config';
import { RedisConfigurationException } from './redis-config.exception';

@Module({})
export class RedisServiceModule {
    static register(queueNames: string[]): DynamicModule {
        const queueModules = queueNames.map((queueName) =>
            BullModule.registerQueue({ name: queueName }),
        );

        // const queueProviders: Provider[] = queueNames.map((queueName) => ({
        //     provide: `QUEUE_${queueName.toUpperCase()}`,
        //     useFactory: async (queue: Queue) => queue,
        //     inject: [getQueueToken(queueName)],
        // }));

        return {
            module: RedisServiceModule,
            imports: [
                ConfigModule,
                BullModule.forRootAsync({
                    imports: [ConfigModule],
                    useFactory: async (configService: IConfigService) => {
                        // Check if Redis is configured
                        if (!configService.isRedisConfigured()) {
                            throw new RedisConfigurationException(
                                'Redis configuration is missing or invalid',
                                ['REDIS_HOST', 'REDIS_PORT']
                            );
                        }

                        try {
                            const redisConfig = configService.getRedisConfig();

                            return {
                                connection: {
                                    host: redisConfig.host,
                                    port: redisConfig.port,
                                    password: redisConfig.password,
                                },
                                defaultJobOptions: {
                                    attempts: 3,
                                    backoff: {
                                        type: 'exponential',
                                        delay: 1000,
                                    },
                                    removeOnComplete: 100,  // Keep only 100 completed jobs
                                    removeOnFail: 200,      // Keep only 200 failed jobs
                                },
                            };
                        } catch (error) {
                            throw new RedisConfigurationException(
                                error instanceof Error ? error.message : 'Failed to get Redis configuration'
                            );
                        }
                    },
                    inject: [IConfigService],
                }),
                ...queueModules,
            ],
            providers: [
                {
                    provide: IRedisService,
                    useClass: RedisService,
                },
                {
                    provide: 'QUEUE_NAMES',
                    useValue: queueNames,
                },
            ],
            exports: [IRedisService],
        };
    }
}
