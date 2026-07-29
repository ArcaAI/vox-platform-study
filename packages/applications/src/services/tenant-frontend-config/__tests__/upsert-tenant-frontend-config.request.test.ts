/**
 * UpsertTenantFrontendConfigRequest DTO validation.
 *
 * Verifies the new audio-console fields validate correctly:
 *   - transcriptionMode (LOCAL | BACKEND), optional
 *   - transcriptionModeLocked (boolean), optional
 *   - captureMode (RAW_AND_PROCESSED | RAW_ONLY | PROCESSED_ONLY | NONE | null), optional
 *
 * Uses the REAL class-validator pipeline (no mocks).
 */
import { describe, it, expect } from 'vitest';
import { validate } from 'class-validator';
import { plainToInstance } from 'class-transformer';
import { TranscriptionMode, CaptureMode } from '@arcaai/domains';
import { UpsertTenantFrontendConfigRequest } from '../dto/upsert-tenant-frontend-config.request';

async function validateDto(data: Record<string, unknown>): Promise<boolean> {
  const instance = plainToInstance(UpsertTenantFrontendConfigRequest, data);
  const errors = await validate(instance);
  return errors.length === 0;
}

describe('UpsertTenantFrontendConfigRequest — audio fields', () => {
  it('accepts an empty payload (all new fields optional)', async () => {
    expect(await validateDto({})).toBe(true);
  });

  describe('transcriptionMode', () => {
    it.each([TranscriptionMode.LOCAL, TranscriptionMode.BACKEND])('accepts %s', async (mode) => {
      expect(await validateDto({ transcriptionMode: mode })).toBe(true);
    });

    it('rejects an unknown transcriptionMode', async () => {
      expect(await validateDto({ transcriptionMode: 'CLOUD' })).toBe(false);
    });
  });

  describe('transcriptionModeLocked', () => {
    it('accepts a boolean', async () => {
      expect(await validateDto({ transcriptionModeLocked: true })).toBe(true);
    });

    it('rejects a non-boolean', async () => {
      expect(await validateDto({ transcriptionModeLocked: 'yes' })).toBe(false);
    });
  });

  describe('captureMode', () => {
    it.each([CaptureMode.RAW_AND_PROCESSED, CaptureMode.RAW_ONLY, CaptureMode.PROCESSED_ONLY, CaptureMode.NONE])('accepts %s', async (mode) => {
      expect(await validateDto({ captureMode: mode })).toBe(true);
    });

    it('accepts null (clears the tenant override)', async () => {
      expect(await validateDto({ captureMode: null })).toBe(true);
    });

    it('rejects an unknown captureMode', async () => {
      expect(await validateDto({ captureMode: 'EVERYTHING' })).toBe(false);
    });
  });

  it('accepts a full valid payload alongside the legacy fields', async () => {
    expect(
      await validateDto({
        asrModel: 'whisper-large-v3',
        noiseCancel: true,
        captureRawAudio: true,
        transcriptionMode: TranscriptionMode.LOCAL,
        transcriptionModeLocked: true,
        captureMode: CaptureMode.RAW_AND_PROCESSED,
        expectedVersion: 3,
      }),
    ).toBe(true);
  });
});
