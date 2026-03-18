/**
 * UpdateUserPreferencesRequest DTO Validation Tests
 *
 * Tests the class-validator decorators on the request DTO.
 *
 * Testing Strategy:
 * - Use the REAL class-validator validate() function
 * - NO mocks — these tests verify actual validation behavior
 * - Test valid inputs, invalid types, nested validation, edge cases
 */

import { describe, it, expect } from 'vitest';
import { validate } from 'class-validator';
import { plainToInstance } from 'class-transformer';
import { UpdateUserPreferencesRequest } from '../dto/update-user-preferences.request';

async function validateDto(
    data: Record<string, any>,
): Promise<{ isValid: boolean; errors: string[] }> {
    const instance = plainToInstance(UpdateUserPreferencesRequest, data);
    const validationErrors = await validate(instance);
    return {
        isValid: validationErrors.length === 0,
        errors: validationErrors.flatMap((e) => {
            const constraints = Object.values(e.constraints ?? {});
            const childErrors = (e.children ?? []).flatMap((child) =>
                Object.values(child.constraints ?? {}),
            );
            return [...constraints, ...childErrors];
        }),
    };
}

describe('UpdateUserPreferencesRequest', () => {
    describe('valid inputs', () => {
        it('should accept empty object (all fields optional)', async () => {
            const result = await validateDto({});
            expect(result.isValid).toBe(true);
        });

        it('should accept workflowMode: local', async () => {
            const result = await validateDto({ workflowMode: 'local' });
            expect(result.isValid).toBe(true);
        });

        it('should accept workflowMode: remote', async () => {
            const result = await validateDto({ workflowMode: 'remote' });
            expect(result.isValid).toBe(true);
        });

        it('should accept language as string', async () => {
            const result = await validateDto({ language: 'en' });
            expect(result.isValid).toBe(true);
        });

        it('should accept dnaStyleId as string', async () => {
            const result = await validateDto({ dnaStyleId: 'clinical-concise-en' });
            expect(result.isValid).toBe(true);
        });

        it('should accept custom as object', async () => {
            const result = await validateDto({ custom: { theme: 'dark' } });
            expect(result.isValid).toBe(true);
        });

        it('should accept full valid payload', async () => {
            const result = await validateDto({
                workflowMode: 'local',
                language: 'th',
                dnaStyleId: 'clinical-detailed-th',
                localConfig: {
                    noiseCancellation: { modelId: 'rnnoise', level: 'high' },
                    stt: { modelId: 'whisper-large-v3' },
                    vad: { modelId: 'silero-vad-v5', sensitivity: 0.6 },
                    ner: { modelId: 'biomedical', autoExtract: true },
                    diarization: { enabled: true, autoEnroll: true },
                },
                custom: { shortcuts: ['ctrl+s'] },
            });
            expect(result.isValid).toBe(true);
        });

        it('should accept partial localConfig (only stt)', async () => {
            const result = await validateDto({
                localConfig: { stt: { modelId: 'whisper-large-v3' } },
            });
            expect(result.isValid).toBe(true);
        });
    });

    describe('workflowMode validation', () => {
        it('should reject invalid workflowMode value', async () => {
            const result = await validateDto({ workflowMode: 'invalid' });
            expect(result.isValid).toBe(false);
        });

        it('should reject numeric workflowMode', async () => {
            const result = await validateDto({ workflowMode: 1 });
            expect(result.isValid).toBe(false);
        });
    });

    describe('localConfig nested validation', () => {
        it('should reject invalid noiseCancellation level', async () => {
            const result = await validateDto({
                localConfig: {
                    noiseCancellation: { level: 'ultra' },
                },
            });
            expect(result.isValid).toBe(false);
        });

        it('should reject non-string modelId in stt', async () => {
            const result = await validateDto({
                localConfig: {
                    stt: { modelId: 123 },
                },
            });
            expect(result.isValid).toBe(false);
        });

        it('should reject vad sensitivity above 1', async () => {
            const result = await validateDto({
                localConfig: {
                    vad: { sensitivity: 1.5 },
                },
            });
            expect(result.isValid).toBe(false);
        });

        it('should reject vad sensitivity below 0', async () => {
            const result = await validateDto({
                localConfig: {
                    vad: { sensitivity: -0.1 },
                },
            });
            expect(result.isValid).toBe(false);
        });

        it('should accept vad sensitivity at boundary 0', async () => {
            const result = await validateDto({
                localConfig: {
                    vad: { sensitivity: 0 },
                },
            });
            expect(result.isValid).toBe(true);
        });

        it('should accept vad sensitivity at boundary 1', async () => {
            const result = await validateDto({
                localConfig: {
                    vad: { sensitivity: 1 },
                },
            });
            expect(result.isValid).toBe(true);
        });

        it('should reject non-boolean autoExtract in ner', async () => {
            const result = await validateDto({
                localConfig: {
                    ner: { autoExtract: 'yes' },
                },
            });
            expect(result.isValid).toBe(false);
        });

        it('should reject non-boolean enabled in diarization', async () => {
            const result = await validateDto({
                localConfig: {
                    diarization: { enabled: 'true' },
                },
            });
            expect(result.isValid).toBe(false);
        });

        it('should accept valid noiseCancellation levels', async () => {
            for (const level of ['low', 'medium', 'high']) {
                const result = await validateDto({
                    localConfig: {
                        noiseCancellation: { level },
                    },
                });
                expect(result.isValid).toBe(true);
            }
        });
    });

    describe('remoteConfig exclusion', () => {
        it('should not have remoteConfig field (admin-controlled)', async () => {
            const instance = plainToInstance(UpdateUserPreferencesRequest, {
                workflowMode: 'remote',
            });
            expect((instance as any).remoteConfig).toBeUndefined();
        });

        it('should not have codeSwitching field (pipeline-level config)', async () => {
            const instance = plainToInstance(UpdateUserPreferencesRequest, {
                workflowMode: 'local',
            });
            expect((instance as any).codeSwitching).toBeUndefined();
        });
    });

    describe('edge cases', () => {
        it('should reject non-object custom', async () => {
            const result = await validateDto({ custom: 'not-an-object' });
            expect(result.isValid).toBe(false);
        });

        it('should accept null optional fields via @IsOptional', async () => {
            const result = await validateDto({
                language: null,
                dnaStyleId: null,
            });
            expect(result.isValid).toBe(true);
        });
    });
});
