/**
 * @vitest-environment jsdom
 */
import { describe, it, expect } from 'vitest';
import { mapV1ConfigToAgenticConfig } from '../config-adapter';
import type { V1SdkConfig } from '../types';

const baseConfig: V1SdkConfig = {
  apiEndpoint: 'https://api.arcaai.com',
  websocketUrl: 'wss://api.arcaai.com',
  credentials: { apiKey: 'tenant-key-123' },
};

describe('mapV1ConfigToAgenticConfig', () => {
  it('maps apiEndpoint/websocketUrl/apiKey correctly', () => {
    const cfg = mapV1ConfigToAgenticConfig(baseConfig);
    // baseUrl is normalized to carry the gateway /api/v1 prefix that v2 hooks expect.
    expect(cfg.api.baseUrl).toBe('https://api.arcaai.com/api/v1');
    expect(cfg.api.wsUrl).toBe('wss://api.arcaai.com');
    expect(cfg.api.apiKey).toBe('tenant-key-123');
  });

  it('does not double-append /api/v1 when already present', () => {
    const cfg = mapV1ConfigToAgenticConfig({ ...baseConfig, apiEndpoint: 'https://api.arcaai.com/api/v1/' });
    expect(cfg.api.baseUrl).toBe('https://api.arcaai.com/api/v1');
  });

  it('resolves the tenant server-side (tenantId undefined)', () => {
    const cfg = mapV1ConfigToAgenticConfig(baseConfig);
    expect(cfg.api.tenantId).toBeUndefined();
  });

  it('THROWS on missing apiKey and never injects a default key', () => {
    expect(() => mapV1ConfigToAgenticConfig({ ...baseConfig, credentials: {} })).toThrow(/apiKey is required/);
    expect(() => mapV1ConfigToAgenticConfig({ ...baseConfig, credentials: undefined })).toThrow(/apiKey is required/);
    expect(() => mapV1ConfigToAgenticConfig({ ...baseConfig, credentials: { apiKey: '   ' } })).toThrow(/apiKey is required/);
  });

  it('never carries the v1 hardcoded default key', () => {
    // The v1 baked-in default (TASK-560 §6 A1) must NOT appear anywhere.
    expect(() => mapV1ConfigToAgenticConfig({ ...baseConfig, credentials: {} })).toThrow();
    const cfg = mapV1ConfigToAgenticConfig(baseConfig);
    expect(cfg.api.apiKey).not.toBe('AFUTlhD/pGyyKOBTP3KTnA==');
  });

  it('maps a backend sttPipelineId into audio.stt', () => {
    const cfg = mapV1ConfigToAgenticConfig({ ...baseConfig, sttPipelineId: 'pipeline-xyz' });
    expect(cfg.audio?.stt).toEqual({ enabled: true, provider: 'backend', pipelineId: 'pipeline-xyz' });
  });

  it('maps noiseSuppression into audio.noiseFilter', () => {
    const cfg = mapV1ConfigToAgenticConfig({ ...baseConfig, audioSettings: { noiseSuppression: true } });
    expect(cfg.audio?.noiseFilter).toEqual({ enabled: true, level: 'medium' });
  });
});
