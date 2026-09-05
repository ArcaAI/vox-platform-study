// TASK-883 — the five client-AI columns on `TenantFrontendConfig` are retired.
//
// Owner directive 2026-09-04 (TASK-865, `08-vox-sdk.md` §"The browser never
// runs a model"): VAD, denoise, diarization and ASR selection are SERVER-side
// agent decisions. The browser captures audio and renders results. A per-tenant
// column instructing the browser to run a model is a control for a capability
// that no longer exists — and, worse, a control an admin could set to `true`
// with no effect whatsoever, which reads as a broken feature rather than a
// retired one.
//
// What SURVIVES is capture policy, which is a real browser concern:
// `captureRawAudio` (+ its platform capability), `transcriptionMode` and its
// lock, `captureMode`, and the typed `configJson`.
import { describe, expect, it } from 'vitest';
import { TenantFrontendConfigFactory } from '@arcaai/domains';
import { TenantFrontendConfigDtoMapper } from '../tenant-frontend-config.dto.mapper';

const RETIRED = ['asrModel', 'noiseCancel', 'vad', 'voiceEnrollment', 'diarization'];
const SURVIVING = ['captureRawAudio', 'transcriptionMode', 'transcriptionModeLocked', 'captureMode', 'configJson'];

describe('TASK-883 — client-AI columns on TenantFrontendConfig', () => {
  it('builds an entity that carries none of the five', () => {
    const entity = TenantFrontendConfigFactory.CreateTenantFrontendConfig({ tenantId: 'tenant-1' });
    for (const field of RETIRED) {
      expect(entity, field).not.toHaveProperty(field);
    }
  });

  it('serves a response that carries none of the five', () => {
    const entity = TenantFrontendConfigFactory.CreateTenantFrontendConfig({ tenantId: 'tenant-1' });
    const response = TenantFrontendConfigDtoMapper.toResponse(entity, true) as Record<string, unknown>;
    for (const field of RETIRED) {
      expect(Object.keys(response), field).not.toContain(field);
    }
  });

  it('ignores a retired field supplied by a stale caller', () => {
    // An un-regenerated SDK or a hand-rolled PUT must not be able to write one
    // back through the factory.
    const entity = TenantFrontendConfigFactory.CreateTenantFrontendConfig({
      tenantId: 'tenant-1',
      noiseCancel: true,
      vad: true,
      diarization: true,
      asrModel: 'whisper-large-v3',
    } as never);
    for (const field of RETIRED) {
      expect(entity, field).not.toHaveProperty(field);
    }
  });

  it('keeps every capture-policy field — the browser still decides what it CAPTURES', () => {
    const entity = TenantFrontendConfigFactory.CreateTenantFrontendConfig({ tenantId: 'tenant-1' });
    const response = TenantFrontendConfigDtoMapper.toResponse(entity, true) as Record<string, unknown>;
    for (const field of SURVIVING) {
      expect(Object.keys(response), field).toContain(field);
    }
    expect(response.platformRawCaptureCapable).toBe(true);
  });
});
