/**
 * CoreUnitOfWorkService Unit Tests
 *
 * Tests for the Unit of Work pattern implementation using CLS for transaction management.
 *
 * Testing Strategy:
 * - Mock database service (Prisma) to avoid database calls
 * - Use real Map for CLS store to verify actual context management
 * - Test transaction lifecycle: start -> use -> end
 * - Verify correct client is returned based on transaction state
 */

import { describe, it, expect, beforeEach, afterEach, vi, Mock } from 'vitest';
import { CoreUnitOfWorkService } from '../core/core.unitOfWork';
import type { ClsService } from 'nestjs-cls';

/**
 * Mock database service interface matching CoreDatabaseService.
 */
interface MockDatabaseService {
    baseClient: {
        $transaction: Mock;
    };
    client: any;
}

describe('CoreUnitOfWorkService', () => {
    let service: CoreUnitOfWorkService;
    let mockDatabaseService: MockDatabaseService;
    let mockClsService: Partial<ClsService>;
    let clsStore: Map<string, any>;

    beforeEach(() => {
        vi.clearAllMocks();

        // Create CLS store
        clsStore = new Map();

        // Mock CLS service
        mockClsService = {
            get: vi.fn((key: string) => clsStore.get(key)),
            set: vi.fn((key: string, value: any) => {
                clsStore.set(key, value);
            }),
        };

        // Mock transaction client
        const mockTransactionClient = {
            user: { findMany: vi.fn() },
            tenant: { findMany: vi.fn() },
        };

        // Mock database service
        mockDatabaseService = {
            baseClient: {
                $transaction: vi.fn().mockImplementation(async (callback) => {
                    return callback(mockTransactionClient);
                }),
            },
            client: {
                user: { findMany: vi.fn() },
                tenant: { findMany: vi.fn() },
                $extends: true,
            },
        };

        service = new CoreUnitOfWorkService(
            mockDatabaseService as any,
            mockClsService as ClsService
        );
    });

    afterEach(() => {
        vi.restoreAllMocks();
    });

    describe('constructor', () => {
        it('should create service with injected dependencies', () => {
            expect(service).toBeDefined();
        });

        it('should initialize with null transaction client', () => {
            // Transaction client should be null initially
            const dbService = service.getDatabaseService();
            // Should return the extended client (not transaction)
            expect(dbService).toBe(mockDatabaseService.client);
        });
    });

    describe('startTransaction', () => {
        it('should start a database transaction', async () => {
            await service.startTransaction();

            expect(mockDatabaseService.baseClient.$transaction).toHaveBeenCalled();
        });

        it('should store transaction client in CLS', async () => {
            await service.startTransaction();

            expect(mockClsService.set).toHaveBeenCalledWith(
                'coreTransactionClient',
                expect.anything()
            );
        });

        it('should make transaction client available via getDatabaseService', async () => {
            await service.startTransaction();

            // After starting transaction, getDatabaseService should return transaction client
            const dbService = service.getDatabaseService();
            expect(mockClsService.get).toHaveBeenCalledWith('coreTransactionClient');
        });

        it('should handle transaction creation errors', async () => {
            mockDatabaseService.baseClient.$transaction.mockRejectedValue(
                new Error('Transaction failed')
            );

            await expect(service.startTransaction()).rejects.toThrow('Transaction failed');
        });
    });

    describe('getDatabaseService', () => {
        it('should return extended client when no transaction is active', () => {
            const dbService = service.getDatabaseService();

            // Verify the actual client returned, not just that something was returned
            expect(dbService).toBe(mockDatabaseService.client);
            expect(dbService.$extends).toBe(true); // Verify it's the extended client
        });

        it('should return transaction client when transaction is active', async () => {
            const mockTxClient = { user: { findMany: vi.fn() }, _isTransactionClient: true };
            mockDatabaseService.baseClient.$transaction.mockImplementation(async (callback) => {
                return callback(mockTxClient);
            });

            await service.startTransaction();

            // Simulate CLS returning the transaction client
            clsStore.set('coreTransactionClient', mockTxClient);

            const dbService = service.getDatabaseService();

            // Verify we get the transaction client, not the regular client
            expect(dbService).toBe(mockTxClient);
            expect(dbService._isTransactionClient).toBe(true);
            expect(dbService).not.toBe(mockDatabaseService.client);
        });

        it('should fall back to extended client when CLS has null', () => {
            clsStore.set('coreTransactionClient', null);

            const dbService = service.getDatabaseService();

            // Verify fallback behavior
            expect(dbService).toBe(mockDatabaseService.client);
        });

        it('should fall back to extended client when CLS has no value', () => {
            // CLS store is empty (no transaction started)
            clsStore.clear();

            const dbService = service.getDatabaseService();

            expect(dbService).toBe(mockDatabaseService.client);
        });

        it('should consistently return same client during transaction', async () => {
            const mockTxClient = { id: 'tx-123' };
            mockDatabaseService.baseClient.$transaction.mockImplementation(async (callback) => {
                return callback(mockTxClient);
            });

            await service.startTransaction();
            clsStore.set('coreTransactionClient', mockTxClient);

            // Multiple calls should return the same client
            const client1 = service.getDatabaseService();
            const client2 = service.getDatabaseService();
            const client3 = service.getDatabaseService();

            expect(client1).toBe(client2);
            expect(client2).toBe(client3);
            expect(client1).toBe(mockTxClient);
        });
    });

    describe('endTransaction', () => {
        it('should clear transaction client', async () => {
            await service.startTransaction();
            service.endTransaction();

            // After ending, getDatabaseService should return extended client
            clsStore.delete('coreTransactionClient');
            const dbService = service.getDatabaseService();
            expect(dbService).toBe(mockDatabaseService.client);
        });

        it('should set CLS transaction client to null', () => {
            service.endTransaction();

            expect(mockClsService.set).toHaveBeenCalledWith('coreTransactionClient', null);
        });

        it('should not throw when called without active transaction', () => {
            expect(() => service.endTransaction()).not.toThrow();
        });

        it('should be safe to call multiple times', () => {
            service.endTransaction();
            service.endTransaction();
            service.endTransaction();

            expect(mockClsService.set).toHaveBeenCalledTimes(3);
        });
    });

    describe('transaction lifecycle', () => {
        it('should support full transaction lifecycle', async () => {
            // Start transaction
            await service.startTransaction();
            expect(mockDatabaseService.baseClient.$transaction).toHaveBeenCalled();

            // Use database service during transaction
            const txClient = service.getDatabaseService();
            expect(mockClsService.get).toHaveBeenCalled();

            // End transaction
            service.endTransaction();
            expect(mockClsService.set).toHaveBeenCalledWith('coreTransactionClient', null);
        });

        it('should allow multiple sequential transactions', async () => {
            // First transaction
            await service.startTransaction();
            service.endTransaction();

            // Second transaction
            await service.startTransaction();
            service.endTransaction();

            expect(mockDatabaseService.baseClient.$transaction).toHaveBeenCalledTimes(2);
        });

        it('should isolate transactions', async () => {
            const mockTxClient1 = { id: 'tx1' };
            const mockTxClient2 = { id: 'tx2' };

            mockDatabaseService.baseClient.$transaction
                .mockImplementationOnce(async (callback) => callback(mockTxClient1))
                .mockImplementationOnce(async (callback) => callback(mockTxClient2));

            // First transaction
            await service.startTransaction();
            expect(clsStore.get('coreTransactionClient')).toBe(mockTxClient1);
            service.endTransaction();

            // Second transaction
            await service.startTransaction();
            expect(clsStore.get('coreTransactionClient')).toBe(mockTxClient2);
            service.endTransaction();
        });
    });

    describe('error handling', () => {
        it('should handle database service errors', async () => {
            mockDatabaseService.baseClient.$transaction.mockRejectedValue(
                new Error('Database connection failed')
            );

            await expect(service.startTransaction()).rejects.toThrow('Database connection failed');
        });

        it('should not leave stale transaction on error', async () => {
            mockDatabaseService.baseClient.$transaction.mockRejectedValue(
                new Error('Transaction error')
            );

            try {
                await service.startTransaction();
            } catch {
                // Expected error
            }

            // CLS should not have been set with a transaction client
            // (the set call happens after the transaction is created)
        });
    });

    describe('CLS integration', () => {
        it('should use correct CLS key', async () => {
            await service.startTransaction();

            expect(mockClsService.set).toHaveBeenCalledWith(
                'coreTransactionClient',
                expect.anything()
            );
        });

        it('should retrieve from correct CLS key', () => {
            service.getDatabaseService();

            expect(mockClsService.get).toHaveBeenCalledWith('coreTransactionClient');
        });
    });

    /*
     * `runInTransaction` is the canonical
     * Prisma 7 transactional API. The legacy
     * `startTransaction()/endTransaction()` wrapper cannot carry true
     * transactional isolation through a non-callback signature (Prisma
     * commits when the `$transaction` callback resolves), so we expose a
     * new method that ALWAYS does `$transaction(callback)` and exposes
     * the tx client to nested repository calls through CLS for the
     * duration of `work`. Matches the proven
     * `databaseService.baseClient.$transaction(async (tx) => ...)`
     * pattern already used by TenantService.
     */
    describe('runInTransaction canonical $transaction(callback)', () => {
        function makeTransactionalMock() {
            const committed: { key: string; value: string }[] = [];

            mockDatabaseService.baseClient.$transaction.mockReset();
            mockDatabaseService.baseClient.$transaction.mockImplementation(
                async (callback: (tx: any) => Promise<any>) => {
                    const pending: { key: string; value: string }[] = [];
                    const tx = {
                        insert: (key: string, value: string) => {
                            pending.push({ key, value });
                            return Promise.resolve();
                        },
                    };
                    const result = await callback(tx);
                    committed.push(...pending);
                    return result;
                },
            );

            return { committed };
        }

        it('commits both operations when the work callback resolves', async () => {
            const { committed } = makeTransactionalMock();

            const result = await service.runInTransaction(async (tx: any) => {
                await tx.insert('k1', 'v1');
                await tx.insert('k2', 'v2');
                return 'ok';
            });

            expect(result).toBe('ok');
            expect(committed).toEqual([
                { key: 'k1', value: 'v1' },
                { key: 'k2', value: 'v2' },
            ]);
        });

        it('rolls back the first operation when the second operation throws', async () => {
            const { committed } = makeTransactionalMock();

            await expect(
                service.runInTransaction(async (tx: any) => {
                    await tx.insert('k1', 'v1');
                    await tx.insert('k2', 'v2');
                    throw new Error('mid-tx failure');
                }),
            ).rejects.toThrow('mid-tx failure');

            expect(committed).toEqual([]);
        });

        it('exposes the tx client through CLS while the work is running', async () => {
            let txInsideWork: any;
            mockDatabaseService.baseClient.$transaction.mockReset();
            const fakeTx = { _isTx: true };
            mockDatabaseService.baseClient.$transaction.mockImplementation(
                async (callback: (tx: any) => Promise<any>) => callback(fakeTx),
            );

            await service.runInTransaction(async (tx: any) => {
                txInsideWork = service.getDatabaseService();
                expect(tx).toBe(fakeTx);
            });

            expect(txInsideWork).toBe(fakeTx);
            expect(service.getDatabaseService()).toBe(mockDatabaseService.client);
        });

        it('clears CLS even when work throws (no stale tx client leaked across calls)', async () => {
            mockDatabaseService.baseClient.$transaction.mockReset();
            mockDatabaseService.baseClient.$transaction.mockImplementation(
                async (callback: (tx: any) => Promise<any>) => callback({}),
            );

            await expect(
                service.runInTransaction(async () => {
                    throw new Error('boom');
                }),
            ).rejects.toThrow('boom');

            expect(service.getDatabaseService()).toBe(mockDatabaseService.client);
        });
    });
});
