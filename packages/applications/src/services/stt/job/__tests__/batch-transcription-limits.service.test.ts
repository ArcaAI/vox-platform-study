// Batch-limit resolution.
//
// The gateway must never hardcode "5" or "60" again: it asks this service, which
// reads the registry-declared `stt.batch.*` knobs through EffectiveSettingsService.
// The interesting behaviour is what happens when that read goes WRONG — an
// upload route must not start failing because a settings row is missing or the
// control plane hiccups.

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { BATCH_TRANSCRIPTION_DEFAULTS } from '../../../settings-registry/descriptors/batch-transcription.descriptors';
import type { EffectiveSettingsService } from '../../../settings-registry/effective-settings.service';
import { BatchTranscriptionLimitsService } from '../batch-transcription-limits.service';

const TENANT = 'tenant-1';

function serviceWith(resolve: EffectiveSettingsService['resolveEffective']): BatchTranscriptionLimitsService {
  return new BatchTranscriptionLimitsService({ resolveEffective: resolve } as EffectiveSettingsService);
}

function resolverReturning(values: Record<string, number>): EffectiveSettingsService['resolveEffective'] {
  return vi.fn(async (key: string) => ({ key, tier: 'global-kv', value: values[key], sourceScope: 'system' })) as never;
}

describe('BatchTranscriptionLimitsService', () => {
  beforeEach(() => vi.clearAllMocks());

  it('resolves every knob through the registry for the caller’s tenant', async () => {
    const resolve = resolverReturning({
      'stt.batch.maxFilesPerBatch': 3,
      'stt.batch.maxDurationMinutes': 30,
      'stt.batch.maxFileSizeMb': 120,
      'stt.batch.maxActiveJobsPerUser': 7,
    });

    const limits = await serviceWith(resolve).resolve(TENANT);

    expect(limits).toEqual({ maxFilesPerBatch: 3, maxDurationMinutes: 30, maxFileSizeMb: 120, maxActiveJobsPerUser: 7 });
    expect(resolve).toHaveBeenCalledTimes(4);
    expect(resolve).toHaveBeenCalledWith('stt.batch.maxFilesPerBatch', { tenantId: TENANT });
  });

  it('falls back to the code default when the control plane throws', async () => {
    // A settings-backend failure must not take batch uploads down with it —
    // these knobs are `open-to-default` by declaration.
    const limits = await serviceWith(vi.fn().mockRejectedValue(new Error('redis down')) as never).resolve(TENANT);
    expect(limits).toEqual({ ...BATCH_TRANSCRIPTION_DEFAULTS });
  });

  it('falls back per-knob: one bad value never discards the others', async () => {
    const resolve = resolverReturning({
      'stt.batch.maxFilesPerBatch': 3,
      // maxDurationMinutes deliberately absent → undefined
      'stt.batch.maxFileSizeMb': 120,
      'stt.batch.maxActiveJobsPerUser': 7,
    });
    const limits = await serviceWith(resolve).resolve(TENANT);
    expect(limits.maxDurationMinutes).toBe(BATCH_TRANSCRIPTION_DEFAULTS.maxDurationMinutes);
    expect(limits.maxFilesPerBatch).toBe(3);
  });

  it('rejects a stored value that is not a usable positive number', async () => {
    for (const bad of [0, -5, Number.NaN, 'lots' as unknown as number, null as unknown as number]) {
      const limits = await serviceWith(resolverReturning({ 'stt.batch.maxFilesPerBatch': bad })).resolve(TENANT);
      expect(limits.maxFilesPerBatch, String(bad)).toBe(BATCH_TRANSCRIPTION_DEFAULTS.maxFilesPerBatch);
    }
  });

  it('floors a fractional stored value (2.7 files means 2, never 3)', async () => {
    const limits = await serviceWith(resolverReturning({ 'stt.batch.maxFilesPerBatch': 2.7 })).resolve(TENANT);
    expect(limits.maxFilesPerBatch).toBe(2);
  });

  it('exposes maxFileSizeBytes for the size check without re-deriving MB', async () => {
    const limits = await serviceWith(resolverReturning({ 'stt.batch.maxFileSizeMb': 120 })).resolve(TENANT);
    expect(BatchTranscriptionLimitsService.toBytes(limits.maxFileSizeMb)).toBe(120 * 1024 * 1024);
  });
});
