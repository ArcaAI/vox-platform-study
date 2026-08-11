import { LoopConfigResponse } from './dto';

export const ILoopConfigService = Symbol('ILoopConfigService');

export interface ILoopConfigService {
  /**
   * Resolve the deterministic loop configuration for one consultation.
   * Every resolution failure (missing/cross-tenant consultation, no
   * department, no default agent, no servable context schema) degrades to a
   * disabled config — this method never throws.
   */
  resolveForConsultation(tenantId: string, consultationId: string): Promise<LoopConfigResponse>;
}
