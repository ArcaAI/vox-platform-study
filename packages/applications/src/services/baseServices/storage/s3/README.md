# S3 Service Documentation

This document provides comprehensive documentation for the S3 service that provides S3-compatible storage functionality using configuration from the AppSettingsService.

## Overview

The S3Service provides file storage operations using S3-compatible storage (AWS S3, MinIO, etc.). It uses the AppSettingsService for configuration management, allowing runtime configuration updates and database-stored settings.

**For MinIO-specific setup and configuration, see [MINIO.md](./MINIO.md)**

## Architecture

```
┌─────────────────────────────────────────────────────────────────────┐
│                        S3 Service Architecture                      │
├─────────────────────────────────────────────────────────────────────┤
│                                                                     │
│  ┌────────────────────┐    ┌─────────────────┐    ┌───────────────┐ │
│  │ AppSettingsService │    │   S3Service     │    │ S3-Compatible │ │
│  │                    │    │                 │    │   Storage     │ │
│  │ • S3_ENDPOINT      │───▶│ • Lazy Init     │───▶│               │ │
│  │ • S3_ACCESS_KEY    │    │ • Config Cache   │    │ • AWS S3      │ │
│  │ • S3_SECRET_KEY    │    │ • Auto Retry    │    │ • MinIO       │ │
│  │ • S3_REGION        │    │ • Error Handle  │    │ • Others      │ │
│  │ • Bucket Names     │    │ • Validation    │    │               │ │
│  └────────────────────┘    └─────────────────┘    └───────────────┘ │
│                                                                     │
└─────────────────────────────────────────────────────────────────────┘
```

## Configuration

The S3Service uses the following configuration keys from AppSettingsService:

### Required Configuration

| Key             | Type   | Description             | Example                 |
| --------------- | ------ | ----------------------- | ----------------------- |
| `S3_ENDPOINT`   | string | S3 service endpoint URL | `http://localhost:9000` |
| `S3_ACCESS_KEY` | string | S3 access key           | `minioadmin`            |
| `S3_SECRET_KEY` | string | S3 secret key           | `minioadmin`            |

### Optional Configuration

| Key                       | Type    | Default     | Description                                |
| ------------------------- | ------- | ----------- | ------------------------------------------ |
| `S3_REGION`               | string  | `us-east-1` | S3 region                                  |
| `S3_PUBLIC_BUCKET`        | string  | `''`        | Default public bucket name                 |
| `S3_PRIVATE_BUCKET`       | string  | `''`        | Default private bucket name                |
| `S3_FORCE_PATH_STYLE`     | boolean | `true`      | Force path-style URLs (required for MinIO) |
| `S3_REJECT_UNAUTHORIZED`  | boolean | `false`     | Reject unauthorized SSL certificates       |
| `S3_PRESIGNED_URL_EXPIRY` | number  | `3600`      | Presigned URL expiry in seconds            |

## Features

### Lazy Initialization

The S3Service uses lazy initialization to ensure configuration is available:

- **OnModuleInit**: Attempts to initialize during module startup
- **Lazy Loading**: Initializes on first operation if not already done
- **Error Handling**: Graceful handling of missing configuration
- **Retry Logic**: Automatic retry on configuration updates

### Configuration Management

- **Runtime Updates**: Configuration can be updated without restart
- **Validation**: Validates required configuration on initialization
- **Defaults**: Provides sensible defaults for optional settings
- **Error Messages**: Clear error messages for missing configuration

### Enhanced Logging

- **Operation Logging**: Logs all S3 operations with details
- **Debug Information**: Additional debug info when enabled
- **Error Context**: Detailed error context for troubleshooting
- **Performance Metrics**: File sizes and operation timing

## Usage Examples

### Basic Setup

```typescript
import { Module } from '@nestjs/common';
import { S3ServiceModule } from './path/to/s3.service.module';
import { AppSettingsModule } from './path/to/appSettings.module';

@Module({
  imports: [
    AppSettingsModule.forRoot(), // Must be imported first
    S3ServiceModule,
  ],
})
export class AppModule {}
```

### Service Injection

```typescript
import { Inject, Injectable } from '@nestjs/common';
import { IS3Service } from './path/to/IS3Service';

@Injectable()
export class FileService {
  constructor(@Inject(IS3Service) private readonly s3Service: IS3Service) {}

  async uploadFile(file: Buffer, filename: string): Promise<void> {
    // Check if S3 is configured
    if (!(await this.s3Service.isConfigured())) {
      throw new Error('S3 storage is not configured');
    }

    // Upload to public bucket
    const bucketName = this.s3Service.getPublicBucketName();
    await this.s3Service.putFile(bucketName, filename, file, 'image/jpeg');
  }

  async downloadFile(filename: string): Promise<Buffer> {
    const bucketName = this.s3Service.getPublicBucketName();
    return await this.s3Service.getFile(bucketName, filename);
  }

  async generateDownloadUrl(filename: string): Promise<string> {
    const bucketName = this.s3Service.getPublicBucketName();
    return await this.s3Service.signUrl(bucketName, filename, 'get');
  }
}
```

### File Operations

```typescript
// Upload a file
await s3Service.putFile('my-bucket', 'path/to/file.jpg', fileBuffer, 'image/jpeg');

// Download a file
const fileData = await s3Service.getFile('my-bucket', 'path/to/file.jpg');

// List files with prefix
const files = await s3Service.listFiles('my-bucket', 'uploads/');

// Copy a file
await s3Service.copyFile('dest-bucket', 'new-path/file.jpg', 'source-bucket/old-path/file.jpg');

// Delete a file
await s3Service.deleteFile('my-bucket', 'path/to/file.jpg');

// Generate presigned URL
const downloadUrl = await s3Service.signUrl('my-bucket', 'path/to/file.jpg', 'get');
const listUrl = await s3Service.signUrl('my-bucket', 'path/prefix/', 'list');
```

### Configuration Management

```typescript
// Check if S3 is configured
const isConfigured = await s3Service.isConfigured();

// Test connectivity
const isConnected = await s3Service.testConnection();

// Refresh configuration (useful when settings change)
await s3Service.refreshConfiguration();

// Get bucket names
const publicBucket = s3Service.getPublicBucketName();
const privateBucket = s3Service.getPrivateBucketName();
```

## Database Configuration Setup

To configure S3 through the database, create records in the `GlobalSettingEntity` table:

```sql
-- Required settings
INSERT INTO global_settings (key, value, description) VALUES
('S3_ENDPOINT', 'http://localhost:9000', 'S3 service endpoint URL'),
('S3_ACCESS_KEY', 'minioadmin', 'S3 access key'),
('S3_SECRET_KEY', 'minioadmin', 'S3 secret key');

-- Optional settings
INSERT INTO global_settings (key, value, description) VALUES
('S3_REGION', 'us-east-1', 'S3 region'),
('S3_PUBLIC_BUCKET', 'public-files', 'Default public bucket'),
('S3_PRIVATE_BUCKET', 'private-files', 'Default private bucket'),
('S3_FORCE_PATH_STYLE', 'true', 'Force path-style URLs'),
('S3_REJECT_UNAUTHORIZED', 'false', 'Reject unauthorized SSL'),
('S3_PRESIGNED_URL_EXPIRY', '3600', 'Presigned URL expiry seconds');
```

## Error Handling

### Configuration Errors

```typescript
try {
  await s3Service.putFile('bucket', 'key', buffer);
} catch (error) {
  if (error.message.includes('S3 configuration validation failed')) {
    // Handle missing configuration
    console.error('S3 not configured:', error.message);
  }
}
```

### Connection Errors

```typescript
// Test connection before operations
if (!(await s3Service.testConnection())) {
  throw new Error('S3 service is not available');
}
```

### File Operation Errors

```typescript
try {
  const file = await s3Service.getFile('bucket', 'nonexistent-file');
} catch (error) {
  if (error instanceof NotFoundException) {
    // Handle file not found
    console.log('File not found');
  } else {
    // Handle other S3 errors
    console.error('S3 operation failed:', error);
  }
}
```

## Monitoring and Health Checks

### Health Check Implementation

```typescript
@Injectable()
export class S3HealthIndicator {
  constructor(@Inject(IS3Service) private readonly s3Service: IS3Service) {}

  async isHealthy(): Promise<boolean> {
    try {
      // Check configuration
      if (!(await this.s3Service.isConfigured())) {
        return false;
      }

      // Test connectivity
      return await this.s3Service.testConnection();
    } catch {
      return false;
    }
  }

  async getHealthDetails() {
    const isConfigured = await this.s3Service.isConfigured();
    const isConnected = isConfigured ? await this.s3Service.testConnection() : false;

    return {
      configured: isConfigured,
      connected: isConnected,
      publicBucket: this.s3Service.getPublicBucketName(),
      privateBucket: this.s3Service.getPrivateBucketName(),
    };
  }
}
```

### Metrics Collection

```typescript
@Injectable()
export class S3MetricsService {
  private uploadCount = 0;
  private downloadCount = 0;
  private errorCount = 0;

  constructor(@Inject(IS3Service) private readonly s3Service: IS3Service) {}

  async uploadWithMetrics(bucket: string, key: string, data: Buffer): Promise<void> {
    try {
      await this.s3Service.putFile(bucket, key, data);
      this.uploadCount++;
    } catch (error) {
      this.errorCount++;
      throw error;
    }
  }

  getMetrics() {
    return {
      uploads: this.uploadCount,
      downloads: this.downloadCount,
      errors: this.errorCount,
    };
  }
}
```

## Best Practices

### Configuration Management

1. **Environment Separation**: Use different buckets for different environments
2. **Security**: Store sensitive keys in database, not environment variables
3. **Validation**: Always validate configuration before operations
4. **Monitoring**: Monitor configuration changes and service health

### File Management

1. **Naming Conventions**: Use consistent file naming patterns
2. **Path Organization**: Organize files in logical directory structures
3. **Metadata**: Include appropriate MIME types and metadata
4. **Cleanup**: Implement file cleanup policies for temporary files

### Error Handling

1. **Graceful Degradation**: Handle S3 unavailability gracefully
2. **Retry Logic**: Implement retry logic for transient failures
3. **Logging**: Log all operations and errors with context
4. **User Feedback**: Provide meaningful error messages to users

### Performance

1. **Connection Pooling**: Reuse S3 client connections
2. **Parallel Operations**: Use parallel uploads/downloads when possible
3. **Streaming**: Use streaming for large files
4. **Caching**: Cache frequently accessed files

## Security Considerations

### Access Control

- Use IAM policies to restrict S3 access
- Implement bucket policies for fine-grained control
- Use presigned URLs for temporary access
- Validate file types and sizes before upload

### Data Protection

- Enable encryption at rest and in transit
- Use HTTPS endpoints when possible
- Implement virus scanning for uploaded files
- Regular security audits of bucket permissions

## Troubleshooting

### Common Issues

1. **Configuration not loading**: Check AppSettingsService cache
2. **Connection timeouts**: Verify network connectivity and endpoint
3. **Access denied**: Check access keys and bucket permissions
4. **File not found**: Verify bucket name and file key

### Debug Steps

1. Enable debug logging: Set `DEBUG=true` in app settings
2. Check S3 configuration: Use `isConfigured()` method
3. Test connectivity: Use `testConnection()` method
4. Verify bucket access: Check bucket permissions and policies
5. Monitor logs: Check application and S3 service logs

### Performance Issues

1. **Slow uploads**: Check network bandwidth and file sizes
2. **Memory usage**: Use streaming for large files
3. **Connection limits**: Monitor connection pool usage
4. **Rate limiting**: Implement backoff strategies

## Migration Guide

### From ConfigService to AppSettingsService

1. **Update Dependencies**: Import AppSettingsModule in S3ServiceModule
2. **Database Setup**: Create GlobalSettingEntity records for S3 config
3. **Remove Environment Variables**: Move S3 config from .env to database
4. **Update Initialization**: Ensure AppSettingsService loads before S3Service
5. **Test Configuration**: Verify all S3 operations work with new config source

### Configuration Migration Script

```typescript
async function migrateS3Configuration() {
  // Read from environment variables
  const envConfig = {
    S3_ENDPOINT: process.env.S3_ENDPOINT,
    S3_ACCESS_KEY: process.env.S3_ACCESS_KEY,
    S3_SECRET_KEY: process.env.S3_SECRET_KEY,
    // ... other config
  };

  // Create database records
  for (const [key, value] of Object.entries(envConfig)) {
    if (value) {
      await globalSettingRepository.create({
        key,
        value,
        description: `S3 configuration: ${key}`,
      });
    }
  }
}
```
