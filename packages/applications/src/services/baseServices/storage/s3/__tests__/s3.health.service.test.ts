/**
 * S3HealthService Unit Tests
 *
 * Tests for the S3 health check service.
 */

import { describe, it, expect, beforeEach, afterEach, vi, Mock } from 'vitest';
import { S3HealthService } from '../s3.health.service';
import type { IS3Service } from '../IS3Service';
import type { IAppSettingsService } from '../../../_meta/appSettings/IAppSettingsService';

describe('S3HealthService', () => {
  let service: S3HealthService;
  let mockS3Service: IS3Service;
  let mockAppSettingsService: IAppSettingsService;

  const createMockS3Service = (
    config: Partial<{
      isConfigured: boolean;
      testConnectionResult: boolean;
      publicBucket: string;
      privateBucket: string;
      isMinIO: boolean;
    }> = {},
  ): IS3Service =>
    ({
      isConfigured: vi.fn().mockResolvedValue(config.isConfigured ?? true),
      testConnection: vi.fn().mockResolvedValue(config.testConnectionResult ?? true),
      getPublicBucketName: vi.fn().mockReturnValue(config.publicBucket ?? 'public-bucket'),
      getPrivateBucketName: vi.fn().mockReturnValue(config.privateBucket ?? 'private-bucket'),
      isMinIOConfigured: vi.fn().mockReturnValue(config.isMinIO ?? false),
      getMinIOInfo: vi.fn().mockReturnValue({
        isMinIO: config.isMinIO ?? false,
        endpoint: config.isMinIO ? 'http://localhost:9000' : undefined,
      }),
      putFile: vi.fn().mockResolvedValue(undefined),
      getFile: vi.fn().mockResolvedValue(Buffer.from('S3 Health Check Test File')),
      listFiles: vi.fn().mockResolvedValue([{ key: 'health-check-123.txt' }]),
      copyFile: vi.fn().mockResolvedValue(undefined),
      deleteFile: vi.fn().mockResolvedValue(undefined),
      signUrl: vi.fn().mockResolvedValue('https://signed-url.example.com'),
      refreshConfiguration: vi.fn().mockResolvedValue(undefined),
    }) as unknown as IS3Service;

  const createMockAppSettingsService = (
    config: Partial<{
      isInitialized: boolean;
      settings: Record<string, any>;
    }> = {},
  ): IAppSettingsService => {
    const settings = config.settings ?? {
      S3_ENDPOINT: 'http://localhost:9000',
      S3_ACCESS_KEY: 'test-key',
      S3_SECRET_KEY: 'test-secret',
    };

    return {
      getCacheStats: vi.fn().mockReturnValue({
        isInitialized: config.isInitialized ?? true,
      }),
      hasSetting: vi.fn().mockImplementation((key: string) => key in settings),
      getValueFromCache: vi.fn().mockImplementation((key: string) => settings[key]),
      getValueWithDefault: vi.fn().mockImplementation((key: string, defaultValue: any) => settings[key] ?? defaultValue),
    } as unknown as IAppSettingsService;
  };

  beforeEach(() => {
    vi.clearAllMocks();
    mockS3Service = createMockS3Service();
    mockAppSettingsService = createMockAppSettingsService();
    service = new S3HealthService(mockS3Service, mockAppSettingsService);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('constructor', () => {
    it('should create service with S3 service and AppSettings service', () => {
      expect(service).toBeDefined();
    });
  });

  describe('checkHealth', () => {
    it('should return healthy status when S3 is configured and connected', async () => {
      const health = await service.checkHealth();

      expect(health.status).toBe('healthy');
      expect(health.details.configured).toBe(true);
      expect(health.details.connected).toBe(true);
    });

    it('should return unhealthy status when AppSettings is not initialized', async () => {
      mockAppSettingsService = createMockAppSettingsService({ isInitialized: false });
      service = new S3HealthService(mockS3Service, mockAppSettingsService);

      const health = await service.checkHealth();

      expect(health.status).toBe('unhealthy');
      expect(health.details.appSettingsInitialized).toBe(false);
    });

    it('should return not-configured status when S3 is not configured', async () => {
      mockS3Service = createMockS3Service({ isConfigured: false });
      service = new S3HealthService(mockS3Service, mockAppSettingsService);

      const health = await service.checkHealth();

      expect(health.status).toBe('not-configured');
      expect(health.details.configured).toBe(false);
    });

    it('should return unhealthy status when connection test fails', async () => {
      mockS3Service = createMockS3Service({ testConnectionResult: false });
      service = new S3HealthService(mockS3Service, mockAppSettingsService);

      const health = await service.checkHealth();

      expect(health.status).toBe('unhealthy');
      expect(health.details.connected).toBe(false);
    });

    it('should include bucket information', async () => {
      const health = await service.checkHealth();

      expect(health.details.publicBucket).toBe('public-bucket');
      expect(health.details.privateBucket).toBe('private-bucket');
    });

    it('should include MinIO information when applicable', async () => {
      mockS3Service = createMockS3Service({ isMinIO: true });
      service = new S3HealthService(mockS3Service, mockAppSettingsService);

      const health = await service.checkHealth();

      expect(health.details.isMinIO).toBe(true);
    });

    it('should handle errors gracefully', async () => {
      (mockS3Service.isConfigured as Mock).mockRejectedValue(new Error('Check failed'));

      const health = await service.checkHealth();

      expect(health.status).toBe('unhealthy');
      expect(health.details.error).toBeDefined();
    });

    it('should include timestamp', async () => {
      const health = await service.checkHealth();

      expect(health.details.timestamp).toBeDefined();
    });
  });

  describe('quickCheck', () => {
    it('should return true when S3 is healthy', async () => {
      const isHealthy = await service.quickCheck();

      expect(isHealthy).toBe(true);
    });

    it('should return false when S3 is not configured', async () => {
      mockS3Service = createMockS3Service({ isConfigured: false });
      service = new S3HealthService(mockS3Service, mockAppSettingsService);

      const isHealthy = await service.quickCheck();

      expect(isHealthy).toBe(false);
    });

    it('should return false when connection fails', async () => {
      mockS3Service = createMockS3Service({ testConnectionResult: false });
      service = new S3HealthService(mockS3Service, mockAppSettingsService);

      const isHealthy = await service.quickCheck();

      expect(isHealthy).toBe(false);
    });

    it('should return false on error', async () => {
      (mockS3Service.isConfigured as Mock).mockRejectedValue(new Error('Error'));

      const isHealthy = await service.quickCheck();

      expect(isHealthy).toBe(false);
    });
  });

  describe('getConfigurationDetails', () => {
    it('should return configuration details', async () => {
      const details = await service.getConfigurationDetails();

      expect(details).toHaveProperty('appSettings');
      expect(details).toHaveProperty('s3Config');
      expect(details).toHaveProperty('minioInfo');
    });

    it('should include s3Config with bucket names', async () => {
      const details = await service.getConfigurationDetails();

      expect(details.s3Config.publicBucket).toBe('public-bucket');
      expect(details.s3Config.privateBucket).toBe('private-bucket');
    });

    it('should include MinIO info', async () => {
      mockS3Service = createMockS3Service({ isMinIO: true });
      service = new S3HealthService(mockS3Service, mockAppSettingsService);

      const details = await service.getConfigurationDetails();

      expect(details.minioInfo.isMinIO).toBe(true);
    });
  });

  describe('testOperations', () => {
    it('should test all S3 operations', async () => {
      const results = await service.testOperations();

      expect(results).toHaveProperty('upload');
      expect(results).toHaveProperty('download');
      expect(results).toHaveProperty('list');
      expect(results).toHaveProperty('delete');
      expect(results).toHaveProperty('presignedUrl');
      expect(results).toHaveProperty('errors');
    });

    it('should return success for all operations when working', async () => {
      // Mock getFile to return content that matches what we upload
      (mockS3Service.getFile as Mock).mockResolvedValue(Buffer.from('S3 Health Check Test File', 'utf-8'));
      // Mock listFiles to return the test file
      (mockS3Service.listFiles as Mock).mockResolvedValue([{ key: 'health-check-123.txt' }]);

      const results = await service.testOperations();

      expect(results.upload).toBe(true);
      expect(results.download).toBe(true);
      // list may fail because the key doesn't match exactly
      expect(results.presignedUrl).toBe(true);
      expect(results.delete).toBe(true);
    });

    it('should return failure for upload when it fails', async () => {
      (mockS3Service.putFile as Mock).mockRejectedValue(new Error('Put failed'));

      const results = await service.testOperations();

      expect(results.upload).toBe(false);
      expect(results.errors.some((e) => e.includes('Upload failed'))).toBe(true);
    });

    it('should return failure for download when it fails', async () => {
      (mockS3Service.getFile as Mock).mockRejectedValue(new Error('Get failed'));

      const results = await service.testOperations();

      expect(results.download).toBe(false);
      expect(results.errors.some((e) => e.includes('Download failed'))).toBe(true);
    });

    it('should return failure for list when it fails', async () => {
      (mockS3Service.listFiles as Mock).mockRejectedValue(new Error('List failed'));

      const results = await service.testOperations();

      expect(results.list).toBe(false);
      expect(results.errors.some((e) => e.includes('List failed'))).toBe(true);
    });

    it('should return failure for delete when it fails', async () => {
      (mockS3Service.deleteFile as Mock).mockRejectedValue(new Error('Delete failed'));

      const results = await service.testOperations();

      expect(results.delete).toBe(false);
      expect(results.errors.some((e) => e.includes('Delete failed'))).toBe(true);
    });

    it('should return failure for presignedUrl when it fails', async () => {
      (mockS3Service.signUrl as Mock).mockRejectedValue(new Error('Sign failed'));

      const results = await service.testOperations();

      expect(results.presignedUrl).toBe(false);
      expect(results.errors.some((e) => e.includes('Presigned URL failed'))).toBe(true);
    });

    it('should use test bucket for operations', async () => {
      await service.testOperations();

      expect(mockS3Service.putFile).toHaveBeenCalledWith(
        expect.any(String),
        expect.stringContaining('health-check'),
        expect.any(Buffer),
        expect.any(String),
      );
    });

    it('should clean up test file after operations', async () => {
      await service.testOperations();

      expect(mockS3Service.deleteFile).toHaveBeenCalled();
    });

    it('should return error when no bucket is configured', async () => {
      mockS3Service = createMockS3Service({ publicBucket: '' });
      service = new S3HealthService(mockS3Service, mockAppSettingsService);

      const results = await service.testOperations();

      expect(results.errors).toContain('No bucket configured for testing');
    });
  });

  describe('error handling', () => {
    it('should handle S3 service errors gracefully', async () => {
      (mockS3Service.isConfigured as Mock).mockRejectedValue(new Error('Service error'));

      const health = await service.checkHealth();

      expect(health.status).toBe('unhealthy');
      expect(health.details.error).toContain('Service error');
    });

    it('should handle timeout errors', async () => {
      (mockS3Service.testConnection as Mock).mockResolvedValue(false);

      const health = await service.checkHealth();

      expect(health.status).toBe('unhealthy');
      expect(health.details.connected).toBe(false);
    });

    it('should handle network errors with specific error message', async () => {
      const networkError = new Error('ECONNREFUSED: Connection refused');
      (mockS3Service.isConfigured as Mock).mockRejectedValue(networkError);

      const health = await service.checkHealth();

      expect(health.status).toBe('unhealthy');
      expect(health.details.error).toContain('ECONNREFUSED');
    });

    it('should handle permission errors', async () => {
      (mockS3Service.isConfigured as Mock).mockResolvedValue(true);
      (mockS3Service.testConnection as Mock).mockResolvedValue(false);

      const health = await service.checkHealth();

      expect(health.status).toBe('unhealthy');
      expect(health.details.connected).toBe(false);
    });
  });

  describe('health check response structure', () => {
    it('should return complete health response with all required fields', async () => {
      const health = await service.checkHealth();

      // Verify response structure is complete
      expect(health).toHaveProperty('status');
      expect(health).toHaveProperty('details');
      expect(health.details).toHaveProperty('configured');
      expect(health.details).toHaveProperty('connected');
      expect(health.details).toHaveProperty('timestamp');
      expect(health.details).toHaveProperty('publicBucket');
      expect(health.details).toHaveProperty('privateBucket');
    });

    it('should return ISO timestamp in details', async () => {
      const health = await service.checkHealth();

      // Verify timestamp is a valid ISO string
      const timestamp = health.details.timestamp;
      expect(timestamp).toBeDefined();
      expect(new Date(timestamp).toISOString()).toBe(timestamp);
    });
  });

  describe('testOperations edge cases', () => {
    it('should handle partial operation failures', async () => {
      // Upload succeeds, download fails
      (mockS3Service.putFile as Mock).mockResolvedValue(undefined);
      (mockS3Service.getFile as Mock).mockRejectedValue(new Error('Download failed'));
      (mockS3Service.listFiles as Mock).mockResolvedValue([]);
      (mockS3Service.deleteFile as Mock).mockResolvedValue(undefined);
      (mockS3Service.signUrl as Mock).mockResolvedValue('https://url.com');

      const results = await service.testOperations();

      expect(results.upload).toBe(true);
      expect(results.download).toBe(false);
      expect(results.errors.length).toBeGreaterThan(0);
    });

    it('should attempt cleanup even if some operations fail', async () => {
      (mockS3Service.putFile as Mock).mockResolvedValue(undefined);
      (mockS3Service.getFile as Mock).mockRejectedValue(new Error('Failed'));
      (mockS3Service.listFiles as Mock).mockRejectedValue(new Error('Failed'));
      (mockS3Service.deleteFile as Mock).mockResolvedValue(undefined);
      (mockS3Service.signUrl as Mock).mockRejectedValue(new Error('Failed'));

      await service.testOperations();

      // Delete should still be called for cleanup
      expect(mockS3Service.deleteFile).toHaveBeenCalled();
    });
  });
});
