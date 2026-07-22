import { describe, it, expect, vi } from 'vitest';
import { slugifyTenantName, generateUniqueTenantKey } from '../tenantKey';

describe('slugifyTenantName', () => {
    it('lowercases and hyphenates a normal name', () => {
        expect(slugifyTenantName('Acme Health Clinic')).toBe('acme-health-clinic');
    });

    it('strips characters outside [a-z0-9-]', () => {
        expect(slugifyTenantName("St. Mary's Hospital & Co.")).toBe('st-marys-hospital-co');
    });

    it('collapses repeated separators into a single hyphen', () => {
        expect(slugifyTenantName('Acme   --  Health')).toBe('acme-health');
    });

    it('trims leading/trailing hyphens', () => {
        expect(slugifyTenantName('  -Acme Health-  ')).toBe('acme-health');
    });

    it('truncates to 40 characters', () => {
        const longName = 'A'.repeat(60);
        const slug = slugifyTenantName(longName);
        expect(slug.length).toBeLessThanOrEqual(40);
        expect(slug).toBe('a'.repeat(40));
    });

    it('does not leave a trailing hyphen after truncation', () => {
        const name = 'Acme-'.repeat(10); // 50 chars, hyphen lands right at the 40 cut
        const slug = slugifyTenantName(name);
        expect(slug.endsWith('-')).toBe(false);
        expect(slug.length).toBeLessThanOrEqual(40);
    });
});

describe('generateUniqueTenantKey', () => {
    it('returns the base slug when it does not collide', async () => {
        const exists = vi.fn().mockResolvedValue(false);

        const key = await generateUniqueTenantKey('Acme Health', exists);

        expect(key).toBe('acme-health');
        expect(exists).toHaveBeenCalledWith('acme-health');
    });

    it('appends a numeric collision suffix on clash', async () => {
        const exists = vi.fn(async (key: string) => key === 'acme-health' || key === 'acme-health-2');

        const key = await generateUniqueTenantKey('Acme Health', exists);

        expect(key).toBe('acme-health-3');
        expect(exists).toHaveBeenCalledTimes(3);
    });

    it('falls back to a t-<8hex> key for an empty slug', async () => {
        const exists = vi.fn().mockResolvedValue(false);

        const key = await generateUniqueTenantKey('!!!', exists);

        expect(key).toMatch(/^t-[0-9a-f]{8}$/);
    });

    it('falls back to a t-<8hex> key when the slug hits a reserved name', async () => {
        const exists = vi.fn().mockResolvedValue(false);

        const key = await generateUniqueTenantKey('__GLOBAL__', exists);

        expect(key).toMatch(/^t-[0-9a-f]{8}$/);
        // Reserved fallback must not even probe the reserved slug.
        expect(exists).not.toHaveBeenCalledWith('__global__');
    });

    it('falls back to a t-<8hex> key for any __reserved__-shaped slug', async () => {
        const exists = vi.fn().mockResolvedValue(false);

        const key = await generateUniqueTenantKey('__anything__', exists);

        expect(key).toMatch(/^t-[0-9a-f]{8}$/);
    });
});
