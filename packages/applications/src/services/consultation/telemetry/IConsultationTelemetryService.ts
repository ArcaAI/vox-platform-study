import { ConsultationTelemetryResponse } from './dto';

export const IConsultationTelemetryService = Symbol('IConsultationTelemetryService');

export interface IConsultationTelemetryService {
  /**
   * Per-consultation AI telemetry for the admin detail pane (TASK-999 §3.1 C-1).
   *
   * READ-ONLY and never partial-fails: a source that has nothing, or that the
   * platform does not record, becomes an `available: false` block with a
   * reason. The only thing that throws is a consultation the caller may not
   * see — `NotFoundException`, never `ForbiddenException` (404-over-403).
   */
  getTelemetry(consultationId: string): Promise<ConsultationTelemetryResponse>;
}
