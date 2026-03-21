import { describe, it, expect } from 'vitest';
import * as v from 'valibot';
import {
    AppConfigSchema,
    AudioConfigSchema,
    SttConfigSchema,
    UiConfigSchema,
    SmrConfigSchema,
    FeatureFlagsSchema,
    SYSTEM_DEFAULTS,
    CONFIG_PERMISSIONS,
    getFieldPermission,
    canUserEditField,
    getUserEditableFields,
    type AppConfig,
} from '../ConfigSchema';

describe('ConfigSchema', () => {
    describe('SYSTEM_DEFAULTS', () => {
        it('should produce a valid AppConfig with all sections', () => {
            expect(SYSTEM_DEFAULTS).toHaveProperty('audio');
            expect(SYSTEM_DEFAULTS).toHaveProperty('stt');
            expect(SYSTEM_DEFAULTS).toHaveProperty('ui');
            expect(SYSTEM_DEFAULTS).toHaveProperty('smr');
            expect(SYSTEM_DEFAULTS).toHaveProperty('features');
        });

        it('should have correct audio defaults', () => {
            expect(SYSTEM_DEFAULTS.audio.sampleRate).toBe(16000);
            expect(SYSTEM_DEFAULTS.audio.noiseSuppression).toBe(true);
            expect(SYSTEM_DEFAULTS.audio.noiseFilterLevel).toBe('medium');
            expect(SYSTEM_DEFAULTS.audio.vadEnabled).toBe(false);
            expect(SYSTEM_DEFAULTS.audio.vadThreshold).toBe(0.5);
            expect(SYSTEM_DEFAULTS.audio.diarization).toBe(false);
            expect(SYSTEM_DEFAULTS.audio.codeSwitching).toBe(false);
        });

        it('should have correct stt defaults', () => {
            expect(SYSTEM_DEFAULTS.stt.provider).toBe('local');
            expect(SYSTEM_DEFAULTS.stt.defaultModel).toBe('whisper-tiny');
            expect(SYSTEM_DEFAULTS.stt.language).toBe('en');
            expect(SYSTEM_DEFAULTS.stt.availableModels).toHaveLength(3);
        });

        it('should have correct ui defaults', () => {
            expect(SYSTEM_DEFAULTS.ui.theme).toBe('system');
            expect(SYSTEM_DEFAULTS.ui.density).toBe('normal');
        });

        it('should have correct feature flag defaults', () => {
            expect(SYSTEM_DEFAULTS.features.realTimeTranscription).toBe(true);
            expect(SYSTEM_DEFAULTS.features.nerExtraction).toBe(false);
            expect(SYSTEM_DEFAULTS.features.dnaStyle).toBe(false);
            expect(SYSTEM_DEFAULTS.features.tts).toBe(false);
        });
    });

    describe('Valibot schema validation', () => {
        it('should parse an empty object to full defaults', () => {
            const result = v.parse(AppConfigSchema, {});
            expect(result.audio.sampleRate).toBe(16000);
            expect(result.stt.provider).toBe('local');
            expect(result.ui.theme).toBe('system');
        });

        it('should accept valid overrides', () => {
            const result = v.parse(AppConfigSchema, {
                audio: { sampleRate: 44100, vadEnabled: true },
                stt: { language: 'hi' },
            });
            expect(result.audio.sampleRate).toBe(44100);
            expect(result.audio.vadEnabled).toBe(true);
            expect(result.stt.language).toBe('hi');
            expect(result.audio.noiseSuppression).toBe(true);
        });

        it('should reject sampleRate below 8000', () => {
            expect(() => v.parse(AudioConfigSchema, { sampleRate: 100 })).toThrow();
        });

        it('should reject sampleRate above 48000', () => {
            expect(() => v.parse(AudioConfigSchema, { sampleRate: 96000 })).toThrow();
        });

        it('should reject invalid noiseFilterLevel', () => {
            expect(() => v.parse(AudioConfigSchema, { noiseFilterLevel: 'ultra' })).toThrow();
        });

        it('should reject vadThreshold below 0', () => {
            expect(() => v.parse(AudioConfigSchema, { vadThreshold: -0.1 })).toThrow();
        });

        it('should reject vadThreshold above 1', () => {
            expect(() => v.parse(AudioConfigSchema, { vadThreshold: 1.5 })).toThrow();
        });

        it('should accept valid STT provider values', () => {
            for (const provider of ['local', 'backend', 'auto'] as const) {
                const result = v.parse(SttConfigSchema, { provider });
                expect(result.provider).toBe(provider);
            }
        });

        it('should reject invalid STT provider', () => {
            expect(() => v.parse(SttConfigSchema, { provider: 'cloud' })).toThrow();
        });

        it('should accept valid UI theme values', () => {
            for (const theme of ['light', 'dark', 'system'] as const) {
                const result = v.parse(UiConfigSchema, { theme });
                expect(result.theme).toBe(theme);
            }
        });

        it('should accept valid UI density values', () => {
            for (const density of ['compact', 'normal', 'comfortable'] as const) {
                const result = v.parse(UiConfigSchema, { density });
                expect(result.density).toBe(density);
            }
        });
    });

    describe('CONFIG_PERMISSIONS', () => {
        it('should have permissions for all known fields', () => {
            const expectedPaths = [
                'audio.sampleRate', 'audio.noiseSuppression', 'audio.noiseFilterLevel',
                'audio.vadEnabled', 'audio.vadThreshold', 'audio.diarization', 'audio.codeSwitching',
                'stt.provider', 'stt.defaultModel', 'stt.availableModels', 'stt.language',
                'ui.theme', 'ui.density', 'ui.language',
                'smr.provider', 'smr.model',
                'features.realTimeTranscription', 'features.nerExtraction',
                'features.dnaStyle', 'features.crossChainSummary', 'features.tts',
            ];
            for (const path of expectedPaths) {
                expect(CONFIG_PERMISSIONS[path]).toBeDefined();
            }
        });

        it('should mark audio.sampleRate as admin', () => {
            expect(CONFIG_PERMISSIONS['audio.sampleRate'].permission).toBe('admin');
        });

        it('should mark audio.noiseSuppression as user', () => {
            expect(CONFIG_PERMISSIONS['audio.noiseSuppression'].permission).toBe('user');
        });

        it('should mark stt.language as user', () => {
            expect(CONFIG_PERMISSIONS['stt.language'].permission).toBe('user');
        });

        it('should mark stt.provider as admin', () => {
            expect(CONFIG_PERMISSIONS['stt.provider'].permission).toBe('admin');
        });

        it('should mark all feature flags as admin', () => {
            const featureFlags = Object.entries(CONFIG_PERMISSIONS)
                .filter(([path]) => path.startsWith('features.'));
            expect(featureFlags.length).toBeGreaterThan(0);
            for (const [, meta] of featureFlags) {
                expect(meta.permission).toBe('admin');
            }
        });
    });

    describe('getFieldPermission', () => {
        it('should return correct permission for known paths', () => {
            expect(getFieldPermission('audio.noiseSuppression')).toBe('user');
            expect(getFieldPermission('audio.sampleRate')).toBe('admin');
            expect(getFieldPermission('stt.language')).toBe('user');
        });

        it('should default to admin for unknown paths', () => {
            expect(getFieldPermission('unknown.field')).toBe('admin');
        });
    });

    describe('canUserEditField', () => {
        it('should return true for user-editable fields with no locks', () => {
            expect(canUserEditField('audio.noiseSuppression', new Set())).toBe(true);
            expect(canUserEditField('stt.language', new Set())).toBe(true);
            expect(canUserEditField('ui.theme', new Set())).toBe(true);
        });

        it('should return false for admin-only fields', () => {
            expect(canUserEditField('audio.sampleRate', new Set())).toBe(false);
            expect(canUserEditField('stt.provider', new Set())).toBe(false);
            expect(canUserEditField('features.dnaStyle', new Set())).toBe(false);
        });

        it('should return false for user fields that are locked', () => {
            const locked = new Set(['audio.noiseSuppression', 'stt.language']);
            expect(canUserEditField('audio.noiseSuppression', locked)).toBe(false);
            expect(canUserEditField('stt.language', locked)).toBe(false);
        });

        it('should return true for user fields not in lock set', () => {
            const locked = new Set(['audio.noiseSuppression']);
            expect(canUserEditField('stt.language', locked)).toBe(true);
        });

        it('should return false for unknown fields', () => {
            expect(canUserEditField('nonexistent.field', new Set())).toBe(false);
        });
    });

    describe('getUserEditableFields', () => {
        it('should return only user-permission fields', () => {
            const fields = getUserEditableFields();
            expect(fields.length).toBeGreaterThan(0);
            for (const field of fields) {
                expect(CONFIG_PERMISSIONS[field].permission).toBe('user');
            }
        });

        it('should include expected user fields', () => {
            const fields = getUserEditableFields();
            expect(fields).toContain('audio.noiseSuppression');
            expect(fields).toContain('audio.vadEnabled');
            expect(fields).toContain('stt.language');
            expect(fields).toContain('ui.theme');
        });

        it('should not include admin fields', () => {
            const fields = getUserEditableFields();
            expect(fields).not.toContain('audio.sampleRate');
            expect(fields).not.toContain('stt.provider');
            expect(fields).not.toContain('features.dnaStyle');
        });
    });
});
