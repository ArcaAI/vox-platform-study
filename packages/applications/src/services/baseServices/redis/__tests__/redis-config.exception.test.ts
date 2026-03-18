/**
 * RedisConfigurationException Unit Tests
 *
 * Tests for the custom Redis configuration exception.
 */

import { describe, it, expect } from 'vitest';
import { RedisConfigurationException } from '../redis-config.exception';
import { BadRequestException } from '@nestjs/common';

describe('RedisConfigurationException', () => {
    describe('constructor', () => {
        it('should create exception with message only', () => {
            const exception = new RedisConfigurationException('Redis not configured');

            expect(exception).toBeInstanceOf(RedisConfigurationException);
            expect(exception).toBeInstanceOf(BadRequestException);
        });

        it('should create exception with message and missing keys', () => {
            const exception = new RedisConfigurationException(
                'Missing configuration',
                ['REDIS_HOST', 'REDIS_PORT']
            );

            expect(exception).toBeInstanceOf(RedisConfigurationException);

            const response = exception.getResponse() as Record<string, any>;
            expect(response.message).toContain('Missing configuration');
            expect(response.message).toContain('REDIS_HOST');
            expect(response.message).toContain('REDIS_PORT');
        });

        it('should include error details with missing keys', () => {
            const exception = new RedisConfigurationException(
                'Missing configuration',
                ['REDIS_HOST', 'REDIS_PORT']
            );

            const response = exception.getResponse() as Record<string, any>;
            expect(response).toHaveProperty('error', 'Redis Configuration Error');
            expect(response.details.missingKeys).toEqual(['REDIS_HOST', 'REDIS_PORT']);
        });

        it('should handle empty missing keys array', () => {
            const exception = new RedisConfigurationException(
                'Configuration error',
                []
            );

            const response = exception.getResponse() as Record<string, any>;
            expect(response.message).toBe('Configuration error');
            expect(response.error).toBe('Redis Configuration Error');
            expect(response.details.missingKeys).toEqual([]);
        });

        it('should handle undefined missing keys', () => {
            const exception = new RedisConfigurationException('Configuration error');

            const response = exception.getResponse() as Record<string, any>;
            expect(response.message).toBe('Configuration error');
            expect(response.error).toBe('Redis Configuration Error');
            expect(response.details.missingKeys).toEqual([]);
        });
    });

    describe('inheritance', () => {
        it('should extend BadRequestException', () => {
            const exception = new RedisConfigurationException('Test');

            expect(exception).toBeInstanceOf(BadRequestException);
            expect(exception).toBeInstanceOf(Error);
        });

        it('should have correct HTTP status code', () => {
            const exception = new RedisConfigurationException('Test');

            expect(exception.getStatus()).toBe(400);
        });
    });

    describe('error response structure', () => {
        it('should have consistent response structure', () => {
            const exception = new RedisConfigurationException(
                'Redis connection failed',
                ['REDIS_HOST']
            );

            const response = exception.getResponse() as Record<string, any>;

            expect(response).toHaveProperty('message');
            expect(response).toHaveProperty('error');
            expect(response.error).toBe('Redis Configuration Error');
            expect(response).toHaveProperty('statusCode', 400);
            expect(response).toHaveProperty('details');
            expect(response.details).toHaveProperty('service', 'RedisService');
            expect(response.details).toHaveProperty('timestamp');
        });

        it('should be serializable to JSON', () => {
            const exception = new RedisConfigurationException(
                'Test error',
                ['KEY1', 'KEY2']
            );

            const response = exception.getResponse();
            const json = JSON.stringify(response);
            const parsed = JSON.parse(json);

            expect(parsed.message).toContain('Test error');
            expect(parsed.details.missingKeys).toEqual(['KEY1', 'KEY2']);
        });
    });
});
