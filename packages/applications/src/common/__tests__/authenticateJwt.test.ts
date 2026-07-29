import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as jwt from 'jsonwebtoken';
import { authenticateJwt } from '../authenticateJwt';

const SECRET = 'test-secret-key';

function createToken(payload: Record<string, unknown>, secret: string = SECRET, options?: jwt.SignOptions): string {
  return jwt.sign(payload, secret, options);
}

describe('authenticateJwt', () => {
  const savedEnv = process.env['JWT_SECRET_KEY'];

  beforeEach(() => {
    delete process.env['JWT_SECRET_KEY'];
  });

  afterEach(() => {
    if (savedEnv !== undefined) {
      process.env['JWT_SECRET_KEY'] = savedEnv;
    } else {
      delete process.env['JWT_SECRET_KEY'];
    }
  });

  it('should decode a valid token with explicit secret', () => {
    const token = createToken({ userId: 'u1', role: 'admin' });

    const decoded = authenticateJwt(token, SECRET) as jwt.JwtPayload;

    expect(decoded.userId).toBe('u1');
    expect(decoded.role).toBe('admin');
  });

  it('should decode a valid token using process.env.JWT_SECRET_KEY when no secret provided', () => {
    const envSecret = 'env-based-secret';
    process.env['JWT_SECRET_KEY'] = envSecret;
    const token = createToken({ userId: 'u2' }, envSecret);

    const decoded = authenticateJwt(token) as jwt.JwtPayload;

    expect(decoded.userId).toBe('u2');
  });

  it("should fall back to 'secret' when no secret and no env var", () => {
    const token = createToken({ userId: 'u3' }, 'secret');

    const decoded = authenticateJwt(token) as jwt.JwtPayload;

    expect(decoded.userId).toBe('u3');
  });

  it("should throw 'Not Authorized' for invalid token", () => {
    const token = createToken({ userId: 'u4' }, 'different-secret');

    expect(() => authenticateJwt(token, SECRET)).toThrow('Not Authorized');
  });

  it("should throw 'Not Authorized' for expired token", () => {
    const token = createToken({ userId: 'u5' }, SECRET, { expiresIn: '0s' });

    expect(() => authenticateJwt(token, SECRET)).toThrow('Not Authorized');
  });

  it("should throw 'Not Authorized' for wrong secret", () => {
    const token = createToken({ userId: 'u6' }, SECRET);

    expect(() => authenticateJwt(token, 'wrong-secret')).toThrow('Not Authorized');
  });

  it("should throw 'Not Authorized' for malformed token string", () => {
    expect(() => authenticateJwt('not.a.real.jwt.token', SECRET)).toThrow('Not Authorized');
    expect(() => authenticateJwt('', SECRET)).toThrow('Not Authorized');
    expect(() => authenticateJwt('abc123', SECRET)).toThrow('Not Authorized');
  });
});
