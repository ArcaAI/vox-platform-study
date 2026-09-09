/**
 * S3 Service Usage Example
 *
 * This example demonstrates how to properly use the improved S3 service
 * with AppSettings integration and health monitoring.
 */

import { Injectable, Logger } from '@nestjs/common';
import { IS3Service, S3HealthService, S3HealthStatus } from '../';

@Injectable()
export class S3UsageExampleService {
  private readonly logger = new Logger(S3UsageExampleService.name);

  constructor(
    private readonly s3Service: IS3Service,
    private readonly s3HealthService: S3HealthService,
  ) {}

  /**
   * Complete example of S3 service usage with proper error handling
   */
  async demonstrateS3Usage(): Promise<void> {
    try {
      // 1. Check S3 health before using the service
      this.logger.log('=== S3 Health Check ===');
      const healthStatus = await this.s3HealthService.checkHealth();
      this.logHealthStatus(healthStatus);

      if (healthStatus.status !== 'healthy') {
        this.logger.error('S3 service is not healthy, aborting operations');
        return;
      }

      // 2. Verify configuration
      this.logger.log('=== Configuration Check ===');
      const isConfigured = await this.s3Service.isConfigured();
      this.logger.log(`S3 Configured: ${isConfigured}`);

      if (!isConfigured) {
        this.logger.error('S3 service is not configured');
        return;
      }

      // 3. Name the bucket to exercise. TASK-932 OD-8 retired the legacy
      // S3_PUBLIC_BUCKET/S3_PRIVATE_BUCKET platform-default pair — a real
      // integration names its own bucket rather than relying on one.
      const exampleBucket = 'my-app-bucket';

      // 4. Test connectivity
      this.logger.log('=== Connectivity Test ===');
      const isConnected = await this.s3Service.testConnection();
      this.logger.log(`Connection Status: ${isConnected ? 'SUCCESS' : 'FAILED'}`);

      if (!isConnected) {
        this.logger.error('Cannot connect to S3 service');
        return;
      }

      // 5. Perform file operations
      await this.demonstrateFileOperations(exampleBucket);

      // 6. Test all operations comprehensively
      await this.runOperationTests(exampleBucket);

      this.logger.log('=== S3 Usage Example Completed Successfully ===');
    } catch (error) {
      this.logger.error('S3 Usage Example Failed:', error);
      throw error;
    }
  }

  /**
   * Demonstrate basic file operations with error handling
   */
  private async demonstrateFileOperations(bucketName: string): Promise<void> {
    this.logger.log('=== File Operations Demo ===');

    const testFileName = `example-${Date.now()}.txt`;
    const testContent = Buffer.from('Hello S3! This is a test file from the usage example.', 'utf-8');

    try {
      // Upload file
      this.logger.log(`Uploading file: ${testFileName}`);
      await this.s3Service.putFile(bucketName, testFileName, testContent, 'text/plain');
      this.logger.log('✓ File uploaded successfully');

      // Download file
      this.logger.log(`Downloading file: ${testFileName}`);
      const downloadedContent = await this.s3Service.getFile(bucketName, testFileName);
      this.logger.log(`✓ File downloaded, size: ${downloadedContent.length} bytes`);

      // Verify content
      if (downloadedContent.equals(testContent)) {
        this.logger.log('✓ Downloaded content matches uploaded content');
      } else {
        this.logger.error('✗ Downloaded content does not match uploaded content');
      }

      // Generate presigned URL
      this.logger.log('Generating presigned URL...');
      const presignedUrl = await this.s3Service.signUrl(bucketName, testFileName, 'get');
      this.logger.log(`✓ Presigned URL: ${presignedUrl.substring(0, 100)}...`);

      // List files
      this.logger.log('Listing files...');
      const files = await this.s3Service.listFiles(bucketName, '');
      this.logger.log(`✓ Found ${files.length} files in bucket`);

      // Show recent files
      const recentFiles = files.filter((file) => file.key.includes('example-')).slice(-3);
      recentFiles.forEach((file) => {
        this.logger.log(`  - ${file.key} (${file.size} bytes)`);
      });

      // Copy file
      const copiedFileName = `copied-${testFileName}`;
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
   * Run comprehensive operation tests using the health service
   */
  private async runOperationTests(bucketName: string): Promise<void> {
    this.logger.log('=== Comprehensive Operation Tests ===');

    try {
      const testResults = await this.s3HealthService.testOperations(bucketName);

      this.logger.log('Test Results:');
      this.logger.log(`  Upload: ${testResults.upload ? '✓' : '✗'}`);
      this.logger.log(`  Download: ${testResults.download ? '✓' : '✗'}`);
      this.logger.log(`  List: ${testResults.list ? '✓' : '✗'}`);
      this.logger.log(`  Delete: ${testResults.delete ? '✓' : '✗'}`);
      this.logger.log(`  Presigned URL: ${testResults.presignedUrl ? '✓' : '✗'}`);

      if (testResults.errors.length > 0) {
        this.logger.error('Test Errors:');
        testResults.errors.forEach((error) => {
          this.logger.error(`  - ${error}`);
        });
      } else {
        this.logger.log('✓ All operation tests passed');
      }
    } catch (error) {
      this.logger.error('Operation tests failed:', error);
    }
  }

  /**
   * Example of handling configuration changes at runtime
   */
  async handleConfigurationChange(): Promise<void> {
    this.logger.log('=== Configuration Refresh Example ===');

    try {
      // Refresh configuration
      await this.s3Service.refreshConfiguration();
      this.logger.log('✓ Configuration refreshed');

      // Check new status
      const healthStatus = await this.s3HealthService.checkHealth();
      this.logHealthStatus(healthStatus);
    } catch (error) {
      this.logger.error('Configuration refresh failed:', error);
    }
  }

  /**
   * Example of monitoring S3 service health
   */
  async monitorS3Health(): Promise<void> {
    this.logger.log('=== S3 Health Monitoring ===');

    try {
      // Quick health check
      const isHealthy = await this.s3HealthService.quickCheck();
      this.logger.log(`Quick Health Check: ${isHealthy ? 'HEALTHY' : 'UNHEALTHY'}`);

      // Detailed health check
      const detailedHealth = await this.s3HealthService.checkHealth();
      this.logHealthStatus(detailedHealth);

      // Configuration details
      const configDetails = await this.s3HealthService.getConfigurationDetails();
      this.logger.log('Configuration Details:', JSON.stringify(configDetails, null, 2));
    } catch (error) {
      this.logger.error('Health monitoring failed:', error);
    }
  }

  /**
   * Helper method to log health status in a readable format
   */
  private logHealthStatus(healthStatus: S3HealthStatus): void {
    this.logger.log(`Health Status: ${healthStatus.status.toUpperCase()}`);
    this.logger.log('Details:');
    this.logger.log(`  App Settings Initialized: ${healthStatus.details.appSettingsInitialized}`);
    this.logger.log(`  S3 Configured: ${healthStatus.details.configured}`);

    if (healthStatus.details.connected !== undefined) {
      this.logger.log(`  Connected: ${healthStatus.details.connected}`);
    }

    if (healthStatus.details.isMinIO !== undefined) {
      this.logger.log(`  MinIO Detected: ${healthStatus.details.isMinIO}`);
    }

    if (healthStatus.details.endpoint) {
      this.logger.log(`  Endpoint: ${healthStatus.details.endpoint}`);
    }

    if (healthStatus.details.publicBucket) {
      this.logger.log(`  Public Bucket: ${healthStatus.details.publicBucket}`);
    }

    if (healthStatus.details.privateBucket) {
      this.logger.log(`  Private Bucket: ${healthStatus.details.privateBucket}`);
    }

    if (healthStatus.details.configurationKeys) {
      this.logger.log(`  Config Keys Present: ${healthStatus.details.configurationKeys.present.length}`);
      this.logger.log(`  Config Keys Missing: ${healthStatus.details.configurationKeys.missing.length}`);
    }

    if (healthStatus.details.error) {
      this.logger.error(`  Error: ${healthStatus.details.error}`);
    }
  }

  /**
   * Example of graceful error handling when S3 is not available
   */
  async handleS3Unavailable(): Promise<void> {
    this.logger.log('=== Graceful Error Handling Example ===');

    try {
      const isConfigured = await this.s3Service.isConfigured();

      if (!isConfigured) {
        this.logger.warn('S3 is not configured, implementing fallback behavior');
        // Implement fallback logic here
        // For example: store files locally, queue for later upload, etc.
        return;
      }

      const isConnected = await this.s3Service.testConnection();

      if (!isConnected) {
        this.logger.warn('S3 is configured but not reachable, implementing fallback behavior');
        // Implement fallback logic here
        // For example: retry with exponential backoff, use local storage, etc.
        return;
      }

      this.logger.log('S3 is available and ready for operations');
    } catch (error) {
      this.logger.error('Error checking S3 availability:', error);
      // Implement error handling logic here
    }
  }
}
