import { GenerateSummaryRequest, GeneratePreSummaryRequest, UpdateSummaryRequest, SummaryResponse, SummaryProvenanceResponse } from './dto';
import type { ClinicalCaller } from './clinician-attribution';

export abstract class ISummaryService {
  abstract generatePreSummary(consultationId: string, request: GeneratePreSummaryRequest): Promise<SummaryResponse>;
  abstract generateSummary(consultationId: string, request: GenerateSummaryRequest): Promise<SummaryResponse>;
  /**
   * TASK-972 Lane 1 — `options.caller` is the CREDENTIAL CLASS, resolved by the controller and
   * never read from a body. Absent ⇒ derived from CLS (service account, else human JWT); only
   * the API-key class cannot be derived, because there is no `apiKey` CLS key.
   */
  abstract updateSummary(contextItemId: string, request: UpdateSummaryRequest, options?: { caller?: ClinicalCaller }): Promise<SummaryResponse>;
  abstract approveSummary(
    contextItemId: string,
    // `expectedVersion` is the OCC compare-and-set predicate for
    // the ContextItem row (the `@RequiresIfMatch()`-gated header the
    // controller folds onto this options object).
    // TASK-972 Lane 1 — `clinicianUserId` is WHO the note is attested BY (required for a machine
    // credential, refused for a non-admin human naming another); `caller` is WHICH credential
    // submitted it. See `clinician-attribution.ts` for the whole rule.
    options?: { overrideSafetyFlag?: boolean; expectedVersion?: number; clinicianUserId?: string; caller?: ClinicalCaller },
  ): Promise<{ contextItemId: string; approvalStatus: string; approvedBy: string; approvedAt: string }>;
  abstract getLatestSummary(consultationId: string): Promise<SummaryResponse | null>;
  abstract getLatestPreSummary(consultationId: string): Promise<SummaryResponse | null>;
  abstract getSummaries(consultationId: string): Promise<SummaryResponse[]>;
  abstract getSummaryProvenance(contextItemId: string): Promise<SummaryProvenanceResponse>;
  abstract extractEntities(contextItemId: string): Promise<void>;
}

export const ISummaryServiceToken = Symbol('ISummaryService');
