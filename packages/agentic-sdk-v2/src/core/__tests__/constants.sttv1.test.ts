/**
 * @arcaai/vox - Legacy STT v1 Cleanup Tests (Stream F)
 *
 * TDD tests for F4: ASR-R-11 — Verify no active v1 STT references remain
 */

import { describe, it, expect } from 'vitest';
import * as constants from '../constants';

describe('Legacy STT v1 Cleanup (ASR-R-11)', () => {
  it('should NOT export any STT_GATEWAY or STT_V1 endpoint constant', () => {
    const exported = Object.keys(constants);

    // There should be no STT v1/gateway references
    const v1References = exported.filter(
      (key) =>
        key.includes('STT_GATEWAY') ||
        key.includes('STT_V1') ||
        key.includes('LEGACY_STT')
    );

    expect(v1References).toHaveLength(0);
  });

  it('should have STT_V2_ENDPOINTS as the only STT streaming constant', () => {
    expect(constants.STT_V2_ENDPOINTS).toBeDefined();
    expect(constants.STT_V2_ENDPOINTS.WS_STREAM).toBe('/ws/stt-v2/stream');
  });

  it('STT_V2_ENDPOINTS.WS_STREAM should NOT contain the v1 path /stt', () => {
    expect(constants.STT_V2_ENDPOINTS.WS_STREAM).not.toBe('/stt');
    expect(constants.STT_V2_ENDPOINTS.WS_STREAM).not.toContain('/stt?');
  });

  it('PIPELINE_ENDPOINTS should exist for ASR pipeline discovery', () => {
    expect(constants.PIPELINE_ENDPOINTS).toBeDefined();
    expect(constants.PIPELINE_ENDPOINTS.LIST).toBe('/admin/audio/pipelines');
  });
});
