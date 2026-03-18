/**
 * TDD tests for UX constants in TenantAudioConfig and parseTenantConfig.
 *
 * The seed data (11-global-setting.ts) now includes 3 JSON settings under
 * the `ux-constants` namespace: local-asr-models, local-vad-models,
 * local-noise-suppression-models. These must be parsed into typed arrays
 * on TenantAudioConfig.
 *
 * @vitest-environment jsdom
 */

import { describe, it, expect } from 'vitest';
import {
    TENANT_CONFIG_KEYS,
    parseTenantConfig,
    type TenantAudioConfig,
    type LocalAsrModelInfo,
    type LocalVadModelInfo,
    type LocalNoiseSuppressionModelInfo,
} from '../config';

describe('TENANT_CONFIG_KEYS — UX constant keys', () => {
    it('should include LOCAL_ASR_MODELS key', () => {
        expect(TENANT_CONFIG_KEYS.LOCAL_ASR_MODELS).toBe('local-asr-models');
    });

    it('should include LOCAL_VAD_MODELS key', () => {
        expect(TENANT_CONFIG_KEYS.LOCAL_VAD_MODELS).toBe('local-vad-models');
    });

    it('should include LOCAL_NOISE_SUPPRESSION_MODELS key', () => {
        expect(TENANT_CONFIG_KEYS.LOCAL_NOISE_SUPPRESSION_MODELS).toBe('local-noise-suppression-models');
    });
});

describe('parseTenantConfig — UX constant parsing', () => {
    const asrModels: LocalAsrModelInfo[] = [
        { id: 'whisper-tiny', name: 'Whisper Tiny' },
        { id: 'whisper-base', name: 'Whisper Base' },
        { id: 'whisper-small', name: 'Whisper Small' },
        { id: 'whisper-medium', name: 'Whisper Medium' },
    ];

    const vadModels: LocalVadModelInfo[] = [
        { id: 'silero-v5', name: 'Silero VAD v5' },
        { id: 'silero-v6', name: 'Silero VAD v6' },
    ];

    const noiseModels: LocalNoiseSuppressionModelInfo[] = [
        { id: 'rnnoise', name: 'RNNoise' },
    ];

    it('should parse local-asr-models from JSON string', () => {
        const settings = [
            { key: 'local-asr-models', value: JSON.stringify(asrModels), namespace: 'ux-constants' },
        ];
        const config = parseTenantConfig(settings);
        expect(config.localAsrModels).toEqual(asrModels);
    });

    it('should parse local-vad-models from JSON string', () => {
        const settings = [
            { key: 'local-vad-models', value: JSON.stringify(vadModels), namespace: 'ux-constants' },
        ];
        const config = parseTenantConfig(settings);
        expect(config.localVadModels).toEqual(vadModels);
    });

    it('should parse local-noise-suppression-models from JSON string', () => {
        const settings = [
            { key: 'local-noise-suppression-models', value: JSON.stringify(noiseModels), namespace: 'ux-constants' },
        ];
        const config = parseTenantConfig(settings);
        expect(config.localNoiseSuppressionModels).toEqual(noiseModels);
    });

    it('should return undefined for UX lists when keys are absent', () => {
        const config = parseTenantConfig([]);
        expect(config.localAsrModels).toBeUndefined();
        expect(config.localVadModels).toBeUndefined();
        expect(config.localNoiseSuppressionModels).toBeUndefined();
    });

    it('should return undefined when JSON value is malformed', () => {
        const settings = [
            { key: 'local-asr-models', value: 'not-valid-json{', namespace: 'ux-constants' },
        ];
        const config = parseTenantConfig(settings);
        expect(config.localAsrModels).toBeUndefined();
    });

    it('should return undefined when value is not an array', () => {
        const settings = [
            { key: 'local-vad-models', value: JSON.stringify({ id: 'single' }), namespace: 'ux-constants' },
        ];
        const config = parseTenantConfig(settings);
        expect(config.localVadModels).toBeUndefined();
    });

    it('should handle value already being an array (pre-parsed)', () => {
        const settings = [
            { key: 'local-asr-models', value: asrModels, namespace: 'ux-constants' },
        ];
        const config = parseTenantConfig(settings);
        expect(config.localAsrModels).toEqual(asrModels);
    });

    it('should still parse existing config keys alongside UX constants', () => {
        const settings = [
            { key: 'default-stt-model', value: 'whisper-large-v3', namespace: 'stt' },
            { key: 'enable-dna-style', value: 'true', namespace: 'feature-flags' },
            { key: 'local-asr-models', value: JSON.stringify(asrModels), namespace: 'ux-constants' },
        ];
        const config = parseTenantConfig(settings);
        expect(config.defaultSttModel).toBe('whisper-large-v3');
        expect(config.features.dnaStyle).toBe(true);
        expect(config.localAsrModels).toEqual(asrModels);
    });
});
