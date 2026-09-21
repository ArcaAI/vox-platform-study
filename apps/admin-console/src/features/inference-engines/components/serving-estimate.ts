/**
 * The client-side load precheck (D-6), and the assumptions it runs on.
 *
 * WHY THE CONSOLE PROJECTS AT ALL. The gateway refuses an over-budget load with
 * a typed 409 carrying `estimateBytes` and `freeBytes`, which is the authority.
 * But a refusal that arrives after the button is pressed teaches the admin the
 * same fact at the worst moment — the reload has already been armed and the
 * decision already made. So the console projects the SAME arithmetic up front
 * and shows it beside the button. The gateway still decides.
 *
 * THREE ASSUMPTIONS, all stated rather than hidden:
 *
 *  1. KV residency scales with `contextLength × parallel`. Measured on the live
 *     pod (ticket §2.1): LM Studio gives EVERY parallel slot the full context
 *     instead of dividing it, which is why 131072 × 10 cost ~10.5 GiB of f16 KV
 *     for ~6k-token prompts. The projection therefore scales the gateway's
 *     `kvCacheEstimateBytes` by the ratio of the two products.
 *  2. "Apply & reload" unloads first, so the instance's OWN current footprint
 *     returns to the pool. Free space alone would understate the headroom by
 *     exactly the amount the running model holds, and would flag almost every
 *     re-tune as over budget.
 *  3. A model with no loaded instance yields NO estimate. There are no measured
 *     weights to project from, and a fabricated number here would be read as a
 *     measurement — worse than saying the estimate is unavailable.
 *
 * Every output of this module is an ESTIMATE DERIVED FROM AN ESTIMATE. Nothing
 * that renders it may present it as an observation.
 */

import type { AiModelServingProfile } from '@arcaai/types';
import type { LmStudioDevice, LmStudioLoadedModel } from '../api/serving-types';

/** Devices report MiB; the profile plane reports bytes. One conversion, one place. */
export const BYTES_PER_MIB = 1024 * 1024;

export interface ServingPrecheck {
  /** Projected total residency (weights + KV) in bytes, or null when nothing measured supports one. */
  estimateBytes: number | null;
  /** Why there is no estimate. Set exactly when `estimateBytes` is null. */
  unavailableReason?: string;
  /** True when the KV half was re-projected for a CHANGED `context × parallel`. */
  scaled: boolean;
  /** Free bytes across the devices this profile is allowed to use. */
  freeBytes: number;
  /** Bytes the reload releases first — this instance's current residency. */
  reclaimBytes: number;
  /** `freeBytes + reclaimBytes`: what the new instance actually has to fit into. */
  headroomBytes: number;
  /** Device indices the profile permits, ascending. */
  eligibleDeviceIndexes: number[];
  overBudget: boolean;
}

export interface ProjectServingFootprintArgs {
  /** The currently running instance of this model, when there is one. */
  loaded: LmStudioLoadedModel | undefined;
  /** The profile the admin is about to apply. */
  draft: AiModelServingProfile;
  devices: LmStudioDevice[];
}

export function projectServingFootprint({ loaded, draft, devices }: ProjectServingFootprintArgs): ServingPrecheck {
  const disabled = new Set(draft.gpuSplit?.disabledGpus ?? []);
  const eligible = devices.filter((device) => !disabled.has(device.index));
  const eligibleDeviceIndexes = eligible.map((device) => device.index).sort((a, b) => a - b);
  const freeBytes = eligible.reduce((total, device) => total + device.freeMib * BYTES_PER_MIB, 0);

  if (!loaded) {
    return {
      estimateBytes: null,
      unavailableReason:
        'This model has never been loaded on this engine, so there are no measured weights to project from. The gateway runs its own precheck when you load it.',
      scaled: false,
      freeBytes,
      reclaimBytes: 0,
      headroomBytes: freeBytes,
      eligibleDeviceIndexes,
      overBudget: false,
    };
  }

  const reclaimBytes = loaded.weightsBytes + loaded.kvCacheEstimateBytes;
  const headroomBytes = freeBytes + reclaimBytes;

  const currentSlots = (loaded.effective.contextLength ?? 0) * (loaded.effective.parallel ?? 0);
  const draftSlots = (draft.contextLength ?? loaded.effective.contextLength ?? 0) * (draft.parallel ?? loaded.effective.parallel ?? 0);
  // Scale only when both products are known AND actually differ; otherwise the
  // honest answer is "the residency it has now", not a ratio of guesses.
  const scaled = currentSlots > 0 && draftSlots > 0 && draftSlots !== currentSlots;
  const kvBytes = scaled ? Math.round((loaded.kvCacheEstimateBytes * draftSlots) / currentSlots) : loaded.kvCacheEstimateBytes;
  const estimateBytes = loaded.weightsBytes + kvBytes;

  return {
    estimateBytes,
    scaled,
    freeBytes,
    reclaimBytes,
    headroomBytes,
    eligibleDeviceIndexes,
    overBudget: estimateBytes > headroomBytes,
  };
}
