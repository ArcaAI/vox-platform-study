/**
 * MinIO Integration Example
 *
 * This example demonstrates how to use the S3 service with MinIO.
 * Make sure to configure your database with the required settings first.
 */

import { Injectable, Logger } from '@nestjs/common';
import { IS3Service } from '../IS3Service';

@Injectable()
export class MinIOExampleService {
  private readonly logger = new Logger(MinIOExampleService.name);

  constructor(private readonly s3Service: IS3Service) {}

  /**
   * Complete MinIO setup and testing example
   */
  async runMinIOExample(): Promise<void> {
    try {
      // 1. Check if MinIO is configured
      this.logger.log('=== MinIO Configuration Check ===');
      const isConfigured = await this.s3Service.isConfigured();
      const isMinIO = this.s3Service.isMinIOConfigured();
      const minioInfo = this.s3Service.getMinIOInfo();

      this.logger.log(`S3 Configured: ${isConfigured}`);
      this.logger.log(`MinIO Detected: ${isMinIO}`);
      this.logger.log(`MinIO Info:`, minioInfo);

      if (!isConfigured) {
        throw new Error('S3/MinIO is not configured. Please set up the database configuration first.');
      }

      // 2. Test connection
      this.logger.log('=== Connection Test ===');
      const isConnected = await this.s3Service.testConnection();
      this.logger.log(`Connection Status: ${isConnected ? 'SUCCESS' : 'FAILED'}`);

      if (!isConnected) {
        throw new Error('Cannot connect to MinIO server. Please check your configuration and ensure MinIO is running.');
      }

      // 3. Get bucket names
      this.logger.log('=== Bucket Configuration ===');
      const publicBucket = this.s3Service.getPublicBucketName();
      const privateBucket = this.s3Service.getPrivateBucketName();
      this.logger.log(`Public Bucket: ${publicBucket || 'Not configured'}`);
      this.logger.log(`Private Bucket: ${privateBucket || 'Not configured'}`);

      // 4. File operations example
      if (publicBucket) {
        await this.demonstrateFileOperations(publicBucket);
      } else {
        this.logger.warn('No public bucket configured, skipping file operations demo');
      }

      this.logger.log('=== MinIO Example Completed Successfully ===');
    } catch (error) {
      this.logger.error('MinIO Example Failed:', error);
      throw error;
    }
  }

  /**
   * Demonstrate basic file operations
   */
  private async demonstrateFileOperations(bucketName: string): Promise<void> {
    this.logger.log('=== File Operations Demo ===');

    const testFileName = 'test-file.txt';
    const testContent = Buffer.from('Hello MinIO! This is a test file.', 'utf-8');

    try {
      // Upload file
      this.logger.log(`Uploading file: ${testFileName}`);
      await this.s3Service.putFile(bucketName, testFileName, testContent, 'text/plain');
      this.logger.log('✓ File uploaded successfully');

      // Download file
      this.logger.log(`Downloading file: ${testFileName}`);
      const downloadedContent = await this.s3Service.getFile(bucketName, testFileName);
      this.logger.log(`✓ File downloaded, size: ${downloadedContent.length} bytes`);
      this.logger.log(`Content: ${downloadedContent.toString('utf-8')}`);

      // Generate presigned URL
      this.logger.log('Generating presigned URL...');
      const presignedUrl = await this.s3Service.signUrl(bucketName, testFileName, 'get');
      this.logger.log(`✓ Presigned URL: ${presignedUrl}`);

      // List files
      this.logger.log('Listing files...');
      const files = await this.s3Service.listFiles(bucketName, '');
      this.logger.log(`✓ Found ${files.length} files in bucket`);
      files.forEach((file) => {
        this.logger.log(`  - ${file.key} (${file.size} bytes)`);
      });

      // Copy file
      const copiedFileName = 'copied-test-file.txt';
      this.logger.log(`Copying file to: ${copiedFileName}`);
      await this.s3Service.copyFile(bucketName, copiedFileName, `${bucketName}/${testFileName}`);
      this.logger.log('✓ File copied successfully');

      // Clean up - delete files
      this.logger.log('Cleaning up test files...');
      await this.s3Service.deleteFile(bucketName, testFileName);
      await this.s3Service.deleteFile(bucketName, copiedFileName);
      this.logger.log('✓ Test files deleted');
    } catch (error) {
      this.logger.error('File operations failed:', error);
      throw error;
    }
  }

  /**
   * Health check example for monitoring
   */
  async checkMinIOHealth(): Promise<{
    status: 'healthy' | 'unhealthy';
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
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
          timestamp: new Date().toISOString(),
        },
      };
    } catch (error) {
      return {
        status: 'unhealthy',
        details: {
          error: error instanceof Error ? error.message : String(error),
          timestamp: new Date().toISOString(),
        },
      };
    }
  }

  /**
   * Configuration refresh example
   */
  async refreshMinIOConfiguration(): Promise<void> {
    this.logger.log('Refreshing MinIO configuration...');

    try {
      await this.s3Service.refreshConfiguration();
      this.logger.log('✓ Configuration refreshed successfully');

      // Test the new configuration
      const isConnected = await this.s3Service.testConnection();
      this.logger.log(`New configuration test: ${isConnected ? 'SUCCESS' : 'FAILED'}`);
    } catch (error) {
      this.logger.error('Configuration refresh failed:', error);
      throw error;
    }
  }
}

/**
 * Database setup SQL for MinIO configuration
 * Run these commands in your database to configure MinIO:
 */
export const MINIO_SETUP_SQL = `
-- Required MinIO configuration
INSERT INTO global_settings (key, value, description) VALUES
('S3_ENDPOINT', 'http://localhost:9000', 'MinIO server endpoint'),
('S3_ACCESS_KEY', 'minioadmin', 'MinIO access key'),
('S3_SECRET_KEY', 'minioadmin', 'MinIO secret key');

-- JWT Authentication settings (required for auth services)
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

-- Optional MinIO configuration
INSERT INTO global_settings (key, value, description) VALUES
('S3_REGION', 'us-east-1', 'MinIO region'),
('S3_FORCE_PATH_STYLE', 'true', 'Required for MinIO compatibility'),
('S3_REJECT_UNAUTHORIZED', 'false', 'Allow self-signed certificates'),
('S3_PUBLIC_BUCKET', 'public-files', 'Default public bucket'),
('S3_PRIVATE_BUCKET', 'private-files', 'Default private bucket'),
('S3_MAX_RETRIES', '3', 'Connection retry attempts'),
('S3_REQUEST_TIMEOUT', '30000', 'Request timeout in milliseconds'),
('S3_PRESIGNED_URL_EXPIRY', '3600', 'Presigned URL expiry seconds');
`;

/**
 * Docker Compose configuration for MinIO
 */
export const MINIO_DOCKER_COMPOSE = `
version: '3.8'
services:
  minio:
    image: minio/minio:latest
    container_name: minio
    ports:
      - "9000:9000"
      - "9001:9001"
    environment:
      MINIO_ROOT_USER: minioadmin
      MINIO_ROOT_PASSWORD: minioadmin
    command: server /data --console-address ":9001"
    volumes:
      - minio_data:/data
    healthcheck:
      test: ["CMD", "curl", "-f", "http://localhost:9000/minio/health/live"]
      interval: 30s
      timeout: 20s
      retries: 3

volumes:
  minio_data:
`;

/**
 * Usage instructions
 */
export const USAGE_INSTRUCTIONS = `
MinIO Integration Usage Instructions:

1. Start MinIO server:
   docker-compose up -d minio

2. Configure database settings:
   Execute the SQL commands in MINIO_SETUP_SQL

3. Create buckets (via MinIO console at http://localhost:9001):
   - Login with minioadmin/minioadmin
   - Create 'public-files' and 'private-files' buckets

4. Use the service:
   const example = new MinIOExampleService(s3Service);
   await example.runMinIOExample();

5. Monitor health:
   const health = await example.checkMinIOHealth();
   console.log(health);
`;
