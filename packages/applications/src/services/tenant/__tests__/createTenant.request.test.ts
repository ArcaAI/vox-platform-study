import { describe, it, expect } from 'vitest';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { CreateTenantRequest } from '../dto/createTenant.request';

describe('CreateTenantRequest validation (TASK-497 D3)', () => {
    it('is valid when key is omitted (auto-generated downstream)', async () => {
        const dto = plainToInstance(CreateTenantRequest, { name: 'Acme Health' });

        const errors = await validate(dto);

        expect(errors.filter((e) => e.property === 'key')).toHaveLength(0);
    });

    it('is valid when an explicit, non-reserved key is supplied', async () => {
        const dto = plainToInstance(CreateTenantRequest, { name: 'Acme Health', key: 'ACME' });

        const errors = await validate(dto);

        expect(errors.filter((e) => e.property === 'key')).toHaveLength(0);
    });

    it('rejects an explicit reserved key', async () => {
        const dto = plainToInstance(CreateTenantRequest, { name: 'Acme Health', key: '__GLOBAL__' });

        const errors = await validate(dto);

        expect(errors.some((e) => e.property === 'key')).toBe(true);
    });

    it('rejects an explicit key over 40 characters', async () => {
        const dto = plainToInstance(CreateTenantRequest, { name: 'Acme Health', key: 'a'.repeat(41) });

        const errors = await validate(dto);

        expect(errors.some((e) => e.property === 'key')).toBe(true);
    });
});
