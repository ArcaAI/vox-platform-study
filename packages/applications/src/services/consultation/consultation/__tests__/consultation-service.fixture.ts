/**
 * Named doubles for the two collaborators `ConsultationService` gained in TASK-1045 (positional
 * constructor slots 7 and 8, right after the CLS service):
 *
 *  - `IConsultationEncounterService` — the episode's encounters. `open` matches an encounter by its
 *    `externalRef`, appends one to the open consultation, or creates the consultation together
 *    with encounter 1. The double creates through the spec's own consultation repository, so a
 *    spec that asserts on `consultationRepository.create` keeps observing the write.
 *  - `IConsultationLifecycleService` — the lifecycle commands (start / stop / close / reopen …) the
 *    deprecated `ConsultationService` methods delegate to.
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { vi } from 'vitest';
import { ConsultationEntity } from '@arcaai/domains';

export interface EncounterServiceDouble {
  matchExternalRef: ReturnType<typeof vi.fn>;
  createConsultation: ReturnType<typeof vi.fn>;
  appendEncounter: ReturnType<typeof vi.fn>;
  currentEncounter: ReturnType<typeof vi.fn>;
  listForConsultation: ReturnType<typeof vi.fn>;
  lifecycleView: ReturnType<typeof vi.fn>;
}

const encounterOf = (consultation: any, seq: number, start: { visitType?: string; externalRef?: string | null }) => ({
  id: `enc-${consultation?.id ?? 'new'}-${seq}`,
  tenantId: consultation?.tenantId,
  consultationId: consultation?.id,
  seq,
  visitType: start.visitType ?? 'new-visit',
  externalRef: start.externalRef ?? null,
  startedAt: new Date('2026-10-05T08:00:00Z'),
  endedAt: null,
  recordingStartMs: null,
  recordingEndMs: null,
});

/**
 * An encounter service over the spec's consultation repository: no ref matches, no current
 * encounter. A repository double that predates the episode model gets the open-key lookups it
 * lacks, answering "none" (no open consultation of the key, no closed one to chain to).
 */
export function encounterServiceDouble(consultationRepository: {
  create?: (entity: any) => Promise<any>;
  findOpenByKey?: unknown;
  findLatestClosedByKey?: unknown;
}): EncounterServiceDouble {
  consultationRepository.findOpenByKey ??= vi.fn().mockResolvedValue(null);
  consultationRepository.findLatestClosedByKey ??= vi.fn().mockResolvedValue(null);
  return {
    matchExternalRef: vi.fn().mockResolvedValue({ own: null, conflict: false }),
    createConsultation: vi.fn(async (consultation: any, first: { visitType: string; externalRef: string | null }) => {
      const saved = (await consultationRepository.create?.(consultation)) ?? consultation;
      // The persisted row: a spec's create double may answer the bare props it was given, but a
      // row read back from the database always carries the lifecycle columns' defaults.
      const row = saved instanceof ConsultationEntity ? saved : new ConsultationEntity(saved);
      return { consultation: row, encounter: encounterOf(row, 1, first) };
    }),
    appendEncounter: vi.fn(async (consultation: any, next: { visitType: string; externalRef: string | null }) => ({
      consultation,
      encounter: encounterOf(consultation, (consultation?.currentEncounterSeq ?? 1) + 1, next),
    })),
    currentEncounter: vi.fn().mockResolvedValue(null),
    listForConsultation: vi.fn().mockResolvedValue([]),
    lifecycleView: vi.fn().mockResolvedValue({ encounters: [], approval: null, autoCloseAt: null, allowClosedCompleteReopen: false }),
  };
}

export interface LifecycleDouble {
  start: ReturnType<typeof vi.fn>;
  pause: ReturnType<typeof vi.fn>;
  stop: ReturnType<typeof vi.fn>;
  approve: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
  reopen: ReturnType<typeof vi.fn>;
}

/** The lifecycle command service: every command resolves (to an empty answer) unless a spec says otherwise. */
export function lifecycleDouble(): LifecycleDouble {
  return {
    start: vi.fn().mockResolvedValue({}),
    pause: vi.fn().mockResolvedValue({}),
    stop: vi.fn().mockResolvedValue({}),
    approve: vi.fn().mockResolvedValue({}),
    close: vi.fn().mockResolvedValue({}),
    reopen: vi.fn().mockResolvedValue({}),
  };
}
