// VisitTypeService — the ONE surface every call site resolves a visit type through.
//
// TASK-882: the visit types are the platform's two (`CONSULTATION_VISIT_TYPES_DEFAULT`), derived
// from the consultation's own parent link. The service used to read a tenant catalogue
// (`consultation.visitTypes`) through `TenantSettingsService` and carried a `(task, visitType)`
// prompt binding; the owner's model has no tenant-managed conditions, so both are gone and the
// facade keeps only the three pure selections every caller needs. It holds no state and takes
// no dependency, which is what lets `DEFAULT_VISIT_TYPE_SERVICE` be one shared instance and
// every positional fixture construct it with no arguments.

import { Injectable } from '@nestjs/common';
import {
  CONSULTATION_VISIT_TYPES_DEFAULT,
  matchVisitType,
  promptSlotFor,
  selectVisitType,
  type VisitTypeDefinition,
  type VisitTypePromptSlot,
} from './visit-type.catalogue';

// Re-exported so a consumer that only ever talks to the SERVICE needs one
// import, not two — the catalogue module stays the definition's home.
export type { VisitTypeDefinition, VisitTypePromptSlot } from './visit-type.catalogue';

/** What a caller knows about a consultation when it needs its visit type. */
export interface VisitTypeSelectionInput {
  /** The visit type the consultation actually recorded, when it recorded one. */
  recorded?: string | null;
  /** `parentConsultationId != null` — the consultation's own follow-up signal. */
  isFollowUp: boolean;
}

@Injectable()
export class VisitTypeService {
  /**
   * The platform's visit types. `tenantId` is accepted for call-site compatibility and ignored:
   * since TASK-882 there is no per-tenant catalogue to resolve.
   */
  catalogue(_tenantId: string | null | undefined): readonly VisitTypeDefinition[] {
    return CONSULTATION_VISIT_TYPES_DEFAULT;
  }

  /** The visit type of one consultation — recorded value first, parent link second. */
  forConsultation(tenantId: string | null | undefined, input: VisitTypeSelectionInput): VisitTypeDefinition {
    return selectVisitType(this.catalogue(tenantId), input);
  }

  /** The entry `raw` names, or `null` — the membership test a route uses to accept or 400. */
  match(tenantId: string | null | undefined, raw: string | null | undefined): VisitTypeDefinition | null {
    return matchVisitType(this.catalogue(tenantId), raw);
  }

  /**
   * Which `Department` prompt column a `promptType` reads.
   *
   * `promptType` carries the phase axis too (`'pre-summary'`, `'live'`), and
   * both — like any unmatched value — mean "no visit-type opinion" and land on
   * the new-patient column, exactly as the ternary this replaces did.
   */
  promptSlot(tenantId: string | null | undefined, promptType: string | null | undefined): VisitTypePromptSlot {
    return promptSlotFor(this.catalogue(tenantId), promptType);
  }
}

/**
 * The instance an UNWIRED composition uses. `VisitTypeService` holds no state, so one shared
 * instance is safe — and it keeps every consumer's fallback a single expression
 * (`this.visitTypes ?? DEFAULT_VISIT_TYPE_SERVICE`) instead of a null-branch repeated on a
 * clinical generation path.
 */
export const DEFAULT_VISIT_TYPE_SERVICE = new VisitTypeService();
