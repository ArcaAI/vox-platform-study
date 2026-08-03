// Batch-transcription limit resolution (TASK-604).
//
// The one place the `stt.batch.*` knobs turn into numbers. The gateway's upload
// route, its `/limits` read surface, and the SDK that mirrors them client-side
// all read the SAME resolved object, so "5 recordings, 60 minutes" is stated
// once (in the descriptors) and enforced everywhere from here.
//
// FAIL-OPEN, DELIBERATELY. Every knob is declared `open-to-default`, so a
// missing row resolves to its code default inside EffectiveSettingsService. This
// service extends that posture to the two cases the declaration cannot cover —
// a control-plane ERROR, and a stored value that is not a usable number — because
// the alternative is refusing clinical uploads over a settings-cache hiccup.
// Note the asymmetry with `stt.fallback.pipelineSlug`: that one is provider
// SELECTION and fails closed. These are ceilings, and a ceiling that cannot be
// read falls back to the platform default rather than to "no limit".

import { Injectable, Logger } from '@nestjs/common';
import {
  BATCH_TRANSCRIPTION_DEFAULTS,
  BatchTranscriptionKnobKey,
  batchTranscriptionKey,
} from '../../settings-registry/descriptors/batch-transcription.descriptors';
import { EffectiveSettingsService } from '../../settings-registry/effective-settings.service';

/** The resolved ceilings for one tenant. */
export interface BatchTranscriptionLimits {
  /** Recordings a client may submit as one batch. */
  maxFilesPerBatch: number;
  /** Per-recording duration ceiling, in minutes. */
  maxDurationMinutes: number;
  /** Per-file size ceiling, in MB. */
  maxFileSizeMb: number;
  /** Queued/processing jobs one caller may hold at once. */
  maxActiveJobsPerUser: number;
}

const KNOBS = Object.keys(BATCH_TRANSCRIPTION_DEFAULTS) as BatchTranscriptionKnobKey[];

@Injectable()
export class BatchTranscriptionLimitsService {
  private readonly logger = new Logger(BatchTranscriptionLimitsService.name);

  constructor(private readonly effectiveSettings: EffectiveSettingsService) {}

  /** MB → bytes, so the size check never re-derives the conversion at a call site. */
  static toBytes(megabytes: number): number {
    return megabytes * 1024 * 1024;
  }

  /**
   * Resolve every ceiling for `tenantId`. Never throws: an unreadable knob
   * degrades to its code default, independently of the others.
   */
  async resolve(tenantId: string): Promise<BatchTranscriptionLimits> {
    const resolved = await Promise.all(KNOBS.map((knob) => this.resolveOne(knob, tenantId)));
    return Object.fromEntries(KNOBS.map((knob, i) => [knob, resolved[i]])) as unknown as BatchTranscriptionLimits;
  }

  private async resolveOne(knob: BatchTranscriptionKnobKey, tenantId: string): Promise<number> {
    const fallback = BATCH_TRANSCRIPTION_DEFAULTS[knob];
    try {
      const result = await this.effectiveSettings.resolveEffective(batchTranscriptionKey(knob), { tenantId });
      return this.coerce(result?.value, fallback, knob);
    } catch (err) {
      this.logger.warn({
        message: `Batch limit '${knob}' unreadable; using the code default`,
        error: err instanceof Error ? err.message : String(err),
        attributes: { knob, fallback },
      });
      return fallback;
    }
  }

  /**
   * A ceiling must be a positive integer. A fractional value floors (2.7 files
   * means 2, never 3 — a ceiling is never rounded UP past what an operator set),
   * and anything non-numeric or non-positive is treated as unset.
   */
  private coerce(value: unknown, fallback: number, knob: BatchTranscriptionKnobKey): number {
    const numeric = typeof value === 'number' ? value : Number.NaN;
    if (!Number.isFinite(numeric) || numeric <= 0) {
      if (value !== undefined && value !== null) {
        this.logger.warn({
          message: `Batch limit '${knob}' is not a positive number; using the code default`,
          attributes: { knob, value, fallback },
        });
      }
      return fallback;
    }
    return Math.floor(numeric);
  }
}
