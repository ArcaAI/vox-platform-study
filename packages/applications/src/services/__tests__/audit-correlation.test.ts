/**
 * Cross-service audit-log correlation contract.
 *
 * Both write paths for config — `TenantService.updateTenantConfigs` (multi-row
 * via `$transaction`) and `GlobalSettingService.update` (single-row admin path)
 * — must emit a `SysEvent.ResourceUpdated` whose payload carries
 * `previousVersion` and `newVersion` per persisted row.
 *
 * Investigators reconstruct history by querying the audit log:
 *
 *   SELECT … FROM audit_event
 *   WHERE event_type = 'SysEvent.ResourceUpdated'
 *     AND metadata->>'newVersion' = ?;
 *
 * This closes the "audit-log gaslighting" risk from Research §1 scenario 3:
 * without the version transition, an investigator cannot distinguish "this
 * row was edited at t=100 (v5 → v6)" from "this row was edited at t=100
 * and then again at t=101 (v6 → v7) that we missed because the second write
 * silently no-op'd."
 *
 * Per-service tests already verify each path in isolation. This file is the
 * contract-level guard against drift: if either service stops emitting the
 * two fields, the audit story collapses on both paths simultaneously, so
 * the cross-service assertion catches the regression in CI.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { SysEventType } from '@arcaai/domains';

const mockTxClient = { __tx: true } as const;

function buildEmitterMock(): { emit: ReturnType<typeof vi.fn> } {
    return { emit: vi.fn() };
}

function buildClsMock(): { get: ReturnType<typeof vi.fn>; set: ReturnType<typeof vi.fn> } {
    const get = vi.fn().mockImplementation((key: string) => {
        switch (key) {
            case 'user':
                return { id: 'user-1', firstName: 'Test', lastName: 'User', email: 'u@example.com' };
            case 'tenantId':
                return 'tenant-1';
            case 'tenantCode':
                return 'TENANT_1';
            case 'correlationId':
                return 'corr-1';
            case 'requestIp':
                return '127.0.0.1';
            default:
                return null;
        }
    });
    return { get, set: vi.fn() };
}

function createMockGlobalSettingEntity(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    const entity: Record<string, unknown> = {
        id: overrides.id ?? 'gs-1',
        tenantId: overrides.tenantId ?? 'tenant-1',
        key: overrides.key ?? 'setting.key',
        value: overrides.value ?? 'value',
        defaultValue: 'default',
        dataType: 'String',
        description: 'desc',
        locked: overrides.locked ?? false,
        namespace: 'ns',
        name: 'name',
        resourceStatus: 'ENABLED',
        createdBy: null,
        updatedBy: null,
        createdAt: new Date('2026-01-01T00:00:00Z'),
        updatedAt: new Date('2026-01-01T00:00:00Z'),
        version: overrides.version ?? 1,
        hasChanges: overrides.hasChanges ?? true,
        changes: overrides.changes ?? { value: 'new' },
        toObject: vi.fn(),
    };
    (entity.toObject as ReturnType<typeof vi.fn>).mockReturnValue({ ...entity });
    return entity;
}

vi.mock('@arcaai/domains', async () => {
    const actual = await vi.importActual('@arcaai/domains');
    return {
        ...actual,
        TenantFactory: { CreateTenant: vi.fn() },
        GlobalSettingFactory: { CreateGlobalSetting: vi.fn() },
    };
});

describe('Audit-log version correlation (TASK-302 Stream D Phase C.8) — cross-service contract', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it('TenantService.updateTenantConfigs emits previousVersion and newVersion', async () => {
        const { TenantService } = await import('../tenant/tenant.service');

        const eventEmitter = buildEmitterMock();
        const cls = buildClsMock();
        cls.get.mockImplementation((key: string) => (key === 'user' ? { id: 'u', roles: ['GLOBAL_ADMIN'] } : null));

        const tenant = { id: 'tenant-1', key: 'TENANT_1' } as any;
        const tenantRepo = { findById: vi.fn(), findFirst: vi.fn().mockResolvedValue(tenant) };

        const pre = createMockGlobalSettingEntity({ id: 'gs-1', version: 5, hasChanges: true });
        const post = createMockGlobalSettingEntity({ id: 'gs-1', version: 6, hasChanges: true });
        const globalSettingRepo = {
            findById: vi.fn().mockResolvedValue(pre),
            updateWithVersion: vi.fn().mockResolvedValue(post),
            update: vi.fn(),
        };

        const databaseService = {
            baseClient: {
                $transaction: vi.fn().mockImplementation(async (cb: (tx: typeof mockTxClient) => Promise<unknown>) => cb(mockTxClient)),
            },
        };

        const tenantBucketService = { provisionBucket: vi.fn() };

        const service = new (TenantService as any)(
            tenantRepo,
            globalSettingRepo,
            { findAll: vi.fn(), count: vi.fn() },
            { findAll: vi.fn(), count: vi.fn() },
            { findAll: vi.fn(), count: vi.fn() },
            databaseService,
            tenantBucketService,
            eventEmitter,
            cls,
        );

        await service.updateTenantConfigs('tenant-1', [
            { id: 'gs-1', value: 'new', expectedVersion: 5 } as any,
        ]);

        const updatedBroadcasts = eventEmitter.emit.mock.calls.filter(
            ([eventName]) => eventName === SysEventType.ResourceUpdated,
        );
        expect(updatedBroadcasts).toHaveLength(1);
        const [, payload] = updatedBroadcasts[0] as [string, { data: Array<Record<string, unknown>> }];
        expect(payload.data).toEqual([
            expect.objectContaining({ previousVersion: 5, newVersion: 6 }),
        ]);
    });

    it('GlobalSettingService.update emits previousVersion and newVersion', async () => {
        const { GlobalSettingService } = await import('../globalSetting/globalSetting.service');

        const eventEmitter = buildEmitterMock();
        const cls = buildClsMock();

        const pre = createMockGlobalSettingEntity({ id: 'gs-1', version: 7, hasChanges: true });
        const post = createMockGlobalSettingEntity({ id: 'gs-1', version: 8, hasChanges: true });
        const globalSettingRepo = {
            findById: vi.fn().mockResolvedValue(pre),
            findAll: vi.fn(),
            count: vi.fn(),
            create: vi.fn(),
            update: vi.fn(),
            updateWithVersion: vi.fn().mockResolvedValue(post),
            softDelete: vi.fn(),
        };

        // Constructor also takes UserRepository, ICryptoService,
        // SecretsService (used only by revealSecret; `update` ignores them).
        const service = new (GlobalSettingService as any)(
            globalSettingRepo,
            { findById: vi.fn() },
            { verify: vi.fn() },
            { decrypt: vi.fn() },
            eventEmitter,
            cls,
        );

        await service.update('gs-1', { value: 'new', expectedVersion: 7 } as any);

        const updatedBroadcasts = eventEmitter.emit.mock.calls.filter(
            ([eventName]) => eventName === SysEventType.ResourceUpdated,
        );
        expect(updatedBroadcasts).toHaveLength(1);
        const [, payload] = updatedBroadcasts[0] as [string, { data: Record<string, unknown> }];
        expect(payload.data).toEqual(
            expect.objectContaining({ previousVersion: 7, newVersion: 8 }),
        );
    });
});
