# Redis Service Module

The Redis Service Module provides Redis-based job queue functionality using BullMQ. It integrates with the configuration service to manage Redis connection settings.

## Configuration

The Redis service requires the following environment variables:

### Required Configuration

- `REDIS_HOST`: Redis server hostname (default: 'localhost')
- `REDIS_PORT`: Redis server port (default: 6379, must be between 1-65535)

### Optional Configuration

- `REDIS_PASS`: Redis server password (optional, leave empty if no password)

### Example .env Configuration

```bash
# Redis Configuration
REDIS_HOST=localhost
REDIS_PORT=6379
REDIS_PASS=your_redis_password
```

## Usage

### Module Registration

```typescript
import { RedisServiceModule } from '@arcaai/applications';
import { JobQueue } from '@arcaai/domains';

@Module({
  imports: [
    RedisServiceModule.register([
      JobQueue.AuditLog,
      JobQueue.UserActivity,
      JobQueue.SendEmail,
      // ... other queues
    ]),
  ],
})
export class AppModule {}
```

### Service Injection

```typescript
import { Inject, Injectable } from '@nestjs/common';
import { IRedisService } from '@arcaai/applications';

@Injectable()
export class MyService {
  constructor(
    @Inject(IRedisService) private redisService: IRedisService,
  ) {}

  async addJob() {
    await this.redisService.addJob({
      queueName: JobQueue.SendEmail,
      jobType: 'send-welcome-email',
      data: { userId: '123', email: 'user@example.com' },
      options: {
        delay: 5000, // 5 second delay
        attempts: 3,
      },
    });
  }
}
```

## Error Handling

The Redis service provides comprehensive error handling:

### Configuration Errors

- `RedisConfigurationException`: Thrown when Redis configuration is missing or invalid
  - Missing `REDIS_HOST` or `REDIS_PORT`
  - Invalid port range (not between 1-65535)
  - Connection failures

### Runtime Errors

- Queue not found errors with helpful messages listing available queues
- Connection errors with specific Redis server details
- Job addition failures with detailed error information

## Features

- **Configuration Integration**: Uses the ConfigService for centralized configuration management
- **Validation**: Comprehensive validation of Redis configuration at startup
- **Error Handling**: Detailed error messages with configuration hints
- **Logging**: Extensive logging for debugging and monitoring
- **Queue Management**: Dynamic queue registration and management
- **Connection Resilience**: Automatic retry logic with exponential backoff

## Queue Configuration

Default job options:
- **Attempts**: 3 retries
- **Backoff**: Exponential with 1000ms initial delay
- **Cleanup**: Keep 100 completed jobs, 200 failed jobs

## Health Monitoring

The service logs:
- Redis connection details (without password)
- Queue initialization status
- Job processing results
- Connection errors and recovery attempts

## Dependencies

- `@nestjs/bullmq`: BullMQ integration for NestJS
- `bullmq`: Redis-based job queue
- `ConfigService`: Application configuration management
- `Redis`: Redis client connection