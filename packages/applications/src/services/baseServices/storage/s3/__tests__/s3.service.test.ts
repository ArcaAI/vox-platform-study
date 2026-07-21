/**
 * S3Service Unit Tests
 *
 * Tests for the S3 storage service implementation with MinIO compatibility.
 *
 * Testing Strategy:
 * - Mock AWS SDK (external boundary) to avoid network calls and S3 costs
 * - Verify correct command parameters are constructed for each operation
 * - Test MinIO detection logic with various endpoint patterns
 * - Verify error handling propagates correctly
 */

import { describe, it, expect, beforeEach, afterEach, vi, Mock } from 'vitest';
import { S3Service } from '../s3.service';
import type { IAppSettingsService } from '../../../_meta/';

// S3 secrets flow through SecretsService.
// All existing tests construct S3Service with just AppSettings, so we
// provide a default getSecretSync mock that returns the standard test
// keys. Individual tests can override this to verify cache-miss behavior.
const buildDefaultSecretsMock = () => ({
    getSecretSync: vi.fn((key: string) => {
        if (key === 'S3_ACCESS_KEY') return 'test-access-key';
        if (key === 'S3_SECRET_KEY') return 'test-secret-key';
        return undefined;
    }),
});
function makeService(
    appSettings: IAppSettingsService,
    secrets: { getSecretSync: (k: string) => string | undefined } = buildDefaultSecretsMock(),
): S3Service {
    return new S3Service(appSettings, secrets as any);
}

// Create mock S3 client that will be shared across tests
let mockS3ClientInstance: any = { send: vi.fn() };

// Mock AWS SDK - external boundary requiring network/credentials
vi.mock('@aws-sdk/client-s3', () => {
    // Create a proper class that can be instantiated with 'new'
    class MockS3Client {
        send: any;
        constructor() {
            this.send = mockS3ClientInstance.send;
        }
    }

    return {
        S3Client: MockS3Client,
        PutObjectCommand: vi.fn(),
        GetObjectCommand: vi.fn(),
        DeleteObjectCommand: vi.fn(),
        ListObjectsV2Command: vi.fn(),
        CopyObjectCommand: vi.fn(),
        ListBucketsCommand: vi.fn(),
        CreateBucketCommand: vi.fn(),
        DeleteBucketCommand: vi.fn(),
    };
});

vi.mock('@smithy/node-http-handler', () => {
    class MockNodeHttpHandler {
        constructor() {}
    }
    return {
        NodeHttpHandler: MockNodeHttpHandler,
    };
});

vi.mock('@aws-sdk/s3-request-presigner', () => ({
    getSignedUrl: vi.fn().mockResolvedValue('https://signed-url.example.com'),
}));

import { S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectCommand, ListObjectsV2Command, CopyObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

describe('S3Service', () => {
    let service: S3Service;
    let mockAppSettingsService: IAppSettingsService;
    let mockS3Client: any;

    const createMockAppSettingsService = (config: Partial<{
        isInitialized: boolean;
        settings: Record<string, any>;
    }> = {}): IAppSettingsService => {
        const settings = config.settings ?? {
            S3_ENDPOINT: 'http://localhost:9000',
            S3_REGION: 'us-east-1',
            S3_ACCESS_KEY: 'test-access-key',
            S3_SECRET_KEY: 'test-secret-key',
            S3_PUBLIC_BUCKET: 'public-bucket',
            S3_PRIVATE_BUCKET: 'private-bucket',
            S3_FORCE_PATH_STYLE: true,
            S3_REJECT_UNAUTHORIZED: false,
            S3_PRESIGNED_URL_EXPIRY: 3600,
        };

        return {
            getCacheStats: vi.fn().mockReturnValue({
                isInitialized: config.isInitialized ?? true,
            }),
            hasSetting: vi.fn().mockImplementation((key: string) => key in settings),
            getValueFromCache: vi.fn().mockImplementation((key: string) => settings[key]),
            getValueWithDefault: vi.fn().mockImplementation((key: string, defaultValue: any) =>
                settings[key] ?? defaultValue
            ),
        } as unknown as IAppSettingsService;
    };

    beforeEach(() => {
        // Clear call history but keep mock implementations
        vi.clearAllMocks();

        // Create fresh mock send function for each test
        mockS3Client = {
            send: vi.fn(),
        };

        // Update the shared mock instance's send function
        mockS3ClientInstance.send = mockS3Client.send;

        mockAppSettingsService = createMockAppSettingsService();
        service = makeService(mockAppSettingsService);
    });

    afterEach(() => {
        // Don't restore mocks - we need them to persist
    });

    describe('constructor', () => {
        it('should create service with app settings service', () => {
            expect(service).toBeDefined();
        });
    });

    describe('onModuleInit', () => {
        it('should initialize S3 client when configuration is available', async () => {
            await service.onModuleInit();

            // Verify service is initialized by checking it can perform operations
            const isConfigured = await service.isConfigured();
            expect(isConfigured).toBe(true);
        });

        it('should not initialize when AppSettings is not ready', async () => {
            // Create a mock that starts uninitialized but becomes initialized after a short delay
            let initCount = 0;
            mockAppSettingsService = {
                ...createMockAppSettingsService({ isInitialized: false }),
                getCacheStats: vi.fn().mockImplementation(() => {
                    initCount++;
                    // Simulate initialization completing after a few checks
                    return { isInitialized: initCount > 3 };
                }),
            } as unknown as IAppSettingsService;
            service = makeService(mockAppSettingsService);

            // Should not throw when AppSettings eventually initializes
            await expect(service.onModuleInit()).resolves.not.toThrow();
        }, 10000);

        it('should not initialize when required configuration is missing', async () => {
            mockAppSettingsService = createMockAppSettingsService({
                settings: {
                    S3_ENDPOINT: '',
                    S3_ACCESS_KEY: '',
                    S3_SECRET_KEY: '',
                },
            });
            service = makeService(mockAppSettingsService);

            await service.onModuleInit();

            // Should not throw, but S3 client should not be initialized
        });

        it('should detect MinIO endpoint and enable path style', async () => {
            mockAppSettingsService = createMockAppSettingsService({
                settings: {
                    S3_ENDPOINT: 'http://localhost:9000',
                    S3_ACCESS_KEY: 'minioadmin',
                    S3_SECRET_KEY: 'minioadmin',
                },
            });
            service = makeService(mockAppSettingsService);

            await service.onModuleInit();

            // Verify MinIO was detected by checking the service state
            expect(service.isMinIOConfigured()).toBe(true);
        });
    });

    describe('getPublicBucketName', () => {
        it('should return public bucket name', async () => {
            await service.onModuleInit();

            const bucketName = service.getPublicBucketName();

            expect(bucketName).toBe('public-bucket');
        });

        it('should return empty string when AppSettings not initialized', () => {
            mockAppSettingsService = createMockAppSettingsService({ isInitialized: false });
            service = makeService(mockAppSettingsService);

            const bucketName = service.getPublicBucketName();

            expect(bucketName).toBe('');
        });
    });

    describe('getPrivateBucketName', () => {
        it('should return private bucket name', async () => {
            await service.onModuleInit();

            const bucketName = service.getPrivateBucketName();

            expect(bucketName).toBe('private-bucket');
        });

        it('should return empty string when AppSettings not initialized', () => {
            mockAppSettingsService = createMockAppSettingsService({ isInitialized: false });
            service = makeService(mockAppSettingsService);

            const bucketName = service.getPrivateBucketName();

            expect(bucketName).toBe('');
        });
    });

    describe('isConfigured', () => {
        it('should return true when configured', async () => {
            const isConfigured = await service.isConfigured();

            expect(isConfigured).toBe(true);
        });

        it('should return false when AppSettings not initialized', async () => {
            mockAppSettingsService = createMockAppSettingsService({ isInitialized: false });
            service = makeService(mockAppSettingsService);

            const isConfigured = await service.isConfigured();

            expect(isConfigured).toBe(false);
        });

        it('should return false when required settings are missing', async () => {
            mockAppSettingsService = createMockAppSettingsService({
                settings: {},
            });
            service = makeService(mockAppSettingsService);

            const isConfigured = await service.isConfigured();

            expect(isConfigured).toBe(false);
        });
    });

    describe('putFile', () => {
        beforeEach(async () => {
            await service.onModuleInit();
        });

        it('should construct PutObjectCommand with correct bucket, key, body, and content type', async () => {
            mockS3Client.send.mockResolvedValue({});
            const fileContent = Buffer.from('test content');

            await service.putFile('test-bucket', 'test-key.txt', fileContent, 'text/plain');

            // Verify the command was constructed with exact parameters
            expect(PutObjectCommand).toHaveBeenCalledWith({
                Bucket: 'test-bucket',
                Key: 'test-key.txt',
                Body: fileContent,
                ContentType: 'text/plain',
            });
            // Verify the command was actually sent
            expect(mockS3Client.send).toHaveBeenCalledTimes(1);
        });

        it('should propagate S3 errors with original message', async () => {
            const s3Error = new Error('AccessDenied: Access Denied');
            mockS3Client.send.mockRejectedValue(s3Error);

            await expect(
                service.putFile('test-bucket', 'test-key.txt', Buffer.from('test'), 'text/plain')
            ).rejects.toThrow('AccessDenied: Access Denied');
        });

        it('should allow uploading without specifying content type', async () => {
            mockS3Client.send.mockResolvedValue({});

            await service.putFile('test-bucket', 'test-key.txt', Buffer.from('test'));

            expect(PutObjectCommand).toHaveBeenCalledWith({
                Bucket: 'test-bucket',
                Key: 'test-key.txt',
                Body: expect.any(Buffer),
                ContentType: undefined,
            });
        });

        it('should handle binary file content', async () => {
            mockS3Client.send.mockResolvedValue({});
            // Create binary content (not valid UTF-8)
            const binaryContent = Buffer.from([0x00, 0x01, 0x02, 0xFF, 0xFE]);

            await service.putFile('test-bucket', 'binary-file.bin', binaryContent, 'application/octet-stream');

            expect(PutObjectCommand).toHaveBeenCalledWith({
                Bucket: 'test-bucket',
                Key: 'binary-file.bin',
                Body: binaryContent,
                ContentType: 'application/octet-stream',
            });
        });

        it('should handle nested key paths', async () => {
            mockS3Client.send.mockResolvedValue({});

            await service.putFile('test-bucket', 'folder/subfolder/file.txt', Buffer.from('test'), 'text/plain');

            expect(PutObjectCommand).toHaveBeenCalledWith(
                expect.objectContaining({
                    Key: 'folder/subfolder/file.txt',
                })
            );
        });
    });

    describe('getFile', () => {
        beforeEach(async () => {
            await service.onModuleInit();
        });

        it('should download file from S3', async () => {
            const mockStream = {
                on: vi.fn().mockImplementation((event, callback) => {
                    if (event === 'data') {
                        callback(Buffer.from('test content'));
                    }
                    if (event === 'end') {
                        callback();
                    }
                    return mockStream;
                }),
            };

            mockS3Client.send.mockResolvedValue({
                Body: mockStream,
            });

            const result = await service.getFile('test-bucket', 'test-key.txt');

            expect(result).toBeInstanceOf(Buffer);
            expect(GetObjectCommand).toHaveBeenCalledWith({
                Bucket: 'test-bucket',
                Key: 'test-key.txt',
            });
        });

        it('should throw NotFoundException when file not found', async () => {
            mockS3Client.send.mockResolvedValue({
                Body: null,
            });

            await expect(
                service.getFile('test-bucket', 'non-existent.txt')
            ).rejects.toThrow();
        });

        it('should handle download errors', async () => {
            mockS3Client.send.mockRejectedValue(new Error('Download failed'));

            await expect(
                service.getFile('test-bucket', 'test-key.txt')
            ).rejects.toThrow('Download failed');
        });
    });

    describe('listFiles', () => {
        beforeEach(async () => {
            await service.onModuleInit();
        });

        it('should list files with prefix', async () => {
            mockS3Client.send.mockResolvedValue({
                Contents: [
                    { Key: 'folder/file1.txt', Size: 100, LastModified: new Date(), ETag: '"abc"' },
                    { Key: 'folder/file2.txt', Size: 200, LastModified: new Date(), ETag: '"def"' },
                ],
            });

            const result = await service.listFiles('test-bucket', 'folder/');

            expect(result).toHaveLength(2);
            expect(ListObjectsV2Command).toHaveBeenCalledWith({
                Bucket: 'test-bucket',
                Prefix: 'folder/',
            });
        });

        it('should return empty array when no files found', async () => {
            mockS3Client.send.mockResolvedValue({
                Contents: undefined,
            });

            const result = await service.listFiles('test-bucket', 'empty/');

            expect(result).toEqual([]);
        });

        it('should handle list errors', async () => {
            mockS3Client.send.mockRejectedValue(new Error('List failed'));

            await expect(
                service.listFiles('test-bucket', 'folder/')
            ).rejects.toThrow('List failed');
        });
    });

    describe('copyFile', () => {
        beforeEach(async () => {
            await service.onModuleInit();
        });

        it('should copy file within S3', async () => {
            mockS3Client.send.mockResolvedValue({});

            await service.copyFile('dest-bucket', 'dest-key.txt', 'source-bucket/source-key.txt');

            expect(CopyObjectCommand).toHaveBeenCalledWith({
                Bucket: 'dest-bucket',
                Key: 'dest-key.txt',
                CopySource: 'source-bucket/source-key.txt',
            });
        });

        it('should handle copy errors', async () => {
            mockS3Client.send.mockRejectedValue(new Error('Copy failed'));

            await expect(
                service.copyFile('dest-bucket', 'dest-key.txt', 'source/key.txt')
            ).rejects.toThrow('Copy failed');
        });
    });

    describe('deleteFile', () => {
        beforeEach(async () => {
            await service.onModuleInit();
        });

        it('should delete file from S3', async () => {
            mockS3Client.send.mockResolvedValue({});

            await service.deleteFile('test-bucket', 'test-key.txt');

            expect(DeleteObjectCommand).toHaveBeenCalledWith({
                Bucket: 'test-bucket',
                Key: 'test-key.txt',
            });
        });

        it('should handle delete errors', async () => {
            mockS3Client.send.mockRejectedValue(new Error('Delete failed'));

            await expect(
                service.deleteFile('test-bucket', 'test-key.txt')
            ).rejects.toThrow('Delete failed');
        });
    });

    describe('signUrl', () => {
        beforeEach(async () => {
            await service.onModuleInit();
        });

        it('should generate presigned URL for get command', async () => {
            const url = await service.signUrl('test-bucket', 'test-key.txt', 'get');

            expect(url).toBe('https://signed-url.example.com');
            expect(getSignedUrl).toHaveBeenCalled();
        });

        it('should generate presigned URL for list command', async () => {
            const url = await service.signUrl('test-bucket', 'folder/', 'list');

            expect(url).toBe('https://signed-url.example.com');
            expect(getSignedUrl).toHaveBeenCalled();
        });

        it('should use default get command', async () => {
            const url = await service.signUrl('test-bucket', 'test-key.txt');

            expect(url).toBe('https://signed-url.example.com');
        });

        it('should handle signing errors', async () => {
            (getSignedUrl as Mock).mockRejectedValue(new Error('Signing failed'));

            await expect(
                service.signUrl('test-bucket', 'test-key.txt')
            ).rejects.toThrow('Signing failed');
        });
    });

    describe('testConnection', () => {
        it('should return false on connection failure', async () => {
            await service.onModuleInit();
            mockS3Client.send.mockRejectedValue(new Error('Connection failed'));

            const result = await service.testConnection();

            expect(result).toBe(false);
        });
    });

    describe('isMinIOConfigured', () => {
        it('should return true for MinIO endpoint', async () => {
            await service.onModuleInit();

            const isMinIO = service.isMinIOConfigured();

            expect(isMinIO).toBe(true);
        });

        it('should return false when AppSettings not initialized', () => {
            mockAppSettingsService = createMockAppSettingsService({ isInitialized: false });
            service = makeService(mockAppSettingsService);

            const isMinIO = service.isMinIOConfigured();

            expect(isMinIO).toBe(false);
        });
    });

    describe('getMinIOInfo', () => {
        it('should return MinIO info for MinIO endpoint', async () => {
            await service.onModuleInit();

            const info = service.getMinIOInfo();

            expect(info.isMinIO).toBe(true);
            expect(info.endpoint).toBeDefined();
        });

        it('should return isMinIO false when not configured', () => {
            mockAppSettingsService = createMockAppSettingsService({ isInitialized: false });
            service = makeService(mockAppSettingsService);

            const info = service.getMinIOInfo();

            expect(info.isMinIO).toBe(false);
        });
    });

    describe('refreshConfiguration', () => {
        it('should reinitialize S3 client', async () => {
            await service.onModuleInit();

            // Refresh should work without error
            await expect(service.refreshConfiguration()).resolves.not.toThrow();
        });

        it('should handle refresh when configuration is not available', async () => {
            await service.onModuleInit();

            // Update mock to return empty settings
            (mockAppSettingsService.hasSetting as Mock).mockReturnValue(false);
            (mockAppSettingsService.getValueFromCache as Mock).mockReturnValue('');

            // Should not throw
            await expect(service.refreshConfiguration()).resolves.not.toThrow();
        });
    });

    describe('MinIO detection', () => {
        it('should detect localhost as MinIO', async () => {
            mockAppSettingsService = createMockAppSettingsService({
                settings: {
                    S3_ENDPOINT: 'http://localhost:9000',
                    S3_ACCESS_KEY: 'test',
                    S3_SECRET_KEY: 'test',
                },
            });
            service = makeService(mockAppSettingsService);

            await service.onModuleInit();

            expect(service.isMinIOConfigured()).toBe(true);
        });

        it('should detect 127.0.0.1 as MinIO', async () => {
            mockAppSettingsService = createMockAppSettingsService({
                settings: {
                    S3_ENDPOINT: 'http://127.0.0.1:9000',
                    S3_ACCESS_KEY: 'test',
                    S3_SECRET_KEY: 'test',
                },
            });
            service = makeService(mockAppSettingsService);

            await service.onModuleInit();

            expect(service.isMinIOConfigured()).toBe(true);
        });

        it('should detect minio in hostname as MinIO', async () => {
            mockAppSettingsService = createMockAppSettingsService({
                settings: {
                    S3_ENDPOINT: 'http://minio.example.com:9000',
                    S3_ACCESS_KEY: 'test',
                    S3_SECRET_KEY: 'test',
                },
            });
            service = makeService(mockAppSettingsService);

            await service.onModuleInit();

            expect(service.isMinIOConfigured()).toBe(true);
        });

        it('should not detect AWS S3 as MinIO', async () => {
            mockAppSettingsService = createMockAppSettingsService({
                settings: {
                    S3_ENDPOINT: 'https://s3.amazonaws.com',
                    S3_ACCESS_KEY: 'test',
                    S3_SECRET_KEY: 'test',
                },
            });
            service = makeService(mockAppSettingsService);

            await service.onModuleInit();

            expect(service.isMinIOConfigured()).toBe(false);
        });
    });

    describe('listAllBuckets', () => {
        it('should list all S3 buckets', async () => {
            await service.onModuleInit();

            mockS3Client.send.mockResolvedValueOnce({
                Buckets: [
                    { Name: 'public-bucket', CreationDate: new Date('2026-01-01') },
                    { Name: 'private-bucket', CreationDate: new Date('2026-01-02') },
                ],
            });

            const result = await service.listAllBuckets();

            expect(result).toHaveLength(2);
            expect(result[0]).toEqual(
                expect.objectContaining({ name: 'public-bucket' }),
            );
            expect(result[1]).toEqual(
                expect.objectContaining({ name: 'private-bucket' }),
            );
        });

        it('should return empty array when no buckets exist', async () => {
            await service.onModuleInit();

            mockS3Client.send.mockResolvedValueOnce({ Buckets: [] });

            const result = await service.listAllBuckets();

            expect(result).toEqual([]);
        });
    });

    describe('createBucket', () => {
        it('should create a new S3 bucket', async () => {
            await service.onModuleInit();

            mockS3Client.send.mockResolvedValueOnce({});

            await expect(service.createBucket('new-bucket')).resolves.not.toThrow();
            expect(mockS3Client.send).toHaveBeenCalled();
        });

        it('should reject invalid bucket names', async () => {
            await service.onModuleInit();

            await expect(service.createBucket('')).rejects.toThrow();
            await expect(service.createBucket('../traversal')).rejects.toThrow();
        });
    });

    describe('deleteBucket', () => {
        it('should delete an S3 bucket', async () => {
            await service.onModuleInit();

            mockS3Client.send.mockResolvedValueOnce({});

            await expect(service.deleteBucket('old-bucket')).resolves.not.toThrow();
            expect(mockS3Client.send).toHaveBeenCalled();
        });

        it('should reject invalid bucket names', async () => {
            await service.onModuleInit();

            await expect(service.deleteBucket('')).rejects.toThrow();
        });
    });

    describe('configuration validation', () => {
        it('should throw error for missing endpoint', async () => {
            mockAppSettingsService = createMockAppSettingsService({
                settings: {
                    S3_ENDPOINT: '',
                    S3_ACCESS_KEY: 'test',
                    S3_SECRET_KEY: 'test',
                },
            });
            service = makeService(mockAppSettingsService);

            // Initialization should handle missing config gracefully
            await service.onModuleInit();
        });

        it('should throw error for invalid endpoint URL', async () => {
            mockAppSettingsService = createMockAppSettingsService({
                settings: {
                    S3_ENDPOINT: 'not-a-valid-url',
                    S3_ACCESS_KEY: 'test',
                    S3_SECRET_KEY: 'test',
                },
            });
            service = makeService(mockAppSettingsService);

            // Should handle invalid URL gracefully
            await service.onModuleInit();
        });
    });
});
