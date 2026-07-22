/**
 * TDD tests for the local raw-capture flag in TenantAudioConfig.
 *
 * The server appends a synthetic `enable-local-raw-capture` GlobalSetting row
 * (namespace `feature-flags`) to GET /tenant/me/config carrying the
 * server-computed effective boolean (platform capability AND tenant toggle).
 * `parseTenantConfig` must surface it as `captureRawAudio` so the provider can
 * map it into `tenantOverrides.audio.captureRawAudio`.
 */
import { describe, it, expect } from 'vitest';
import { TENANT_CONFIG_KEYS, parseTenantConfig } from '../config';

describe('parseTenantConfig captureRawAudio', () => {
  it('exposes the enable-local-raw-capture key constant', () => {
    expect(TENANT_CONFIG_KEYS.ENABLE_LOCAL_RAW_CAPTURE).toBe('enable-local-raw-capture');
  });

  it('defaults captureRawAudio to false when the row is absent', () => {
    const config = parseTenantConfig([]);
    expect(config.captureRawAudio).toBe(false);
  });

  it('parses captureRawAudio = true from the feature-flags row', () => {
    const config = parseTenantConfig([{ key: 'enable-local-raw-capture', value: 'true', namespace: 'feature-flags' }]);
    expect(config.captureRawAudio).toBe(true);
  });

  it('parses captureRawAudio = false from the feature-flags row', () => {
    const config = parseTenantConfig([{ key: 'enable-local-raw-capture', value: 'false', namespace: 'feature-flags' }]);
    expect(config.captureRawAudio).toBe(false);
  });
});
