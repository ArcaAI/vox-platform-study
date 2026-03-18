/**
 * ApiKeyEventHandlers Unit Tests
 *
 * Tests the event handler that deactivates API keys when a user is deleted.
 *
 * Covers:
 *   - handleUserDeleted: deactivates all active API keys for the deleted user
 *   - No-op when user has no active keys
 *   - Logging of deactivation
 *   - Graceful error handling on repository failures
 *   - Sets keyStatus to INACTIVE (not REVOKED)
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ApiKeyEventHandlers } from '../apikey.event-handlers';
import { ApiKeyStatus } from '@arcaai/domains';

// =============================================================================
// Mock Factories
// =============================================================================

const createMockApiKeyRepository = () => ({
    findAll: vi.fn(),
    update: vi.fn(),
    findById: vi.fn(),
});

const createMockLogger = () => ({
    log: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
});

const createMockApiKeyEntity = (overrides: Record<string, unknown> = {}) => ({
    id: 'key-1',
    keyStatus: ApiKeyStatus.ACTIVE,
    userId: 'user-123',
    tenantId: 'tenant-1',
    keyName: 'Test Key',
    ...overrides,
});

// =============================================================================
// Tests
// =============================================================================

describe('ApiKeyEventHandlers', () => {
    let handler: ApiKeyEventHandlers;
    let mockApiKeyRepository: ReturnType<typeof createMockApiKeyRepository>;
    let mockLogger: ReturnType<typeof createMockLogger>;

    beforeEach(() => {
        vi.clearAllMocks();
        mockApiKeyRepository = createMockApiKeyRepository();
        handler = new ApiKeyEventHandlers(mockApiKeyRepository as any);
        mockLogger = createMockLogger();
        (handler as any).logger = mockLogger;
    });

    // =========================================================================
    // handleUserDeleted
    // =========================================================================

    describe('handleUserDeleted', () => {
        it('should deactivate all active API keys for the deleted user', async () => {
            const mockKeys = [
                createMockApiKeyEntity({ id: 'key-1', userId: 'user-123' }),
                createMockApiKeyEntity({ id: 'key-2', userId: 'user-123' }),
            ];
            mockApiKeyRepository.findAll.mockResolvedValue(mockKeys);
            mockApiKeyRepository.update.mockImplementation((_id, entity) =>
                Promise.resolve(entity),
            );

            await handler.handleUserDeleted({ userId: 'user-123', tenantId: 'tenant-1' });

            expect(mockApiKeyRepository.findAll).toHaveBeenCalledWith({
                where: { userId: 'user-123', keyStatus: ApiKeyStatus.ACTIVE },
            });
            expect(mockApiKeyRepository.update).toHaveBeenCalledTimes(2);
            expect(mockApiKeyRepository.update).toHaveBeenCalledWith(
                'key-1',
                expect.objectContaining({ keyStatus: ApiKeyStatus.INACTIVE }),
            );
            expect(mockApiKeyRepository.update).toHaveBeenCalledWith(
                'key-2',
                expect.objectContaining({ keyStatus: ApiKeyStatus.INACTIVE }),
            );
        });

        it('should not fail when user has no active API keys', async () => {
            mockApiKeyRepository.findAll.mockResolvedValue([]);

            await expect(
                handler.handleUserDeleted({ userId: 'user-no-keys', tenantId: 'tenant-1' }),
            ).resolves.not.toThrow();

            expect(mockApiKeyRepository.update).not.toHaveBeenCalled();
        });

        it('should log the deactivation', async () => {
            mockApiKeyRepository.findAll.mockResolvedValue([
                createMockApiKeyEntity({ id: 'key-1', userId: 'user-123' }),
            ]);
            mockApiKeyRepository.update.mockImplementation((_id, entity) =>
                Promise.resolve(entity),
            );

            await handler.handleUserDeleted({ userId: 'user-123', tenantId: 'tenant-1' });

            expect(mockLogger.log).toHaveBeenCalled();
        });

        it('should handle repository errors gracefully', async () => {
            mockApiKeyRepository.findAll.mockRejectedValue(new Error('DB error'));

            await expect(
                handler.handleUserDeleted({ userId: 'user-123', tenantId: 'tenant-1' }),
            ).resolves.not.toThrow();

            expect(mockLogger.error).toHaveBeenCalled();
        });

        it('should set key status to INACTIVE (not REVOKED)', async () => {
            const mockKey = createMockApiKeyEntity({ id: 'key-1', userId: 'user-123' });
            mockApiKeyRepository.findAll.mockResolvedValue([mockKey]);
            mockApiKeyRepository.update.mockImplementation((_id, entity) =>
                Promise.resolve(entity),
            );

            await handler.handleUserDeleted({ userId: 'user-123', tenantId: 'tenant-1' });

            const updateCall = mockApiKeyRepository.update.mock.calls[0];
            expect(updateCall[0]).toBe('key-1');
            expect(updateCall[1]).toMatchObject({ keyStatus: ApiKeyStatus.INACTIVE });
        });

        it('should log when no active keys found for deleted user', async () => {
            mockApiKeyRepository.findAll.mockResolvedValue([]);

            await handler.handleUserDeleted({ userId: 'user-empty', tenantId: 'tenant-1' });

            expect(mockLogger.log).toHaveBeenCalledWith(
                expect.objectContaining({
                    userId: 'user-empty',
                }),
            );
        });

        it('should continue deactivating remaining keys if one update fails', async () => {
            const mockKeys = [
                createMockApiKeyEntity({ id: 'key-1', userId: 'user-123' }),
                createMockApiKeyEntity({ id: 'key-2', userId: 'user-123' }),
            ];
            mockApiKeyRepository.findAll.mockResolvedValue(mockKeys);
            mockApiKeyRepository.update
                .mockRejectedValueOnce(new Error('update failed'))
                .mockImplementationOnce((_id, entity) => Promise.resolve(entity));

            await expect(
                handler.handleUserDeleted({ userId: 'user-123', tenantId: 'tenant-1' }),
            ).resolves.not.toThrow();

            expect(mockApiKeyRepository.update).toHaveBeenCalledTimes(2);
        });
    });
});
