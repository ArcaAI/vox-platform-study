# MinIO Integration Guide

This document provides comprehensive guidance for using the S3 service module with MinIO, an open-source object storage server compatible with Amazon S3.

## Overview

The S3 service module is fully compatible with MinIO and includes specific optimizations and configurations for MinIO deployments. MinIO is automatically detected based on endpoint patterns, and the service adjusts its configuration accordingly.

## MinIO Detection

The service automatically detects MinIO based on these endpoint patterns:

- `localhost` or `127.0.0.1` (local development)
- Endpoints containing `minio` in the hostname
- Endpoints using ports `:9000` or `:9001` (default MinIO ports)

## MinIO-Specific Configuration

### Required Settings

```sql
-- MinIO endpoint (adjust host and port as needed)
INSERT INTO global_settings (key, value, description) VALUES
('S3_ENDPOINT', 'http://localhost:9000', 'MinIO server endpoint'),
('S3_ACCESS_KEY', 'minioadmin', 'MinIO access key'),
('S3_SECRET_KEY', 'minioadmin', 'MinIO secret key');

-- JWT Authentication settings (if using auth services)
INSERT INTO global_settings (key, value, description) VALUES
('JWT_SECRET_KEY', 'your-super-secret-jwt-key-change-in-production', 'JWT signing secret key'),
('JWT_EXPIRES_IN', '24h', 'JWT token expiration time');

-- OIDC Authentication settings (if using OIDC auth)
INSERT INTO global_settings (key, value, description) VALUES
('OIDC_DISCOVERY_URL', 'https://your-oidc-provider.com/.well-known/openid_configuration', 'OIDC discovery URL'),
('OIDC_CLIENT_ID', 'your-oidc-client-id', 'OIDC client ID'),
('OIDC_CLIENT_SECRET', 'your-oidc-client-secret', 'OIDC client secret'),
('OIDC_CALLBACK_URL', 'http://localhost:8001/auth/callback', 'OIDC callback URL'),
('OIDC_SCOPES', 'openid profile email', 'OIDC scopes to request');
```

### Recommended Settings for MinIO

```sql
-- MinIO-optimized settings
INSERT INTO global_settings (key, value, description) VALUES
('S3_REGION', 'us-east-1', 'MinIO region (can be any value)'),
('S3_FORCE_PATH_STYLE', 'true', 'Required for MinIO compatibility'),
('S3_REJECT_UNAUTHORIZED', 'false', 'Allow self-signed certificates'),
('S3_MAX_RETRIES', '3', 'Connection retry attempts'),
('S3_REQUEST_TIMEOUT', '30000', 'Request timeout in milliseconds'),
('S3_PUBLIC_BUCKET', 'public-files', 'Default public bucket'),
('S3_PRIVATE_BUCKET', 'private-files', 'Default private bucket');
```

### Production Settings

For production MinIO deployments with proper SSL certificates:

```sql
UPDATE global_settings SET value = 'https://minio.yourdomain.com' WHERE key = 'S3_ENDPOINT';
UPDATE global_settings SET value = 'true' WHERE key = 'S3_REJECT_UNAUTHORIZED';
```

## MinIO Setup

### Docker Compose Setup

```yaml
version: '3.8'
services:
  minio:
    image: minio/minio:RELEASE.2025-04-22T22-12-26Z
    container_name: minio
    ports:
      - '9000:9000'
      - '9001:9001'
    environment:
      MINIO_ROOT_USER: minioadmin
      MINIO_ROOT_PASSWORD: minioadmin
    command: server /data --console-address ":9001"
    volumes:
      - minio_data:/data
    healthcheck:
      test: ['CMD', 'curl', '-f', 'http://localhost:9000/minio/health/live']
      interval: 30s
      timeout: 20s
      retries: 3

volumes:
  minio_data:
```

### Kubernetes Deployment

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: minio
spec:
  replicas: 1
  selector:
    matchLabels:
      app: minio
  template:
    metadata:
      labels:
        app: minio
    spec:
      containers:
        - name: minio
          image: minio/minio:RELEASE.2025-04-22T22-12-26Z
          ports:
            - containerPort: 9000
            - containerPort: 9001
          env:
            - name: MINIO_ROOT_USER
              value: 'minioadmin'
            - name: MINIO_ROOT_PASSWORD
              value: 'minioadmin'
          command:
            - /bin/bash
            - -c
          args:
            - minio server /data --console-address :9001
          volumeMounts:
            - name: storage
              mountPath: /data
      volumes:
        - name: storage
          persistentVolumeClaim:
            claimName: minio-pvc
---
apiVersion: v1
kind: Service
metadata:
  name: minio-service
spec:
  selector:
    app: minio
  ports:
    - name: api
      port: 9000
      targetPort: 9000
    - name: console
      port: 9001
      targetPort: 9001
  type: LoadBalancer
```

## Usage Examples

### Basic MinIO Operations

```typescript
import { Inject, Injectable } from '@nestjs/common';
import { IS3Service } from './path/to/IS3Service';

@Injectable()
export class MinIOService {
  constructor(@Inject(IS3Service) private readonly s3Service: IS3Service) {}

  async initializeMinIO(): Promise<void> {
    // Check if MinIO is configured
    if (!this.s3Service.isMinIOConfigured()) {
      throw new Error('MinIO is not configured');
    }

    // Get MinIO info
    const minioInfo = this.s3Service.getMinIOInfo();
    console.log('MinIO Configuration:', minioInfo);

    // Test connection
    const isConnected = await this.s3Service.testConnection();
    if (!isConnected) {
      throw new Error('Cannot connect to MinIO server');
    }

    console.log('MinIO connection successful');
  }

  async uploadToMinIO(file: Buffer, filename: string): Promise<void> {
    const bucket = this.s3Service.getPublicBucketName();
    await this.s3Service.putFile(bucket, filename, file, 'application/octet-stream');
    console.log(`File uploaded to MinIO: ${bucket}/${filename}`);
  }

  async downloadFromMinIO(filename: string): Promise<Buffer> {
    const bucket = this.s3Service.getPublicBucketName();
    return await this.s3Service.getFile(bucket, filename);
  }

  async generateMinIOUrl(filename: string): Promise<string> {
    const bucket = this.s3Service.getPublicBucketName();
    return await this.s3Service.signUrl(bucket, filename, 'get');
  }
}
```

### MinIO Health Check

```typescript
@Injectable()
export class MinIOHealthService {
  constructor(@Inject(IS3Service) private readonly s3Service: IS3Service) {}

  async checkMinIOHealth(): Promise<{
    status: 'healthy' | 'unhealthy';
    details: any;
  }> {
    try {
      const isConfigured = await this.s3Service.isConfigured();
      const isMinIO = this.s3Service.isMinIOConfigured();
      const isConnected = await this.s3Service.testConnection();
      const minioInfo = this.s3Service.getMinIOInfo();

      const status = isConfigured && isConnected ? 'healthy' : 'unhealthy';

      return {
        status,
        details: {
          configured: isConfigured,
          isMinIO,
          connected: isConnected,
          endpoint: minioInfo.endpoint,
          publicBucket: this.s3Service.getPublicBucketName(),
          privateBucket: this.s3Service.getPrivateBucketName(),
        },
      };
    } catch (error) {
      return {
        status: 'unhealthy',
        details: {
          error: error instanceof Error ? error.message : String(error),
        },
      };
    }
  }
}
```

## MinIO Console Access

The MinIO console provides a web interface for managing buckets and objects:

- **URL**: `http://localhost:9001` (or your MinIO console port)
- **Username**: `minioadmin` (or your configured root user)
- **Password**: `minioadmin` (or your configured root password)

### Creating Buckets via Console

1. Access the MinIO console
2. Navigate to "Buckets"
3. Click "Create Bucket"
4. Enter bucket name (e.g., `public-files`, `private-files`)
5. Configure bucket settings as needed

### Setting Bucket Policies

For public buckets, you may want to set a public read policy:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Principal": {
        "AWS": ["*"]
      },
      "Action": ["s3:GetObject"],
      "Resource": ["arn:aws:s3:::public-files/*"]
    }
  ]
}
```

## MinIO CLI (mc) Commands

### Installation

```bash
# Linux/macOS
curl https://dl.min.io/client/mc/release/linux-amd64/mc \
  --create-dirs \
  -o $HOME/minio-binaries/mc

chmod +x $HOME/minio-binaries/mc
export PATH=$PATH:$HOME/minio-binaries/

# Or using package managers
brew install minio/stable/mc  # macOS
```

### Configuration

```bash
# Add MinIO server
mc alias set local http://localhost:9000 minioadmin minioadmin

# Test connection
mc admin info local
```

### Common Operations

```bash
# List buckets
mc ls local

# Create bucket
mc mb local/public-files
mc mb local/private-files

# Upload file
mc cp myfile.txt local/public-files/

# Download file
mc cp local/public-files/myfile.txt ./downloaded-file.txt

# Set bucket policy (public read)
mc anonymous set public local/public-files

# List objects in bucket
mc ls local/public-files
```

## Performance Optimization

### MinIO-Specific Optimizations

The service includes several MinIO-specific optimizations:

1. **Connection Pooling**: Optimized for MinIO's connection handling
2. **Path Style URLs**: Automatically enabled for MinIO compatibility
3. **SSL Handling**: Flexible SSL certificate validation for development
4. **Retry Logic**: Configured for MinIO's response patterns
5. **Timeout Settings**: Optimized for MinIO's performance characteristics

### Configuration Tuning

```sql
-- Performance tuning for high-throughput scenarios
UPDATE global_settings SET value = '5' WHERE key = 'S3_MAX_RETRIES';
UPDATE global_settings SET value = '60000' WHERE key = 'S3_REQUEST_TIMEOUT';

-- For development with slower connections
UPDATE global_settings SET value = '120000' WHERE key = 'S3_REQUEST_TIMEOUT';
```

## Troubleshooting

### Common Issues

#### 1. Connection Refused

```
Error: connect ECONNREFUSED 127.0.0.1:9000
```

**Solutions**:

- Ensure MinIO server is running
- Check if port 9000 is accessible
- Verify firewall settings

#### 2. SSL Certificate Issues

```
Error: unable to verify the first certificate
```

**Solutions**:

- Set `S3_REJECT_UNAUTHORIZED` to `false` for development
- Use proper SSL certificates in production
- Configure MinIO with valid certificates

#### 3. Access Denied

```
Error: The AWS Access Key Id you provided does not exist in our records
```

**Solutions**:

- Verify `S3_ACCESS_KEY` and `S3_SECRET_KEY` are correct
- Check MinIO user permissions
- Ensure bucket exists and user has access

#### 4. Bucket Not Found

```
Error: The specified bucket does not exist
```

**Solutions**:

- Create buckets using MinIO console or CLI
- Verify bucket names in configuration
- Check bucket naming conventions

### Debug Mode

Enable debug logging to troubleshoot issues:

```sql
UPDATE global_settings SET value = 'true' WHERE key = 'DEBUG';
```

### Health Check Endpoint

Create a health check endpoint to monitor MinIO status:

```typescript
@Controller('health')
export class HealthController {
  constructor(@Inject(IS3Service) private readonly s3Service: IS3Service) {}

  @Get('minio')
  async checkMinIO() {
    const isConfigured = await this.s3Service.isConfigured();
    const isMinIO = this.s3Service.isMinIOConfigured();
    const isConnected = await this.s3Service.testConnection();
    const info = this.s3Service.getMinIOInfo();

    return {
      status: isConfigured && isConnected ? 'ok' : 'error',
      minio: {
        configured: isConfigured,
        detected: isMinIO,
        connected: isConnected,
        endpoint: info.endpoint,
      },
    };
  }
}
```

## Security Considerations

### Development vs Production

**Development**:

- Use HTTP endpoints for simplicity
- Disable SSL certificate validation
- Use default credentials for quick setup

**Production**:

- Always use HTTPS endpoints
- Enable SSL certificate validation
- Use strong, unique credentials
- Implement proper access policies
- Regular security audits

### Access Control

1. **Bucket Policies**: Configure appropriate read/write permissions
2. **User Management**: Create specific users for different applications
3. **Network Security**: Restrict access to MinIO ports
4. **Encryption**: Enable encryption at rest and in transit

### Best Practices

1. **Credential Management**: Store credentials securely in database
2. **Regular Updates**: Keep MinIO server updated
3. **Monitoring**: Monitor access logs and performance metrics
4. **Backup**: Implement proper backup strategies
5. **Testing**: Regular connectivity and functionality testing

## Migration from AWS S3

### Configuration Changes

When migrating from AWS S3 to MinIO:

1. Update `S3_ENDPOINT` to MinIO server URL
2. Set `S3_FORCE_PATH_STYLE` to `true`
3. Adjust `S3_REJECT_UNAUTHORIZED` based on SSL setup
4. Update access credentials

### Data Migration

Use MinIO's `mc mirror` command for data migration:

```bash
# Mirror from AWS S3 to MinIO
mc mirror s3/my-aws-bucket local/my-minio-bucket

# Sync with delete (be careful!)
mc mirror --remove s3/my-aws-bucket local/my-minio-bucket
```

### Application Changes

The S3 service module handles MinIO compatibility automatically, so minimal application changes are required. The service will:

- Automatically detect MinIO endpoints
- Apply MinIO-specific configurations
- Handle path-style URLs correctly
- Manage SSL certificate validation appropriately

## Monitoring and Metrics

### MinIO Metrics

MinIO provides Prometheus-compatible metrics:

```bash
# Enable metrics in MinIO
mc admin config set local api requests_max=10000
mc admin service restart local
```

### Application Metrics

Monitor S3 service operations:

```typescript
@Injectable()
export class MinIOMetricsService {
  private metrics = {
    uploads: 0,
    downloads: 0,
    errors: 0,
    connectionTests: 0,
  };

  constructor(@Inject(IS3Service) private readonly s3Service: IS3Service) {}

  async uploadWithMetrics(bucket: string, key: string, data: Buffer): Promise<void> {
    try {
      await this.s3Service.putFile(bucket, key, data);
      this.metrics.uploads++;
    } catch (error) {
      this.metrics.errors++;
      throw error;
    }
  }

  async testConnectionWithMetrics(): Promise<boolean> {
    this.metrics.connectionTests++;
    return await this.s3Service.testConnection();
  }

  getMetrics() {
    return {
      ...this.metrics,
      minioInfo: this.s3Service.getMinIOInfo(),
    };
  }
}
```

This comprehensive MinIO integration ensures your S3 service module works seamlessly with MinIO deployments while providing the flexibility to switch between MinIO and AWS S3 as needed.
