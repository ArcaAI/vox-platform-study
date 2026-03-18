/**
 * AsrPipelineFactory Unit Tests
 *
 * Tests for the AsrPipelineFactory that creates AsrPipeline entities.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AsrPipelineFactory, CreateAsrPipelineProps } from '../AsrPipelineFactory';
import { ResourceStatusType } from '../../../../enums';

// Mock the generateId function
vi.mock('../../../../utils', () => ({
    generateId: vi.fn(() => 'generated-uuid-7'),
}));

// Sample YAML configs for testing
const validConfigYaml = `
version: "1.0"

models:
  asr: "whisper-large-v3"
  vad: "silero-vad-v4"

preprocessing:
  vad:
    enabled: true
    threshold: 0.5

inference:
  batch_size: 16
  compute_type: float16
`;

const minimalConfigYaml = `
version: "1.0"

models:
  asr: "whisper-tiny"

inference:
  batch_size: 8
`;

describe('AsrPipelineFactory', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    describe('CreateAsrPipeline', () => {
        const baseProps: CreateAsrPipelineProps = {
            name: 'Medical Transcription Pipeline',
            slug: 'medical-transcription',
            configYaml: validConfigYaml,
        };

        it('should create a pipeline with required fields', () => {
            const pipeline = AsrPipelineFactory.CreateAsrPipeline(baseProps);

            expect(pipeline.id).toBe('generated-uuid-7');
            expect(pipeline.name).toBe('Medical Transcription Pipeline');
            expect(pipeline.slug).toBe('medical-transcription');
            expect(pipeline.configYaml).toBe(validConfigYaml);
        });

        it('should set createdAt and updatedAt to current time', () => {
            const beforeCreate = new Date();
            const pipeline = AsrPipelineFactory.CreateAsrPipeline(baseProps);
            const afterCreate = new Date();

            expect(pipeline.createdAt.getTime()).toBeGreaterThanOrEqual(beforeCreate.getTime());
            expect(pipeline.createdAt.getTime()).toBeLessThanOrEqual(afterCreate.getTime());
            expect(pipeline.updatedAt.getTime()).toBeGreaterThanOrEqual(beforeCreate.getTime());
            expect(pipeline.updatedAt.getTime()).toBeLessThanOrEqual(afterCreate.getTime());
        });

        it('should allow custom createdAt and updatedAt', () => {
            const customDate = new Date('2026-01-15T10:00:00Z');
            const pipeline = AsrPipelineFactory.CreateAsrPipeline({
                ...baseProps,
                createdAt: customDate,
                updatedAt: customDate,
            });

            expect(pipeline.createdAt).toEqual(customDate);
            expect(pipeline.updatedAt).toEqual(customDate);
        });

        it('should set optional description', () => {
            const pipeline = AsrPipelineFactory.CreateAsrPipeline({
                ...baseProps,
                description: 'Pipeline for medical consultation transcription',
            });

            expect(pipeline.description).toBe('Pipeline for medical consultation transcription');
        });

        it('should default description to null', () => {
            const pipeline = AsrPipelineFactory.CreateAsrPipeline(baseProps);

            expect(pipeline.description).toBeNull();
        });

        it('should set optional tenantId', () => {
            const pipeline = AsrPipelineFactory.CreateAsrPipeline({
                ...baseProps,
                tenantId: 'tenant-123',
            });

            expect(pipeline.tenantId).toBe('tenant-123');
        });

        it('should default tenantId to empty string', () => {
            const pipeline = AsrPipelineFactory.CreateAsrPipeline(baseProps);

            expect(pipeline.tenantId).toBe('');
        });

        it('should set optional tags', () => {
            const pipeline = AsrPipelineFactory.CreateAsrPipeline({
                ...baseProps,
                tags: ['medical', 'transcription', 'whisper'],
            });

            expect(pipeline.tags).toEqual(['medical', 'transcription', 'whisper']);
        });

        it('should default tags to empty array', () => {
            const pipeline = AsrPipelineFactory.CreateAsrPipeline(baseProps);

            expect(pipeline.tags).toEqual([]);
        });

        it('should set createdBy when provided', () => {
            const pipeline = AsrPipelineFactory.CreateAsrPipeline({
                ...baseProps,
                createdBy: 'user-123',
            });

            expect(pipeline.createdBy).toBe('user-123');
        });

        it('should default createdBy to null', () => {
            const pipeline = AsrPipelineFactory.CreateAsrPipeline(baseProps);

            expect(pipeline.createdBy).toBeNull();
        });

        it('should set updatedBy when provided', () => {
            const pipeline = AsrPipelineFactory.CreateAsrPipeline({
                ...baseProps,
                updatedBy: 'user-456',
            });

            expect(pipeline.updatedBy).toBe('user-456');
        });

        it('should default updatedBy to null', () => {
            const pipeline = AsrPipelineFactory.CreateAsrPipeline(baseProps);

            expect(pipeline.updatedBy).toBeNull();
        });

        it('should create entity that passes validation', () => {
            const pipeline = AsrPipelineFactory.CreateAsrPipeline(baseProps);

            expect(() => pipeline.validate()).not.toThrow();
        });

        it('should create entity with minimal YAML config', () => {
            const pipeline = AsrPipelineFactory.CreateAsrPipeline({
                name: 'Minimal Pipeline',
                slug: 'minimal-pipeline',
                configYaml: minimalConfigYaml,
            });

            expect(pipeline.configYaml).toBe(minimalConfigYaml);
            expect(() => pipeline.validate()).not.toThrow();
        });
    });

    describe('GenerateSlug', () => {
        it('should convert name to lowercase', () => {
            const slug = AsrPipelineFactory.GenerateSlug('Medical Transcription Pipeline');

            expect(slug).toBe('medical-transcription-pipeline');
        });

        it('should replace spaces with hyphens', () => {
            const slug = AsrPipelineFactory.GenerateSlug('my pipeline name');

            expect(slug).toBe('my-pipeline-name');
        });

        it('should remove special characters', () => {
            const slug = AsrPipelineFactory.GenerateSlug('Pipeline (v1.0) - Final!');

            expect(slug).toBe('pipeline-v1-0-final');
        });

        it('should remove leading and trailing hyphens', () => {
            const slug = AsrPipelineFactory.GenerateSlug('  Pipeline Name  ');

            expect(slug).toBe('pipeline-name');
        });

        it('should handle multiple consecutive special characters', () => {
            const slug = AsrPipelineFactory.GenerateSlug('Pipeline---Name___Test');

            expect(slug).toBe('pipeline-name-test');
        });

        it('should preserve numbers', () => {
            const slug = AsrPipelineFactory.GenerateSlug('Pipeline V3 2024');

            expect(slug).toBe('pipeline-v3-2024');
        });

        it('should handle empty string', () => {
            const slug = AsrPipelineFactory.GenerateSlug('');

            expect(slug).toBe('');
        });

        it('should handle string with only special characters', () => {
            const slug = AsrPipelineFactory.GenerateSlug('!@#$%^&*()');

            expect(slug).toBe('');
        });
    });

    describe('entity state after creation', () => {
        it('should create entity with no changes tracked', () => {
            const pipeline = AsrPipelineFactory.CreateAsrPipeline({
                name: 'Test Pipeline',
                slug: 'test-pipeline',
                configYaml: validConfigYaml,
            });

            expect(pipeline.hasChanges).toBe(false);
            expect(pipeline.changes).toEqual({});
        });

        it('should create entity with ENABLED resource status', () => {
            const pipeline = AsrPipelineFactory.CreateAsrPipeline({
                name: 'Test Pipeline',
                slug: 'test-pipeline',
                configYaml: validConfigYaml,
            });

            expect(pipeline.isEnabled).toBe(true);
            expect(pipeline.isActive).toBe(true);
        });

        it('should create entity that can be disabled', () => {
            const pipeline = AsrPipelineFactory.CreateAsrPipeline({
                name: 'Test Pipeline',
                slug: 'test-pipeline',
                configYaml: validConfigYaml,
            });

            pipeline.disable('user-123');

            expect(pipeline.isDisabled).toBe(true);
            expect(pipeline.isActive).toBe(false);
        });
    });

    describe('model slug extraction from created pipeline', () => {
        it('should extract model slugs from config YAML', () => {
            const pipeline = AsrPipelineFactory.CreateAsrPipeline({
                name: 'Test Pipeline',
                slug: 'test-pipeline',
                configYaml: validConfigYaml,
            });

            const slugs = pipeline.getModelSlugs();

            expect(slugs).toContain('whisper-large-v3');
            expect(slugs).toContain('silero-vad-v4');
        });

        it('should get ASR model slug', () => {
            const pipeline = AsrPipelineFactory.CreateAsrPipeline({
                name: 'Test Pipeline',
                slug: 'test-pipeline',
                configYaml: validConfigYaml,
            });

            expect(pipeline.getAsrModelSlug()).toBe('whisper-large-v3');
        });

        it('should get VAD model slug', () => {
            const pipeline = AsrPipelineFactory.CreateAsrPipeline({
                name: 'Test Pipeline',
                slug: 'test-pipeline',
                configYaml: validConfigYaml,
            });

            expect(pipeline.getVadModelSlug()).toBe('silero-vad-v4');
        });
    });

    describe('complete creation scenarios', () => {
        it('should create a fully configured pipeline', () => {
            const pipeline = AsrPipelineFactory.CreateAsrPipeline({
                name: 'Production Medical Pipeline',
                slug: 'prod-medical',
                description: 'Production pipeline for medical transcription',
                configYaml: validConfigYaml,
                tenantId: 'tenant-hospital-123',
                tags: ['production', 'medical', 'hipaa'],
                createdBy: 'admin-user',
            });

            expect(pipeline.name).toBe('Production Medical Pipeline');
            expect(pipeline.slug).toBe('prod-medical');
            expect(pipeline.description).toBe('Production pipeline for medical transcription');
            expect(pipeline.configYaml).toBe(validConfigYaml);
            expect(pipeline.tenantId).toBe('tenant-hospital-123');
            expect(pipeline.tags).toEqual(['production', 'medical', 'hipaa']);
            expect(pipeline.createdBy).toBe('admin-user');
            expect(pipeline.isActive).toBe(true);
            expect(() => pipeline.validate()).not.toThrow();
        });

        it('should create a minimal pipeline', () => {
            const pipeline = AsrPipelineFactory.CreateAsrPipeline({
                name: 'Minimal',
                slug: 'minimal',
                configYaml: minimalConfigYaml,
            });

            expect(pipeline.name).toBe('Minimal');
            expect(pipeline.slug).toBe('minimal');
            expect(pipeline.description).toBeNull();
            expect(pipeline.tags).toEqual([]);
            expect(pipeline.tenantId).toBe('');
            expect(() => pipeline.validate()).not.toThrow();
        });
    });
});
