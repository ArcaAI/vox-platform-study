import type { CatalogueSizeSource } from './model-residency.types';

/**
 * TASK-1051 F8 (owner default OD-2) — the ONE rule for what a load reserves,
 * shared by admission (`model-residency.service.ts`), the dry-run preview and the
 * catalogue's `budgetBytes`, so the screen can never promise what admission refuses.
 *
 * A measured footprint is used as is. A never-measured model is budgeted at its
 * catalogue estimate × `BUDGET_SAFETY_FACTOR` (estimates run low: KV cache,
 * CUDA context). With neither, the size is unknown and an un-forced load is
 * refused `NO_SIZE`; it used to be admitted against 0 bytes.
 */
export const BUDGET_SAFETY_FACTOR = 1.2;

const MiB = 1024 * 1024;

export interface ResidencyBudget {
  bytes: number | null;
  source: CatalogueSizeSource;
}

export function budgetFor(measuredBytes: number | null | undefined, catalogueMemoryMb: number | null | undefined): ResidencyBudget {
  if (measuredBytes && measuredBytes > 0) return { bytes: measuredBytes, source: 'measured' };
  if (catalogueMemoryMb && catalogueMemoryMb > 0) return { bytes: Math.ceil(catalogueMemoryMb * MiB * BUDGET_SAFETY_FACTOR), source: 'catalogue' };
  return { bytes: null, source: 'unknown' };
}
