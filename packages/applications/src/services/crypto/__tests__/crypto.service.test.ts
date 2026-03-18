/**
 * CryptoService Unit Tests
 *
 * Tests for the CryptoService that handles password hashing and encryption/decryption.
 *
 * Testing Strategy:
 * - Hash/verify tests mock bcrypt to isolate the service logic
 * - Encrypt/decrypt tests use REAL crypto operations to verify actual behavior
 * - This follows the principle: "Mock at boundaries, not internally"
 * - bcrypt is an external boundary (library), crypto is internal (Node.js built-in)
 */

import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { CryptoService } from '../crypto.service';
import * as bcrypt from 'bcryptjs';

// Mock bcryptjs (external library boundary)
// We mock bcryptjs because it's an external dependency with slow operations
vi.mock('bcryptjs', () => ({
    hash: vi.fn(),
    compare: vi.fn(),
}));

// Mock AppSettingsService (dependency injection boundary)
const mockAppSettingsService = {
    getValueWithDefault: vi.fn(),
};

vi.mock('@nestjs/common', async () => {
    const actual = await vi.importActual('@nestjs/common');
    return {
        ...actual,
        Logger: class MockLogger {
            log = vi.fn();
            debug = vi.fn();
            warn = vi.fn();
            error = vi.fn();
        },
    };
});

describe('CryptoService', () => {
    let service: CryptoService;

    beforeEach(async () => {
        vi.clearAllMocks();

        // Default settings
        mockAppSettingsService.getValueWithDefault.mockImplementation((key: string, defaultValue: any) => {
            switch (key) {
                case 'crypto.saltRounds':
                    return 10;
                case 'crypto.algorithm':
                    return 'aes-256-cbc';
                case 'crypto.ivLength':
                    return 16;
                default:
                    return defaultValue;
            }
        });

        // Create service instance with mocks
        service = new CryptoService(mockAppSettingsService as any);

        // Call onModuleInit to load settings
        await service.onModuleInit();
    });

    afterEach(() => {
        vi.clearAllMocks();
    });

    describe('onModuleInit', () => {
        it('should load settings on initialization', async () => {
            const newService = new CryptoService(mockAppSettingsService as any);
            await newService.onModuleInit();

            expect(mockAppSettingsService.getValueWithDefault).toHaveBeenCalledWith('crypto.saltRounds', 10);
            expect(mockAppSettingsService.getValueWithDefault).toHaveBeenCalledWith('crypto.algorithm', 'aes-256-cbc');
            expect(mockAppSettingsService.getValueWithDefault).toHaveBeenCalledWith('crypto.ivLength', 16);
        });

        it('should use default values when settings not available', async () => {
            mockAppSettingsService.getValueWithDefault.mockImplementation((key: string, defaultValue: any) => defaultValue);

            const newService = new CryptoService(mockAppSettingsService as any);
            await newService.onModuleInit();

            // Service should work with defaults
            expect(mockAppSettingsService.getValueWithDefault).toHaveBeenCalled();
        });
    });

    describe('hash', () => {
        it('should hash a password using bcrypt', async () => {
            const password = 'testPassword123';
            const hashedPassword = '$2b$10$hashedPasswordValue';
            vi.mocked(bcrypt.hash).mockResolvedValue(hashedPassword as never);

            const result = await service.hash(password);

            expect(result).toBe(hashedPassword);
            expect(bcrypt.hash).toHaveBeenCalledWith(password, 10);
        });

        it('should use configured salt rounds', async () => {
            mockAppSettingsService.getValueWithDefault.mockImplementation((key: string, defaultValue: any) => {
                if (key === 'crypto.saltRounds') return 12;
                return defaultValue;
            });

            const newService = new CryptoService(mockAppSettingsService as any);
            await newService.onModuleInit();

            const password = 'testPassword123';
            vi.mocked(bcrypt.hash).mockResolvedValue('$2b$12$hashed' as never);

            await newService.hash(password);

            expect(bcrypt.hash).toHaveBeenCalledWith(password, 12);
        });

        it('should handle empty password', async () => {
            vi.mocked(bcrypt.hash).mockResolvedValue('$2b$10$emptyHash' as never);

            const result = await service.hash('');

            expect(result).toBe('$2b$10$emptyHash');
            expect(bcrypt.hash).toHaveBeenCalledWith('', 10);
        });

        it('should handle special characters in password', async () => {
            const password = 'p@$$w0rd!#$%^&*()';
            vi.mocked(bcrypt.hash).mockResolvedValue('$2b$10$specialHash' as never);

            const result = await service.hash(password);

            expect(result).toBe('$2b$10$specialHash');
            expect(bcrypt.hash).toHaveBeenCalledWith(password, 10);
        });

        it('should handle unicode characters in password', async () => {
            const password = 'пароль密码🔐';
            vi.mocked(bcrypt.hash).mockResolvedValue('$2b$10$unicodeHash' as never);

            const result = await service.hash(password);

            expect(result).toBe('$2b$10$unicodeHash');
            expect(bcrypt.hash).toHaveBeenCalledWith(password, 10);
        });
    });

    describe('verify', () => {
        it('should return true for correct password', async () => {
            const password = 'testPassword123';
            const hash = '$2b$10$hashedPasswordValue';
            vi.mocked(bcrypt.compare).mockResolvedValue(true as never);

            const result = await service.verify(password, hash);

            expect(result).toBe(true);
            expect(bcrypt.compare).toHaveBeenCalledWith(password, hash);
        });

        it('should return false for incorrect password', async () => {
            const password = 'wrongPassword';
            const hash = '$2b$10$hashedPasswordValue';
            vi.mocked(bcrypt.compare).mockResolvedValue(false as never);

            const result = await service.verify(password, hash);

            expect(result).toBe(false);
            expect(bcrypt.compare).toHaveBeenCalledWith(password, hash);
        });

        it('should handle empty password verification', async () => {
            vi.mocked(bcrypt.compare).mockResolvedValue(false as never);

            const result = await service.verify('', '$2b$10$hash');

            expect(result).toBe(false);
        });

        it('should handle special characters in verification', async () => {
            const password = 'p@$$w0rd!#$%^&*()';
            vi.mocked(bcrypt.compare).mockResolvedValue(true as never);

            const result = await service.verify(password, '$2b$10$hash');

            expect(result).toBe(true);
            expect(bcrypt.compare).toHaveBeenCalledWith(password, '$2b$10$hash');
        });
    });

    describe('encrypt', () => {
        it('should encrypt data and return iv:encrypted format', async () => {
            const data = 'sensitive data';
            const key = '12345678901234567890123456789012'; // 32 bytes for AES-256

            const result = await service.encrypt(data, key);

            // Result should be in format iv:encryptedData
            expect(result).toMatch(/^[a-f0-9]+:[a-f0-9]+$/);
            const [iv, encrypted] = result.split(':');
            expect(iv).toHaveLength(32); // 16 bytes = 32 hex chars
            expect(encrypted.length).toBeGreaterThan(0);
        });

        it('should produce different output for same input (due to random IV)', async () => {
            const data = 'sensitive data';
            const key = '12345678901234567890123456789012';

            const result1 = await service.encrypt(data, key);
            const result2 = await service.encrypt(data, key);

            // IVs should be different
            const [iv1] = result1.split(':');
            const [iv2] = result2.split(':');
            expect(iv1).not.toBe(iv2);
        });

        it('should handle empty data', async () => {
            const key = '12345678901234567890123456789012';

            const result = await service.encrypt('', key);

            expect(result).toMatch(/^[a-f0-9]+:[a-f0-9]+$/);
        });

        it('should handle special characters in data', async () => {
            const data = 'data with special chars: !@#$%^&*(){}[]';
            const key = '12345678901234567890123456789012';

            const result = await service.encrypt(data, key);

            expect(result).toMatch(/^[a-f0-9]+:[a-f0-9]+$/);
        });

        it('should handle unicode data', async () => {
            const data = 'данные 数据 🔐';
            const key = '12345678901234567890123456789012';

            const result = await service.encrypt(data, key);

            expect(result).toMatch(/^[a-f0-9]+:[a-f0-9]+$/);
        });

        it('should handle long data', async () => {
            const data = 'a'.repeat(10000);
            const key = '12345678901234567890123456789012';

            const result = await service.encrypt(data, key);

            expect(result).toMatch(/^[a-f0-9]+:[a-f0-9]+$/);
        });
    });

    describe('decrypt', () => {
        it('should decrypt data correctly', async () => {
            const originalData = 'sensitive data';
            const key = '12345678901234567890123456789012';

            const encrypted = await service.encrypt(originalData, key);
            const decrypted = await service.decrypt(encrypted, key);

            expect(decrypted).toBe(originalData);
        });

        it('should decrypt empty data', async () => {
            const key = '12345678901234567890123456789012';

            const encrypted = await service.encrypt('', key);
            const decrypted = await service.decrypt(encrypted, key);

            expect(decrypted).toBe('');
        });

        it('should decrypt special characters', async () => {
            const originalData = 'data with special chars: !@#$%^&*(){}[]';
            const key = '12345678901234567890123456789012';

            const encrypted = await service.encrypt(originalData, key);
            const decrypted = await service.decrypt(encrypted, key);

            expect(decrypted).toBe(originalData);
        });

        it('should decrypt unicode data', async () => {
            const originalData = 'данные 数据 🔐';
            const key = '12345678901234567890123456789012';

            const encrypted = await service.encrypt(originalData, key);
            const decrypted = await service.decrypt(encrypted, key);

            expect(decrypted).toBe(originalData);
        });

        it('should decrypt long data', async () => {
            const originalData = 'a'.repeat(10000);
            const key = '12345678901234567890123456789012';

            const encrypted = await service.encrypt(originalData, key);
            const decrypted = await service.decrypt(encrypted, key);

            expect(decrypted).toBe(originalData);
        });

        it('should throw error for invalid encrypted format', async () => {
            const key = '12345678901234567890123456789012';

            await expect(service.decrypt('invalid-format', key)).rejects.toThrow();
        });

        it('should throw error for wrong key', async () => {
            const originalData = 'sensitive data';
            const key1 = '12345678901234567890123456789012';
            const key2 = 'abcdefghijklmnopqrstuvwxyz123456';

            const encrypted = await service.encrypt(originalData, key1);

            await expect(service.decrypt(encrypted, key2)).rejects.toThrow();
        });

        it('should throw error for corrupted encrypted data', async () => {
            const key = '12345678901234567890123456789012';
            const corruptedData = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa:corrupted';

            await expect(service.decrypt(corruptedData, key)).rejects.toThrow();
        });
    });

    describe('encrypt/decrypt integration', () => {
        it('should successfully encrypt and decrypt multiple times', async () => {
            const key = '12345678901234567890123456789012';
            const testCases = [
                'simple text',
                'text with numbers 12345',
                'special !@#$%^&*()',
                'unicode: 日本語 한국어 العربية',
                JSON.stringify({ key: 'value', nested: { data: true } }),
            ];

            for (const originalData of testCases) {
                const encrypted = await service.encrypt(originalData, key);
                const decrypted = await service.decrypt(encrypted, key);
                expect(decrypted).toBe(originalData);
            }
        });

        it('should handle JSON data encryption/decryption', async () => {
            const key = '12345678901234567890123456789012';
            const jsonData = JSON.stringify({
                userId: 'user-123',
                email: 'test@example.com',
                roles: ['admin', 'user'],
                metadata: {
                    createdAt: '2026-01-30T10:00:00Z',
                    isActive: true,
                },
            });

            const encrypted = await service.encrypt(jsonData, key);
            const decrypted = await service.decrypt(encrypted, key);

            expect(JSON.parse(decrypted)).toEqual(JSON.parse(jsonData));
        });
    });

    describe('Settings Update Event', () => {
        it('should reload settings when AppSettings are updated', async () => {
            // Clear previous calls
            mockAppSettingsService.getValueWithDefault.mockClear();

            // Update settings
            mockAppSettingsService.getValueWithDefault.mockImplementation((key: string, defaultValue: any) => {
                if (key === 'crypto.saltRounds') return 14;
                return defaultValue;
            });

            // Trigger settings update (accessing private method via any)
            await (service as any).handleSettingsUpdate();

            // Verify settings were reloaded
            expect(mockAppSettingsService.getValueWithDefault).toHaveBeenCalledWith('crypto.saltRounds', 10);
        });
    });

    describe('Configuration', () => {
        it('should use custom salt rounds from settings', async () => {
            mockAppSettingsService.getValueWithDefault.mockImplementation((key: string, defaultValue: any) => {
                if (key === 'crypto.saltRounds') return 15;
                return defaultValue;
            });

            const newService = new CryptoService(mockAppSettingsService as any);
            await newService.onModuleInit();

            vi.mocked(bcrypt.hash).mockResolvedValue('$2b$15$hash' as never);
            await newService.hash('password');

            expect(bcrypt.hash).toHaveBeenCalledWith('password', 15);
        });

        it('should use custom algorithm from settings', async () => {
            // Note: Changing algorithm would require matching key size
            // This test verifies settings are loaded
            mockAppSettingsService.getValueWithDefault.mockImplementation((key: string, defaultValue: any) => {
                if (key === 'crypto.algorithm') return 'aes-256-cbc';
                return defaultValue;
            });

            const newService = new CryptoService(mockAppSettingsService as any);
            await newService.onModuleInit();

            expect(mockAppSettingsService.getValueWithDefault).toHaveBeenCalledWith('crypto.algorithm', 'aes-256-cbc');
        });

        it('should use custom IV length from settings', async () => {
            mockAppSettingsService.getValueWithDefault.mockImplementation((key: string, defaultValue: any) => {
                if (key === 'crypto.ivLength') return 16;
                return defaultValue;
            });

            const newService = new CryptoService(mockAppSettingsService as any);
            await newService.onModuleInit();

            expect(mockAppSettingsService.getValueWithDefault).toHaveBeenCalledWith('crypto.ivLength', 16);
        });
    });

    describe('Security Properties', () => {
        it('should produce different hashes for same password (salt uniqueness)', async () => {
            // This tests that bcrypt is called correctly - actual salt uniqueness is bcrypt's responsibility
            vi.mocked(bcrypt.hash)
                .mockResolvedValueOnce('$2b$10$uniqueHash1' as never)
                .mockResolvedValueOnce('$2b$10$uniqueHash2' as never);

            const hash1 = await service.hash('samePassword');
            const hash2 = await service.hash('samePassword');

            // Hashes should be different due to unique salts
            expect(hash1).not.toBe(hash2);
        });

        it('should produce different encrypted output for same plaintext (IV uniqueness)', async () => {
            const key = '12345678901234567890123456789012';
            const plaintext = 'sensitive data';

            const encrypted1 = await service.encrypt(plaintext, key);
            const encrypted2 = await service.encrypt(plaintext, key);

            // Encrypted outputs should differ due to random IV
            expect(encrypted1).not.toBe(encrypted2);

            // But both should decrypt to the same value
            const decrypted1 = await service.decrypt(encrypted1, key);
            const decrypted2 = await service.decrypt(encrypted2, key);
            expect(decrypted1).toBe(plaintext);
            expect(decrypted2).toBe(plaintext);
        });

        it('should not leak plaintext in encrypted output', async () => {
            const key = '12345678901234567890123456789012';
            const plaintext = 'SENSITIVE_SECRET_DATA';

            const encrypted = await service.encrypt(plaintext, key);

            // Encrypted output should not contain the plaintext
            expect(encrypted).not.toContain(plaintext);
            expect(encrypted).not.toContain('SENSITIVE');
            expect(encrypted).not.toContain('SECRET');
        });
    });

    describe('Error Messages', () => {
        it('should throw meaningful error for malformed encrypted data', async () => {
            const key = '12345678901234567890123456789012';

            // Missing colon separator
            await expect(service.decrypt('nocolonseparator', key)).rejects.toThrow();
        });

        it('should throw error when IV is invalid hex', async () => {
            const key = '12345678901234567890123456789012';

            // Invalid hex in IV portion
            await expect(service.decrypt('ZZZZ:abcd1234', key)).rejects.toThrow();
        });

        it('should throw error for key length mismatch', async () => {
            const shortKey = '12345'; // Too short for AES-256
            const plaintext = 'test data';

            await expect(service.encrypt(plaintext, shortKey)).rejects.toThrow();
        });
    });

    describe('Boundary Conditions', () => {
        it('should handle maximum reasonable data size', async () => {
            const key = '12345678901234567890123456789012';
            // 1MB of data
            const largeData = 'x'.repeat(1024 * 1024);

            const encrypted = await service.encrypt(largeData, key);
            const decrypted = await service.decrypt(encrypted, key);

            expect(decrypted).toBe(largeData);
        });

        it('should handle binary-like string data', async () => {
            const key = '12345678901234567890123456789012';
            // String with null characters and control characters
            const binaryLike = 'data\x00with\x01control\x02chars';

            const encrypted = await service.encrypt(binaryLike, key);
            const decrypted = await service.decrypt(encrypted, key);

            expect(decrypted).toBe(binaryLike);
        });

        it('should handle newlines and whitespace correctly', async () => {
            const key = '12345678901234567890123456789012';
            const dataWithWhitespace = '  line1\n\tline2\r\n  line3  ';

            const encrypted = await service.encrypt(dataWithWhitespace, key);
            const decrypted = await service.decrypt(encrypted, key);

            expect(decrypted).toBe(dataWithWhitespace);
        });
    });
});
