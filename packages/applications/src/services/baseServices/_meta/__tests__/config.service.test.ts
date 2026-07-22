/**
 * ConfigService Unit Tests
 *
 * Tests for the configuration service that manages static application configuration.
 *
 * Testing Strategy:
 * - Test actual configuration behavior, not just that values are set
 * - Verify configuration validation catches real errors
 * - Test edge cases for environment variable parsing
 * - Use real process.env manipulation (not mocked) for accurate behavior testing
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { ConfigService } from '../config/config.service';
import type { ConfigModuleOptions } from '../config/config.module';

// Mock only the env utility - this is an external boundary for .env file loading
vi.mock('../../../../common/env', () => ({
    loadEnv: vi.fn().mockReturnValue({
        loaded: false,
        nodeEnv: 'test',
        isCI: false,
    }),
    getNodeEnv: vi.fn().mockReturnValue('test'),
    isCI: vi.fn().mockReturnValue(false),
}));

describe('ConfigService', () => {
    const originalEnv = process.env;

    beforeEach(() => {
        vi.clearAllMocks();
        // Reset environment variables
        process.env = {
            ...originalEnv,
            NODE_ENV: 'test',
        };
    });

    afterEach(() => {
        process.env = originalEnv;
        vi.restoreAllMocks();
    });

    const createService = (options: ConfigModuleOptions = {}) => {
        return new ConfigService(options);
    };

    describe('constructor', () => {
        it('should create service with complete default configuration', () => {
            const service = createService();

            // Verify BEHAVIOR: all essential config values are present
            expect(service.config).toBeDefined();
            expect(service.config.NODE_ENV).toBeDefined();
            expect(service.config.SERVICE_NAME).toBeDefined();
            expect(service.config.PORT).toBeDefined();
            expect(service.config.LOG_LEVEL).toBeDefined();
        });

        it('should load configuration from environment variables correctly', () => {
            process.env.NODE_ENV = 'development';
            process.env.DEBUG = 'true';
            process.env.SERVICE_NAME = 'test-api';
            process.env.PORT = '3000';

            const service = createService();

            // Verify BEHAVIOR: env vars are correctly loaded and typed
            expect(service.config.NODE_ENV).toBe('development');
            expect(service.config.DEBUG).toBe(true); // Should be boolean, not string
            expect(service.config.SERVICE_NAME).toBe('test-api');
            expect(service.config.PORT).toBe('3000');
        });

        it('should provide sensible defaults when environment variables are not set', () => {
            delete process.env.SERVICE_NAME;
            delete process.env.PORT;
            delete process.env.LOG_LEVEL;

            const service = createService();

            // Verify BEHAVIOR: defaults allow service to function
            expect(service.config.SERVICE_NAME).toBe('hope-api');
            expect(service.config.PORT).toBe('8868');
            expect(service.config.LOG_LEVEL).toBe('info');
        });

        it('should allow initial values to override environment variables', () => {
            process.env.SERVICE_NAME = 'env-service';

            const service = createService({
                initialValues: {
                    SERVICE_NAME: 'custom-service',
                    DEBUG: true,
                },
            });

            // Verify BEHAVIOR: initial values take precedence
            expect(service.config.SERVICE_NAME).toBe('custom-service');
            expect(service.config.DEBUG).toBe(true);
        });

        it('should correctly parse boolean environment variables', () => {
            // Test various boolean representations
            process.env.DEBUG = 'true';
            process.env.NEST_DEBUG = 'false';
            process.env.LOG_FILE_ENABLED = 'true';

            const service = createService();

            // Verify BEHAVIOR: booleans are actual boolean type
            expect(service.config.DEBUG).toBe(true);
            expect(typeof service.config.DEBUG).toBe('boolean');
            expect(service.config.NEST_DEBUG).toBe(false);
            expect(typeof service.config.NEST_DEBUG).toBe('boolean');
            expect(service.config.LOG_FILE_ENABLED).toBe(true);
        });

        it('should correctly parse numeric environment variables', () => {
            process.env.REDIS_PORT = '6380';
            process.env.MQTT_PORT = '1884';
            process.env.LOG_FILE_MAX_FILES = '500';

            const service = createService();

            // Verify BEHAVIOR: numbers are actual number type
            expect(service.config.REDIS_PORT).toBe(6380);
            expect(typeof service.config.REDIS_PORT).toBe('number');
            expect(service.config.MQTT_PORT).toBe(1884);
            expect(typeof service.config.MQTT_PORT).toBe('number');
            expect(service.config.LOG_FILE_MAX_FILES).toBe(500);
        });

        it('defaults REGISTRATION_SELF_SIGNUP_ENABLED to false when unset', () => {
            delete process.env.REGISTRATION_SELF_SIGNUP_ENABLED;

            const service = createService();

            expect(service.config.REGISTRATION_SELF_SIGNUP_ENABLED).toBe(false);
        });

        it('reads REGISTRATION_SELF_SIGNUP_ENABLED=true as a boolean', () => {
            process.env.REGISTRATION_SELF_SIGNUP_ENABLED = 'true';

            const service = createService();

            expect(service.config.REGISTRATION_SELF_SIGNUP_ENABLED).toBe(true);
            expect(typeof service.config.REGISTRATION_SELF_SIGNUP_ENABLED).toBe('boolean');
        });

        it('should handle edge cases in boolean parsing', () => {
            // Test that only lowercase 'true' is truthy (case-sensitive)
            process.env.DEBUG = 'true';
            const service1 = createService();
            expect(service1.config.DEBUG).toBe(true);

            // 'TRUE' uppercase is not parsed as true
            process.env.DEBUG = 'TRUE';
            const service2 = createService();
            expect(service2.config.DEBUG).toBe(false);

            // '1' should not be parsed as true (only 'true' string)
            process.env.DEBUG = '1';
            const service3 = createService();
            expect(service3.config.DEBUG).toBe(false);
        });
    });

    describe('onModuleInit', () => {
        it('should load configuration on module init', async () => {
            const service = createService();

            await service.onModuleInit();

            expect(service.config).toBeDefined();
        });
    });

    describe('loadConfig', () => {
        it('should load and validate configuration', async () => {
            const service = createService();

            await service.loadConfig();

            expect(service.config).toBeDefined();
            expect(service.config.NODE_ENV).toBeDefined();
        });

        it('should throw error for invalid Redis port', async () => {
            process.env.REDIS_HOST = 'localhost';
            process.env.REDIS_PORT = '99999'; // Invalid port

            const service = createService();

            await expect(service.loadConfig()).rejects.toThrow('Configuration validation failed');
        });

        it('should throw error for negative Redis port', async () => {
            process.env.REDIS_HOST = 'localhost';
            process.env.REDIS_PORT = '-1';

            const service = createService();

            await expect(service.loadConfig()).rejects.toThrow('Configuration validation failed');
        });
    });

    describe('getConfiguration', () => {
        it('should return the complete configuration object', () => {
            process.env.SERVICE_NAME = 'my-service';
            const service = createService();

            const config = service.getConfiguration();

            expect(config).toBeDefined();
            expect(config.SERVICE_NAME).toBe('my-service');
        });
    });

    describe('getConfigValue', () => {
        it('should return specific configuration value', () => {
            process.env.SERVICE_NAME = 'test-service';
            process.env.PORT = '4000';

            const service = createService();

            expect(service.getConfigValue('SERVICE_NAME')).toBe('test-service');
            expect(service.getConfigValue('PORT')).toBe('4000');
        });
    });

    describe('reloadConfiguration', () => {
        it('should reload configuration from environment', async () => {
            const service = createService();
            process.env.SERVICE_NAME = 'original-service';
            await service.loadConfig();

            process.env.SERVICE_NAME = 'reloaded-service';
            await service.reloadConfiguration();

            expect(service.config.SERVICE_NAME).toBe('reloaded-service');
        });
    });

    describe('isDevelopment', () => {
        it('should return true when NODE_ENV is development', () => {
            process.env.NODE_ENV = 'development';
            const service = createService();

            expect(service.isDevelopment()).toBe(true);
        });

        it('should return false when NODE_ENV is not development', () => {
            process.env.NODE_ENV = 'production';
            const service = createService();

            expect(service.isDevelopment()).toBe(false);
        });
    });

    describe('isProduction', () => {
        it('should return true when NODE_ENV is production', () => {
            process.env.NODE_ENV = 'production';
            const service = createService();

            expect(service.isProduction()).toBe(true);
        });

        it('should return false when NODE_ENV is not production', () => {
            process.env.NODE_ENV = 'development';
            const service = createService();

            expect(service.isProduction()).toBe(false);
        });
    });

    describe('isDebugEnabled', () => {
        it('should return true when DEBUG is true', () => {
            process.env.DEBUG = 'true';
            const service = createService();

            expect(service.isDebugEnabled()).toBe(true);
        });

        it('should return false when DEBUG is false', () => {
            process.env.DEBUG = 'false';
            const service = createService();

            expect(service.isDebugEnabled()).toBe(false);
        });

        it('should return false when DEBUG is not set', () => {
            delete process.env.DEBUG;
            const service = createService();

            expect(service.isDebugEnabled()).toBe(false);
        });
    });

    describe('isRedisConfigured', () => {
        it('should return true when Redis is properly configured with valid host and port', () => {
            process.env.REDIS_HOST = 'localhost';
            process.env.REDIS_PORT = '6379';

            const service = createService();

            // Verify BEHAVIOR: method correctly identifies valid Redis config
            expect(service.isRedisConfigured()).toBe(true);
        });

        it('should use default host when REDIS_HOST is not set', () => {
            delete process.env.REDIS_HOST;
            process.env.REDIS_PORT = '6379';

            const service = createService();

            // Verify BEHAVIOR: default host allows Redis to be considered configured
            expect(service.isRedisConfigured()).toBe(true);
            expect(service.getRedisConfig().host).toBe('localhost');
        });

        it('should return false for port 0 (invalid)', () => {
            process.env.REDIS_HOST = 'localhost';
            process.env.REDIS_PORT = '0';

            const service = createService();

            // Verify BEHAVIOR: port 0 is rejected as invalid
            expect(service.isRedisConfigured()).toBe(false);
        });

        it('should return false for port exceeding 65535', () => {
            process.env.REDIS_HOST = 'localhost';
            process.env.REDIS_PORT = '70000';

            const service = createService();

            // Verify BEHAVIOR: ports above valid range are rejected
            expect(service.isRedisConfigured()).toBe(false);
        });

        it('should return false for negative port', () => {
            process.env.REDIS_HOST = 'localhost';
            process.env.REDIS_PORT = '-1';

            const service = createService();

            // Verify BEHAVIOR: negative ports are rejected
            expect(service.isRedisConfigured()).toBe(false);
        });

        it('should return false for non-numeric port', () => {
            process.env.REDIS_HOST = 'localhost';
            process.env.REDIS_PORT = 'invalid';

            const service = createService();

            // Verify BEHAVIOR: non-numeric ports are rejected
            expect(service.isRedisConfigured()).toBe(false);
        });
    });

    describe('getRedisConfig', () => {
        it('should return Redis configuration when valid', () => {
            process.env.REDIS_HOST = 'redis.example.com';
            process.env.REDIS_PORT = '6380';
            process.env.REDIS_PASS = 'secret';

            const service = createService();
            const redisConfig = service.getRedisConfig();

            expect(redisConfig.host).toBe('redis.example.com');
            expect(redisConfig.port).toBe(6380);
            expect(redisConfig.password).toBe('secret');
        });

        it('should return undefined password when not set', () => {
            process.env.REDIS_HOST = 'localhost';
            process.env.REDIS_PORT = '6379';
            delete process.env.REDIS_PASS;

            const service = createService();
            const redisConfig = service.getRedisConfig();

            expect(redisConfig.password).toBeUndefined();
        });

        it('should throw error when Redis is not configured', () => {
            process.env.REDIS_HOST = 'localhost';
            process.env.REDIS_PORT = '0'; // Invalid port

            const service = createService();

            expect(() => service.getRedisConfig()).toThrow('Redis configuration is not available or invalid');
        });
    });

    describe('LOG configuration', () => {
        it('should load LOG configuration from environment', () => {
            process.env.LOG_LEVEL = 'debug';
            process.env.LOG_FILE_ENABLED = 'true';
            process.env.LOG_FILE_PATH = '/var/log/app';
            process.env.LOG_FILE_MAX_SIZE = '20m';
            process.env.LOG_FILE_MAX_FILES = '2000';
            process.env.LOG_FILE_DATE_PATTERN = 'yyyy-MM-dd-HH';
            process.env.LOG_FILE_SEPARATE_ERROR = 'true';

            const service = createService();

            expect(service.config.LOG_LEVEL).toBe('debug');
            expect(service.config.LOG_FILE_ENABLED).toBe(true);
            expect(service.config.LOG_FILE_PATH).toBe('/var/log/app');
            expect(service.config.LOG_FILE_MAX_SIZE).toBe('20m');
            expect(service.config.LOG_FILE_MAX_FILES).toBe(2000);
            expect(service.config.LOG_FILE_DATE_PATTERN).toBe('yyyy-MM-dd-HH');
            expect(service.config.LOG_FILE_SEPARATE_ERROR).toBe(true);
        });

        it('should use default LOG configuration', () => {
            delete process.env.LOG_LEVEL;
            delete process.env.LOG_FILE_ENABLED;
            delete process.env.LOG_FILE_PATH;

            const service = createService();

            expect(service.config.LOG_LEVEL).toBe('info');
            expect(service.config.LOG_FILE_ENABLED).toBe(false);
            expect(service.config.LOG_FILE_PATH).toBe('./logs');
        });
    });

    describe('service URLs configuration', () => {
        it('should load service URLs from environment', () => {
            process.env.URL = 'http://api.example.com';
            process.env.STT_V2_URL = 'http://stt-v2.example.com:8012';
            process.env.GUARDRAIL_URL = 'http://guardrail.example.com:8863';

            const service = createService();

            expect(service.config.URL).toBe('http://api.example.com');
            expect(service.config.STT_V2_URL).toBe('http://stt-v2.example.com:8012');
            expect(service.config.GUARDRAIL_URL).toBe('http://guardrail.example.com:8863');
        });

        it('should use default service URLs', () => {
            delete process.env.URL;
            delete process.env.STT_V2_URL;
            delete process.env.GUARDRAIL_URL;

            const service = createService();

            expect(service.config.URL).toBe('http://localhost');
            expect(service.config.STT_V2_URL).toBe('http://localhost:8861');
            expect(service.config.GUARDRAIL_URL).toBe('http://localhost:8863');
        });
    });

    describe('MQTT configuration', () => {
        it('should load MQTT configuration from environment', () => {
            process.env.MQTT_HOST = 'mqtt.example.com';
            process.env.MQTT_PORT = '1884';
            process.env.MQTT_USER = 'mqtt-user';
            process.env.MQTT_PASS = 'mqtt-pass';

            const service = createService();

            expect(service.config.MQTT_HOST).toBe('mqtt.example.com');
            expect(service.config.MQTT_PORT).toBe(1884);
            expect(service.config.MQTT_USER).toBe('mqtt-user');
            expect(service.config.MQTT_PASS).toBe('mqtt-pass');
        });

        it('should use default MQTT configuration', () => {
            delete process.env.MQTT_HOST;
            delete process.env.MQTT_PORT;
            delete process.env.MQTT_USER;
            delete process.env.MQTT_PASS;

            const service = createService();

            expect(service.config.MQTT_HOST).toBe('localhost');
            expect(service.config.MQTT_PORT).toBe(1883);
            expect(service.config.MQTT_USER).toBe('');
            expect(service.config.MQTT_PASS).toBe('');
        });
    });
});
