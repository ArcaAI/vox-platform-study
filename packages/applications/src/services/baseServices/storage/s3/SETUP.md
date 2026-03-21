# S3 Service Module Setup Guide

This guide explains how to properly set up and use the S3ServiceModule in your NestJS application.

## Prerequisites

1. **Database Setup**: Ensure your database is configured with the required global settings
2. **Choose Import Method**: Use either the self-contained `forRoot()` method (recommended) or manual global setup

## Quick Start (Recommended)

The easiest way to use the S3ServiceModule is with the `forRoot()` method, which handles all dependencies automatically:

```typescript
import { Module } from '@nestjs/common';
import { S3ServiceModule } from '@arcaai/applications/baseServices/storage/s3';

@Module({
    imports: [
        S3ServiceModule.forRoot(), // Includes all dependencies
    ],
    // ... other configuration
})
export class AppModule {}
```

## Setup Options

### Option 1: Self-Contained Import (Recommended)

Use `S3ServiceModule.forRoot()` which automatically includes the AppSettingsModule dependency:

```typescript
import { Module } from '@nestjs/common';
import { S3ServiceModule } from '@arcaai/applications/baseServices/storage/s3';

@Module({
    imports: [
        S3ServiceModule.forRoot(), // All dependencies included
        // ... other modules
    ],
})
export class AppModule {}
```

### Option 2: Global AppSettings + Feature Import

If you prefer to manage AppSettingsModule globally:

```typescript
import { Module } from '@nestjs/common';
import { AppSettingsModule } from '@arcaai/applications/baseServices/_meta/appSettings';
import { S3ServiceModule } from '@arcaai/applications/baseServices/storage/s3';

@Module({
    imports: [
        AppSettingsModule.forRoot(), // Global import
        S3ServiceModule.forFeature(), // Uses global AppSettings
        // ... other modules
    ],
})
export class AppModule {}
```

### Option 3: Simple Import (When AppSettings is Global)

If AppSettingsModule is already global, you can use simple import:

```typescript
import { Module } from '@nestjs/common';
import { AppSettingsModule } from '@arcaai/applications/baseServices/_meta/appSettings';
import { S3ServiceModule } from '@arcaai/applications/baseServices/storage/s3';

@Module({
    imports: [
        AppSettingsModule.forRoot(), // Global import
        S3ServiceModule, // Simple import
        // ... other modules
    ],
})
export class AppModule {}
```

## Database Configuration

Add the required S3 configuration to your database. Run these SQL commands:

```sql
-- Required S3 configuration
INSERT INTO global_settings (key, value, description) VALUES
('S3_ENDPOINT', 'http://localhost:9000', 'S3 service endpoint URL'),
('S3_ACCESS_KEY', 'minioadmin', 'S3 access key'),
('S3_SECRET_KEY', 'minioadmin', 'S3 secret key');

-- Optional S3 configuration
INSERT INTO global_settings (key, value, description) VALUES
('S3_REGION', 'us-east-1', 'S3 region'),
('S3_PUBLIC_BUCKET', 'public-files', 'Default public bucket'),
('S3_PRIVATE_BUCKET', 'private-files', 'Default private bucket'),
('S3_FORCE_PATH_STYLE', 'true', 'Force path-style URLs (required for MinIO)'),
('S3_REJECT_UNAUTHORIZED', 'false', 'Reject unauthorized SSL certificates'),
('S3_PRESIGNED_URL_EXPIRY', '3600', 'Presigned URL expiry in seconds'),
('S3_MAX_RETRIES', '3', 'Connection retry attempts'),
('S3_REQUEST_TIMEOUT', '30000', 'Request timeout in milliseconds');
```

## Feature Module Usage

In feature modules, you can import S3ServiceModule in different ways:

### Using forRoot() (Recommended for feature modules)

```typescript
import { Module } from '@nestjs/common';
import { S3ServiceModule } from '@arcaai/applications/baseServices/storage/s3';
import { MyFeatureService } from './my-feature.service';

@Module({
    imports: [
        S3ServiceModule.forRoot(), // Self-contained
    ],
    providers: [MyFeatureService],
    exports: [MyFeatureService],
})
export class MyFeatureModule {}
```

### Using forFeature() (When AppSettings is global)

```typescript
import { Module } from '@nestjs/common';
import { S3ServiceModule } from '@arcaai/applications/baseServices/storage/s3';
import { MyFeatureService } from './my-feature.service';

@Module({
    imports: [
        S3ServiceModule.forFeature(), // Assumes global AppSettings
    ],
    providers: [MyFeatureService],
    exports: [MyFeatureService],
})
export class MyFeatureModule {}
```

## Service Usage

Inject and use the S3 services in your application:

```typescript
import { Injectable, Logger } from '@nestjs/common';
import { IS3Service, S3HealthService } from '@arcaai/applications/baseServices/storage/s3';

@Injectable()
export class MyFeatureService {
    private readonly logger = new Logger(MyFeatureService.name);

    constructor(
        private readonly s3Service: IS3Service,
        private readonly s3HealthService: S3HealthService,
    ) {}

    async uploadFile(file: Buffer, filename: string): Promise<void> {
        try {
            // Check if S3 is healthy before using
            const health = await this.s3HealthService.quickCheck();
            if (!health) {
                throw new Error('S3 service is not available');
            }

            // Get bucket name
            const bucket = this.s3Service.getPublicBucketName();
            if (!bucket) {
                throw new Error('No public bucket configured');
            }

            // Upload file
            await this.s3Service.putFile(bucket, filename, file, 'application/octet-stream');
            this.logger.log(`File uploaded successfully: ${filename}`);
        } catch (error) {
            this.logger.error('Failed to upload file:', error);
            throw error;
        }
    }

    async checkS3Health(): Promise<void> {
        const healthStatus = await this.s3HealthService.checkHealth();
        this.logger.log('S3 Health Status:', healthStatus);
    }
}
```

## MinIO Setup (Optional)

If you're using MinIO for development, you can start it using Docker:

```bash
# Start MinIO using Docker
docker run -d \
  --name minio \
  -p 9000:9000 \
  -p 9001:9001 \
  -e MINIO_ROOT_USER=minioadmin \
  -e MINIO_ROOT_PASSWORD=minioadmin \
  minio/minio server /data --console-address ":9001"
```

Then access the MinIO console at `http://localhost:9001` to create buckets.

## Troubleshooting

### Error: "Nest can't resolve dependencies of the S3Service"

This error occurs when the `AppSettingsModule` dependency is not available.

**Solutions**:

1. **Use `S3ServiceModule.forRoot()`** (recommended) - this includes all dependencies
2. **Ensure `AppSettingsModule.forRoot()`** is imported at the root level if using other import methods
3. **Check import order** - AppSettingsModule must be imported before S3ServiceModule

### Error: "S3 service is not configured"

This error occurs when the required S3 configuration is missing from the database.

**Solution**:

1. Check that your database contains the required global settings
2. Verify the AppSettingsService is properly loading the configuration
3. Use the health check service to diagnose configuration issues

### Error: "AppSettings service failed to initialize within timeout period"

This error occurs when the AppSettingsService takes too long to initialize.

**Solution**:

1. Check your database connection
2. Ensure the `global_settings` table exists and is accessible
3. Check for any database performance issues

## Import Method Comparison

| Method                         | Use Case                                   | Pros                                            | Cons                                   |
| ------------------------------ | ------------------------------------------ | ----------------------------------------------- | -------------------------------------- |
| `S3ServiceModule.forRoot()`    | Any module, recommended                    | Self-contained, no dependency management needed | Slightly more overhead                 |
| `S3ServiceModule.forFeature()` | Feature modules when AppSettings is global | Clean separation, leverages global modules      | Requires global AppSettings setup      |
| `S3ServiceModule` (simple)     | When AppSettings is global                 | Simplest syntax                                 | Requires careful dependency management |

## Health Monitoring

Use the S3HealthService to monitor your S3 configuration and connectivity:

```typescript
// Quick health check
const isHealthy = await s3HealthService.quickCheck();

// Detailed health check
const healthStatus = await s3HealthService.checkHealth();

// Configuration details
const configDetails = await s3HealthService.getConfigurationDetails();

// Test all operations
const operationResults = await s3HealthService.testOperations('my-bucket');
```

## Configuration Reference

| Setting                   | Required | Default                           | Description                                |
| ------------------------- | -------- | --------------------------------- | ------------------------------------------ |
| `S3_ENDPOINT`             | Yes      | -                                 | S3 service endpoint URL                    |
| `S3_ACCESS_KEY`           | Yes      | -                                 | S3 access key                              |
| `S3_SECRET_KEY`           | Yes      | -                                 | S3 secret key                              |
| `S3_REGION`               | No       | `us-east-1`                       | S3 region                                  |
| `S3_PUBLIC_BUCKET`        | No       | -                                 | Default public bucket name                 |
| `S3_PRIVATE_BUCKET`       | No       | -                                 | Default private bucket name                |
| `S3_FORCE_PATH_STYLE`     | No       | `true`                            | Force path-style URLs (required for MinIO) |
| `S3_REJECT_UNAUTHORIZED`  | No       | `false` for MinIO, `true` for AWS | Reject unauthorized SSL certificates       |
| `S3_PRESIGNED_URL_EXPIRY` | No       | `3600`                            | Presigned URL expiry in seconds            |
| `S3_MAX_RETRIES`          | No       | `3`                               | Connection retry attempts                  |
| `S3_REQUEST_TIMEOUT`      | No       | `30000`                           | Request timeout in milliseconds            |
