/**
 * TenantFrontendConfigDtoMapper.
 *
 * The response must surface the three new audio-console fields
 * (transcriptionMode, transcriptionModeLocked, captureMode) so the admin UI
 * and the SDK can read them back.
 */
import { describe, it, expect } from 'vitest';
import { TenantFrontendConfigFactory, TranscriptionMode, CaptureMode } from '@arcaai/domains';
import { TenantFrontendConfigDtoMapper } from '../tenant-frontend-config.dto.mapper';

describe('TenantFrontendConfigDtoMapper — audio fields', () => {
  it('maps transcriptionMode / transcriptionModeLocked / captureMode onto the response', () => {
    const entity = TenantFrontendConfigFactory.CreateTenantFrontendConfig({
      tenantId: 'tenant-1',
      transcriptionMode: TranscriptionMode.LOCAL,
      transcriptionModeLocked: true,
      captureMode: CaptureMode.RAW_ONLY,
    });

    const response = TenantFrontendConfigDtoMapper.toResponse(entity, true);

    expect(response.transcriptionMode).toBe(TranscriptionMode.LOCAL);
    expect(response.transcriptionModeLocked).toBe(true);
    expect(response.captureMode).toBe(CaptureMode.RAW_ONLY);
  });

  it('defaults to BACKEND / false / null when the factory fields are omitted (back-compat)', () => {
    const entity = TenantFrontendConfigFactory.CreateTenantFrontendConfig({ tenantId: 'tenant-1' });

    const response = TenantFrontendConfigDtoMapper.toResponse(entity, false);

    expect(response.transcriptionMode).toBe(TranscriptionMode.BACKEND);
    expect(response.transcriptionModeLocked).toBe(false);
    expect(response.captureMode).toBeNull();
  });
});
