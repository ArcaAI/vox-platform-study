import { Inject, Injectable, Logger } from '@nestjs/common';
import { IS3Service } from './IS3Service';
import { IAppSettingsService } from '../../_meta/appSettings/IAppSettingsService';

export interface S3HealthStatus {
  status: 'healthy' | 'unhealthy' | 'not-configured';
  details: {
    configured: boolean;
    appSettingsInitialized: boolean;
    connected?: boolean;
    isMinIO?: boolean;
    endpoint?: string;
    publicBucket?: string;
    privateBucket?: string;
    configurationKeys?: {
      present: string[];
      missing: string[];
    };
    error?: string;
    timestamp: string;
  };
}

/**
 * Health check service for S3 storage functionality.
 *
 * Provides comprehensive health monitoring including:
 * - Configuration validation
 * - Connectivity testing
 * - MinIO detection
 * - Bucket availability
 */
@Injectable()
export class S3HealthService {
  private readonly logger = new Logger(S3HealthService.name);

  constructor(
    @Inject(IS3Service) private readonly s3Service: IS3Service,
    @Inject(IAppSettingsService) private readonly appSettingsService: IAppSettingsService,
  ) {}

  /**
   * Perform comprehensive S3 health check
   */
  async checkHealth(): Promise<S3HealthStatus> {
    const timestamp = new Date().toISOString();

    try {
      // Check if AppSettings is initialized
      const appSettingsStats = this.appSettingsService.getCacheStats();
      if (!appSettingsStats.isInitialized) {
        return {
          status: 'unhealthy',
          details: {
            configured: false,
            appSettingsInitialized: false,
            error: 'AppSettings service is not initialized',
            timestamp,
          },
        };
      }

      // Check configuration
      const configCheck = this.checkConfiguration();
      const isConfigured = await this.s3Service.isConfigured();

      if (!isConfigured) {
        return {
          status: 'not-configured',
          details: {
            configured: false,
            appSettingsInitialized: true,
            configurationKeys: configCheck,
            error: 'S3 service is not configured - missing required settings',
            timestamp,
          },
        };
      }

      // Test connectivity
      const isConnected = await this.s3Service.testConnection();
      const isMinIO = this.s3Service.isMinIOConfigured();
      const minioInfo = this.s3Service.getMinIOInfo();

      const status = isConnected ? 'healthy' : 'unhealthy';

      return {
        status,
        details: {
          configured: true,
          appSettingsInitialized: true,
          connected: isConnected,
          isMinIO,
          endpoint: minioInfo.endpoint,
          publicBucket: this.s3Service.getPublicBucketName(),
          privateBucket: this.s3Service.getPrivateBucketName(),
          configurationKeys: configCheck,
          ...(status === 'unhealthy' && {
            error: 'S3 service is configured but connection test failed',
          }),
          timestamp,
        },
      };
    } catch (error) {
      this.logger.error('S3 health check failed:', error);
      return {
        status: 'unhealthy',
        details: {
          configured: false,
          appSettingsInitialized: this.appSettingsService.getCacheStats().isInitialized,
          error: error instanceof Error ? error.message : String(error),
          timestamp,
        },
      };
    }
  }

  /**
   * Quick health check - just configuration and basic connectivity
   */
  async quickCheck(): Promise<boolean> {
    try {
      const isConfigured = await this.s3Service.isConfigured();
      if (!isConfigured) {
        return false;
      }

      return await this.s3Service.testConnection();
    } catch {
      return false;
    }
  }

  /**
   * Check which configuration keys are present/missing
   */
  private checkConfiguration(): { present: string[]; missing: string[] } {
    const requiredKeys = ['S3_ENDPOINT', 'S3_ACCESS_KEY', 'S3_SECRET_KEY'];
    const optionalKeys = [
      'S3_REGION',
      'S3_PUBLIC_BUCKET',
      'S3_PRIVATE_BUCKET',
      'S3_FORCE_PATH_STYLE',
      'S3_REJECT_UNAUTHORIZED',
      'S3_PRESIGNED_URL_EXPIRY',
      'S3_MAX_RETRIES',
      'S3_REQUEST_TIMEOUT',
    ];

    const allKeys = [...requiredKeys, ...optionalKeys];
    const present: string[] = [];
    const missing: string[] = [];

    for (const key of allKeys) {
      if (this.appSettingsService.hasSetting(key)) {
        const value = this.appSettingsService.getValueFromCache(key);
        if (value !== null && value !== undefined && value !== '') {
          present.push(key);
        } else {
          missing.push(key);
        }
      } else {
        missing.push(key);
      }
    }

    return { present, missing };
  }

  /**
   * Get detailed configuration information for debugging
   */
  async getConfigurationDetails(): Promise<{
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    appSettings: any;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    s3Config: any;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    minioInfo: any;
  }> {
    try {
      const appSettingsStats = this.appSettingsService.getCacheStats();
      const configCheck = this.checkConfiguration();
      const minioInfo = this.s3Service.getMinIOInfo();

      return {
        appSettings: {
          ...appSettingsStats,
          configurationKeys: configCheck,
        },
        s3Config: {
          configured: await this.s3Service.isConfigured(),
          publicBucket: this.s3Service.getPublicBucketName(),
          privateBucket: this.s3Service.getPrivateBucketName(),
        },
        minioInfo,
      };
    } catch (error) {
      throw new Error(`Failed to get configuration details: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /**
   * Test specific S3 operations
   */
  async testOperations(bucketName?: string): Promise<{
    upload: boolean;
    download: boolean;
    list: boolean;
    delete: boolean;
    presignedUrl: boolean;
    errors: string[];
  }> {
    const testBucket = bucketName || this.s3Service.getPublicBucketName();
    const testKey = `health-check-${Date.now()}.txt`;
    const testContent = Buffer.from('S3 Health Check Test File', 'utf-8');
    const errors: string[] = [];

    const results = {
      upload: false,
      download: false,
      list: false,
      delete: false,
      presignedUrl: false,
      errors,
    };

    if (!testBucket) {
      errors.push('No bucket configured for testing');
      return results;
    }

    try {
      // Test upload
      await this.s3Service.putFile(testBucket, testKey, testContent, 'text/plain');
      results.upload = true;
    } catch (error) {
      errors.push(`Upload failed: ${error instanceof Error ? error.message : String(error)}`);
    }

    if (results.upload) {
      try {
        // Test download
        const downloaded = await this.s3Service.getFile(testBucket, testKey);
        results.download = downloaded.equals(testContent);
        if (!results.download) {
          errors.push('Downloaded content does not match uploaded content');
        }
      } catch (error) {
        errors.push(`Download failed: ${error instanceof Error ? error.message : String(error)}`);
      }

      try {
        // Test list
        const files = await this.s3Service.listFiles(testBucket, testKey.substring(0, testKey.lastIndexOf('-')));
        results.list = files.some((file) => file.key === testKey);
        if (!results.list) {
          errors.push('Uploaded file not found in list operation');
        }
      } catch (error) {
        errors.push(`List failed: ${error instanceof Error ? error.message : String(error)}`);
      }

      try {
        // Test presigned URL
        const url = await this.s3Service.signUrl(testBucket, testKey, 'get');
        results.presignedUrl = url.length > 0 && url.startsWith('http');
        if (!results.presignedUrl) {
          errors.push('Invalid presigned URL generated');
        }
      } catch (error) {
        errors.push(`Presigned URL failed: ${error instanceof Error ? error.message : String(error)}`);
      }

      try {
        // Test delete (cleanup)
        await this.s3Service.deleteFile(testBucket, testKey);
        results.delete = true;
      } catch (error) {
        errors.push(`Delete failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    }

    return results;
  }
}
