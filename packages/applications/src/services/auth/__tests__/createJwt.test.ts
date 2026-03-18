import { describe, it, expect } from 'vitest';
import * as jwt from 'jsonwebtoken';
import { createJwt } from '../createJwt';

const SECRET = 'test-secret-key-for-unit-tests';

const basePayload = {
    id: 'user-001',
    firstName: 'Jane',
    lastName: 'Doe',
    email: 'jane@example.com',
    phone: '+1234567890',
    tenantId: 'tenant-001',
    tenantCode: 'ACME',
    roles: ['admin'],
    permissions: ['read:all'],
    jwtSecretKey: SECRET,
    expiresIn: '1h' as const,
};

describe('createJwt', () => {
    it('should return a valid JWT string', () => {
        const token = createJwt(basePayload);

        expect(typeof token).toBe('string');
        const parts = token.split('.');
        expect(parts).toHaveLength(3);
    });

    it('should include payload fields in the token', () => {
        const token = createJwt(basePayload);
        const decoded = jwt.verify(token, SECRET) as jwt.JwtPayload;

        expect(decoded.id).toBe('user-001');
        expect(decoded.firstName).toBe('Jane');
        expect(decoded.lastName).toBe('Doe');
        expect(decoded.email).toBe('jane@example.com');
        expect(decoded.phone).toBe('+1234567890');
        expect(decoded.tenantId).toBe('tenant-001');
        expect(decoded.tenantCode).toBe('ACME');
        expect(decoded.roles).toEqual(['admin']);
        expect(decoded.permissions).toEqual(['read:all']);
    });

    it('should NOT include jwtSecretKey in the token payload', () => {
        const token = createJwt(basePayload);
        const decoded = jwt.verify(token, SECRET) as Record<string, unknown>;

        expect(decoded).not.toHaveProperty('jwtSecretKey');
    });

    it('should NOT include expiresIn in the token payload', () => {
        const token = createJwt(basePayload);
        const decoded = jwt.verify(token, SECRET) as Record<string, unknown>;

        expect(decoded).not.toHaveProperty('expiresIn');
    });

    it('should set the expiration time correctly', () => {
        const token = createJwt({ ...basePayload, expiresIn: '2h' as const });
        const decoded = jwt.verify(token, SECRET) as jwt.JwtPayload;

        expect(decoded.exp).toBeDefined();
        expect(decoded.iat).toBeDefined();

        const expectedExpiry = decoded.iat! + 2 * 60 * 60;
        expect(decoded.exp).toBe(expectedExpiry);
    });

    it('should be verifiable with the same secret key', () => {
        const token = createJwt(basePayload);

        expect(() => jwt.verify(token, SECRET)).not.toThrow();
    });

    it('should fail verification with a different secret key', () => {
        const token = createJwt(basePayload);

        expect(() => jwt.verify(token, 'wrong-secret')).toThrow();
    });
});
