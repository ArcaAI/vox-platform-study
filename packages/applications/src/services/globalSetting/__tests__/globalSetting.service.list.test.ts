/**
 * TASK-443 — settings list faceting unit tests.
 *
 * Covers the LIST path only:
 *   1. `buildSecretSettingFilter` — the ONE shared Prisma fragment for the
 *      derived secret predicate, kept in lockstep with
 *      `GlobalSettingDtoMapper.isSecretEntity` (same namespace + key markers).
 *   2. `fetchAll` / `fetchAllByTenantId` — the `secretsOnly` flag resolves to
 *      that fragment server-side (true = secrets, false = non-secrets,
 *      omitted = no predicate).
 *   3. Bracket-grammar filters coerce against the `GlobalSetting` registry:
 *      `namespace[in]` deserializes to a Prisma `in` list and `dataType`
 *      (enum `ValueType`) member-validates with a 400 on an unknown member.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { BadRequestException } from '@nestjs/common';
import { GlobalSettingService } from '../globalSetting.service';
import { GlobalSettingDtoMapper, buildSecretSettingFilter } from '../globalSetting.dto.mapper';

const mockGlobalSettingRepository = {
    findById: vi.fn(),
    findAll: vi.fn(),
    count: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    updateWithVersion: vi.fn(),
    softDelete: vi.fn(),
    findByIdWithDecryptedValue: vi.fn(),
    findFirst: vi.fn(),
    restore: vi.fn(),
};
const mockUserRepository = { findById: vi.fn() };
const mockCryptoService = { hash: vi.fn(), verify: vi.fn(), encrypt: vi.fn(), decrypt: vi.fn() };
const mockSecretsService = { encrypt: vi.fn(), decrypt: vi.fn() };
const mockEventEmitter = { emit: vi.fn() };
const mockClsService = { get: vi.fn(), set: vi.fn() };

/** Minimal entity shape for isSecretEntity parity checks (mapper reads 3 fields). */
function secretProbe(overrides: { encryptedValue?: Uint8Array | null; namespace?: string | null; key?: string }): never {
    return { encryptedValue: null, namespace: 'general', key: 'plain.key', ...overrides } as any;
}

describe('GlobalSetting list faceting (TASK-443)', () => {
    let service: GlobalSettingService;

    beforeEach(() => {
        vi.clearAllMocks();
        mockGlobalSettingRepository.findAll.mockResolvedValue([]);
        mockGlobalSettingRepository.count.mockResolvedValue(0);
        mockClsService.get.mockReturnValue(null);
        service = new GlobalSettingService(
            mockGlobalSettingRepository as any,
            mockUserRepository as any,
            mockCryptoService as any,
            mockSecretsService as any,
            mockEventEmitter as any,
            mockClsService as any,
        );
    });

    describe('buildSecretSettingFilter — the shared derived-secret fragment', () => {
        it('ORs the exact tri-condition of isSecretEntity: encryptedValue present, secrets namespace, convention-named key', () => {
            const fragment = buildSecretSettingFilter();
            const or = (fragment as { OR: Record<string, unknown>[] }).OR;

            expect(Array.isArray(or)).toBe(true);
            expect(or).toContainEqual({ encryptedValue: { not: null } });
            expect(or).toContainEqual({ namespace: { equals: 'secrets', mode: 'insensitive' } });
            // Every key marker becomes a case-insensitive contains clause.
            for (const marker of ['secret', 'password', 'token', 'credential', 'api_key', 'api-key', 'apikey', 'private_key', 'private-key', 'privatekey']) {
                expect(or).toContainEqual({ key: { contains: marker, mode: 'insensitive' } });
            }
        });

        it('stays in lockstep with isSecretEntity for convention-named keys (list and mask can never diverge)', () => {
            const fragment = buildSecretSettingFilter() as { OR: ({ key?: { contains: string } } & Record<string, unknown>)[] };
            const markers = fragment.OR.filter((clause) => clause.key).map((clause) => (clause.key as { contains: string }).contains.toLowerCase());
            const sqlWouldMatch = (key: string) => markers.some((marker) => key.toLowerCase().includes(marker));

            const secretKeys = ['smtp.password', 'service.api-key', 'SERVICE_API_KEY', 'vault.token', 'db.credential', 'signing.private-key', 'apikey.rotation', 'jwt.secret'];
            for (const key of secretKeys) {
                expect(GlobalSettingDtoMapper.isSecretEntity(secretProbe({ key }))).toBe(true);
                expect(sqlWouldMatch(key)).toBe(true);
            }
            const plainKeys = ['smtp.host', 'retention.days', 'feature.enable'];
            for (const key of plainKeys) {
                expect(GlobalSettingDtoMapper.isSecretEntity(secretProbe({ key }))).toBe(false);
                expect(sqlWouldMatch(key)).toBe(false);
            }
        });
    });

    describe('fetchAll — secretsOnly flag', () => {
        it('applies the tri-condition where fragment when secretsOnly=true', async () => {
            await service.fetchAll({ limit: 10, page: 1, secretsOnly: true });

            expect(mockGlobalSettingRepository.findAll).toHaveBeenCalledWith(expect.objectContaining({ where: { AND: [buildSecretSettingFilter()] } }));
            expect(mockGlobalSettingRepository.count).toHaveBeenCalledWith(expect.objectContaining({ where: { AND: [buildSecretSettingFilter()] } }));
        });

        it('negates the fragment when secretsOnly=false (non-secrets only)', async () => {
            await service.fetchAll({ limit: 10, page: 1, secretsOnly: false });

            expect(mockGlobalSettingRepository.findAll).toHaveBeenCalledWith(
                expect.objectContaining({ where: { AND: [{ NOT: buildSecretSettingFilter() }] } }),
            );
        });

        it('adds no where clause when the flag is omitted (behaviour unchanged)', async () => {
            await service.fetchAll({ limit: 10, page: 1 });

            expect(mockGlobalSettingRepository.findAll.mock.calls[0][0].where).toBeUndefined();
            expect(mockGlobalSettingRepository.count.mock.calls[0][0].where).toBeUndefined();
        });
    });

    describe('fetchAll — bracket-grammar faceting with GlobalSetting field coercion', () => {
        it('deserializes namespace[in]:a|b to a Prisma in-list', async () => {
            await service.fetchAll({ limit: 10, page: 1, filters: 'namespace[in]:secrets|smr' });

            expect(mockGlobalSettingRepository.findAll).toHaveBeenCalledWith(
                expect.objectContaining({ filters: { namespace: { in: ['secrets', 'smr'] } } }),
            );
        });

        it('accepts a valid ValueType member on dataType', async () => {
            await service.fetchAll({ limit: 10, page: 1, filters: 'dataType[equals]:Json' });

            expect(mockGlobalSettingRepository.findAll).toHaveBeenCalledWith(expect.objectContaining({ filters: { dataType: { equals: 'Json' } } }));
        });

        it('rejects an invalid ValueType member with a 400 (enum registry validation)', async () => {
            await expect(service.fetchAll({ limit: 10, page: 1, filters: 'dataType[equals]:NotAType' })).rejects.toBeInstanceOf(BadRequestException);
            expect(mockGlobalSettingRepository.findAll).not.toHaveBeenCalled();
        });
    });

    describe('fetchAllByTenantId — secretsOnly composes with the tenant scope', () => {
        it('keeps the bare tenant where when the flag is omitted (behaviour unchanged)', async () => {
            await service.fetchAllByTenantId({ limit: 10, page: 1, tenantId: 't-1' });

            expect(mockGlobalSettingRepository.findAll).toHaveBeenCalledWith(expect.objectContaining({ where: { tenantId: 't-1' } }));
        });

        it('ANDs the tenant scope with the secret fragment when secretsOnly=true', async () => {
            await service.fetchAllByTenantId({ limit: 10, page: 1, tenantId: 't-1', secretsOnly: true });

            expect(mockGlobalSettingRepository.findAll).toHaveBeenCalledWith(
                expect.objectContaining({ where: { AND: [{ tenantId: 't-1' }, buildSecretSettingFilter()] } }),
            );
            expect(mockGlobalSettingRepository.count).toHaveBeenCalledWith(
                expect.objectContaining({ where: { AND: [{ tenantId: 't-1' }, buildSecretSettingFilter()] } }),
            );
        });

        it('member-validates dataType on the tenant-scoped path too', async () => {
            await expect(service.fetchAllByTenantId({ limit: 10, page: 1, tenantId: 't-1', filters: 'dataType[equals]:Bogus' })).rejects.toBeInstanceOf(
                BadRequestException,
            );
        });
    });
});
