import type { EncounterResponse } from '../consultation/dto/encounter.response';

/** The encounter fields a response reads — satisfied by the entity and by a raw included row. */
export interface EncounterLike {
  seq: number;
  visitType: string;
  externalRef?: string | null;
  startedAt: Date;
  endedAt?: Date | null;
  recordingStartMs?: number | null;
  recordingEndMs?: number | null;
}

export class EncounterDtoMapper {
  static toResponse(encounter: EncounterLike): EncounterResponse {
    return {
      seq: encounter.seq,
      visitType: encounter.visitType,
      externalRef: encounter.externalRef ?? null,
      startedAt: encounter.startedAt.toISOString(),
      endedAt: encounter.endedAt ? encounter.endedAt.toISOString() : null,
      recordingStartMs: encounter.recordingStartMs ?? null,
      recordingEndMs: encounter.recordingEndMs ?? null,
    };
  }

  /** In `seq` order. */
  static toResponses(encounters: readonly EncounterLike[]): EncounterResponse[] {
    return [...encounters].sort((a, b) => a.seq - b.seq).map((encounter) => EncounterDtoMapper.toResponse(encounter));
  }
}
