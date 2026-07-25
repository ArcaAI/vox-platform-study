/**
 * Config Types Tests — Stream A (ASR-R-05, ASR-R-04)
 *
 * TDD tests for config type additions needed for STT remote integration.
 * @vitest-environment jsdom
 */

import { describe, it, expect } from 'vitest';

// =============================================================================
// ASR-R-05: wsUrl in ApiConfig
// =============================================================================

describe('ASR-R-05: ApiConfig WebSocket configuration', () => {
  it('should accept wsUrl as an optional field in ApiConfig', () => {
    // ApiConfig must support a wsUrl field for WebSocket connections
    const config: import('../config').ApiConfig = {
      baseUrl: 'https://api.example.com',
      apiKey: 'test-key',
      wsUrl: 'wss://api.example.com',
    };

    expect(config.wsUrl).toBe('wss://api.example.com');
  });

  it('should not require wsUrl in ApiConfig', () => {
    // wsUrl is optional — existing configs without it must still compile
    const config: import('../config').ApiConfig = {
      baseUrl: 'https://api.example.com',
      apiKey: 'test-key',
    };

    expect(config.wsUrl).toBeUndefined();
  });

  it('should allow wsUrl to coexist with all existing ApiConfig fields', () => {
    const config: import('../config').ApiConfig = {
      baseUrl: 'https://api.example.com',
      apiKey: 'test-key',
      tenantId: 'tenant-123',
      timeout: 5000,
      wsUrl: 'wss://ws.example.com',
    };

    expect(config.baseUrl).toBe('https://api.example.com');
    expect(config.apiKey).toBe('test-key');
    expect(config.tenantId).toBe('tenant-123');
    expect(config.timeout).toBe(5000);
    expect(config.wsUrl).toBe('wss://ws.example.com');
  });

  it('should support accessToken for JWT/OAuth2 authentication', () => {
    const config: import('../config').ApiConfig = {
      baseUrl: 'https://api.example.com',
      accessToken: 'jwt-token-abc',
    };

    expect(config.accessToken).toBe('jwt-token-abc');
    expect(config.apiKey).toBeUndefined();
  });

  it('should support both accessToken and apiKey simultaneously', () => {
    const config: import('../config').ApiConfig = {
      baseUrl: 'https://api.example.com',
      accessToken: 'jwt-token-abc',
      apiKey: 'system-api-key',
      tenantId: 'tenant-1',
    };

    expect(config.accessToken).toBe('jwt-token-abc');
    expect(config.apiKey).toBe('system-api-key');
    expect(config.tenantId).toBe('tenant-1');
  });

  it('should allow ApiConfig with only baseUrl (no auth)', () => {
    const config: import('../config').ApiConfig = {
      baseUrl: 'https://api.example.com',
    };

    expect(config.baseUrl).toBe('https://api.example.com');
    expect(config.accessToken).toBeUndefined();
    expect(config.apiKey).toBeUndefined();
  });
});

// =============================================================================
// ASR-R-04: STTPluginConfig with sttSocket and pipelineId
// =============================================================================

describe('ASR-R-04: STTPluginConfig backend streaming fields', () => {
  it('should accept pipelineId as an optional field in STTPluginConfig', () => {
    const config: import('../config').STTPluginConfig = {
      enabled: true,
      provider: 'backend',
      pipelineId: 'pipeline-uuid-or-slug',
    };

    expect(config.pipelineId).toBe('pipeline-uuid-or-slug');
  });

  it('should accept sttSocket as an optional field in STTPluginConfig', () => {
    const config: import('../config').STTPluginConfig = {
      enabled: true,
      provider: 'backend',
      sttSocket: 'wss://api.example.com/ws/stt/stream',
    };

    expect(config.sttSocket).toBe('wss://api.example.com/ws/stt/stream');
  });

  it('should not require pipelineId or sttSocket', () => {
    const config: import('../config').STTPluginConfig = {
      enabled: true,
    };

    expect(config.pipelineId).toBeUndefined();
    expect(config.sttSocket).toBeUndefined();
  });

  it('should allow all STT config fields together', () => {
    const config: import('../config').STTPluginConfig = {
      enabled: true,
      provider: 'backend',
      language: 'en',
      modelId: 'whisper-small',
      pipelineId: 'default-pipeline',
      sttSocket: 'wss://stt.example.com/ws',
    };

    expect(config.provider).toBe('backend');
    expect(config.language).toBe('en');
    expect(config.modelId).toBe('whisper-small');
    expect(config.pipelineId).toBe('default-pipeline');
    expect(config.sttSocket).toBe('wss://stt.example.com/ws');
  });
});

// =============================================================================
// ASR-R-04: TranscriptionProcessingConfig.stt should have sttSocket
// =============================================================================

describe('ASR-R-04: TranscriptionProcessingConfig.stt backend fields', () => {
  it('should accept sttSocket in stt processing config', () => {
    const config: import('../config').TranscriptionProcessingConfig = {
      noiseFilter: { location: 'browser' },
      vad: { location: 'browser' },
      stt: {
        location: 'backend',
        provider: 'backend',
        sttSocket: 'wss://api.example.com/ws/stt/stream',
      },
    };

    expect(config.stt.sttSocket).toBe('wss://api.example.com/ws/stt/stream');
  });

  it('should accept pipelineId in stt processing config', () => {
    const config: import('../config').TranscriptionProcessingConfig = {
      noiseFilter: { location: 'browser' },
      vad: { location: 'browser' },
      stt: {
        location: 'backend',
        pipelineId: 'my-pipeline',
      },
    };

    expect(config.stt.pipelineId).toBe('my-pipeline');
  });
});
