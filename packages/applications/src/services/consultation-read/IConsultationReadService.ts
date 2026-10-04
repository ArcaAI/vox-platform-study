import type { ConsultationReadInput, ConsultationReadResult } from './consultation-read.service';

/** TASK-1036 §9.3 / TASK-1038 — the declared-read port the internal consultation-read route calls. */
export interface IConsultationReadService {
  read(input: ConsultationReadInput): Promise<ConsultationReadResult>;
}

export const IConsultationReadService = Symbol('IConsultationReadService');
