import { getTokenExpiryMs } from '../auth-refresh';

function createJwtPayload(exp: number): string {
    const header = btoa(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
    const payload = btoa(JSON.stringify({ id: 'u-1', exp }));
    return `${header}.${payload}.fake-signature`;
}

describe('getTokenExpiryMs', () => {
    it('should return milliseconds until expiry for a valid JWT', () => {
        const futureExp = Math.floor(Date.now() / 1000) + 3600;
        const token = createJwtPayload(futureExp);
        const ms = getTokenExpiryMs(token);
        expect(ms).toBeGreaterThan(3500_000);
        expect(ms).toBeLessThanOrEqual(3600_000);
    });

    it('should return 0 for an expired token', () => {
        const pastExp = Math.floor(Date.now() / 1000) - 60;
        const token = createJwtPayload(pastExp);
        expect(getTokenExpiryMs(token)).toBe(0);
    });

    it('should return 0 for a malformed token', () => {
        expect(getTokenExpiryMs('not-a-jwt')).toBe(0);
    });

    it('should return 0 for empty string', () => {
        expect(getTokenExpiryMs('')).toBe(0);
    });

    it('should return 0 when payload has no exp claim', () => {
        const header = btoa(JSON.stringify({ alg: 'HS256' }));
        const payload = btoa(JSON.stringify({ id: 'u-1' }));
        const token = `${header}.${payload}.sig`;
        expect(getTokenExpiryMs(token)).toBe(0);
    });
});
