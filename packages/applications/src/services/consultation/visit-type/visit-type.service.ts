// VisitTypeService — the ONE surface every call site resolves a visit type through.
//
// It is a thin, SYNCHRONOUS-underneath facade over `TenantSettingsService`
// (`tenant override → SYSTEM row → descriptor default`, in-memory, no I/O) plus
// the pure selection functions next door. Thin on purpose: the cascade is
// already implemented once, correctly, and re-implementing it here is how a
// per-tenant config surface acquires a second, subtly-different walk.
//
// UNWIRED ⇒ THE SHIPPED DEFAULT, NEVER A THROW. `TenantSettingsService` is
// injected `@Optional()` (the house pattern — `ocr-enrichment.processor.ts`,
// `loop-config.service.ts`, `apikey.service.ts` all do this), because this
// service is reached from BullMQ processors and from a long tail of unit tests
// that construct their subject positionally. A composition that never wired the
// settings lane must degrade to the two shipped visit types — which is exactly
// the behaviour the literals it replaces had — never to an exception on a
// clinical generation path.

import { Injectable, Optional } from '@nestjs/common';
import { TenantSettingsService } from '../../settings-registry/tenant-settings.service';
import {
  CONSULTATION_VISIT_TYPES_DEFAULT,
  CONSULTATION_VISIT_TYPES_KEY,
  matchVisitType,
  promptSlotFor,
  selectVisitType,
  visitTypeCatalogueProblem,
  visitTypePromptBinding,
  type VisitTypeDefinition,
  type VisitTypePromptBinding,
  type VisitTypePromptSlot,
  type VisitTypePromptTask,
} from './visit-type.catalogue';

// Re-exported so a consumer that only ever talks to the SERVICE needs one
// import, not two — the catalogue module stays the definition's home.
export type { VisitTypeDefinition, VisitTypePromptBinding, VisitTypePromptSlot, VisitTypePromptTask } from './visit-type.catalogue';

/** What a caller knows about a consultation when it needs its visit type. */
export interface VisitTypeSelectionInput {
  /** The visit type the consultation actually recorded, when it recorded one. */
  recorded?: string | null;
  /** `parentConsultationId != null` — the consultation's own follow-up signal. */
  isFollowUp: boolean;
}

@Injectable()
export class VisitTypeService {
  constructor(@Optional() private readonly tenantSettings?: TenantSettingsService) {}

  /**
   * The effective catalogue for `tenantId` — the tenant's own if it has one,
   * otherwise the platform's, otherwise the two shipped defaults.
   *
   * A stored value that fails the descriptor's own invariant is DISCARDED in
   * favour of the shipped default rather than served. The write lane refuses
   * such a value, so reaching this branch means a row was planted some other
   * way (the legacy `GlobalSettingController` CRUD writes the same table); a
   * malformed catalogue must not be able to take out prompt resolution.
   */
  catalogue(tenantId: string | null | undefined): readonly VisitTypeDefinition[] {
    if (!this.tenantSettings) return CONSULTATION_VISIT_TYPES_DEFAULT;
    const resolved = this.tenantSettings.resolve<VisitTypeDefinition[]>(CONSULTATION_VISIT_TYPES_KEY, tenantId ?? null);
    const value = resolved.value;
    if (!Array.isArray(value) || visitTypeCatalogueProblem(value)) return CONSULTATION_VISIT_TYPES_DEFAULT;
    return value;
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
   * WHAT `(task, visitType)` COMPOSES — the surface any text-generation task
   * asks, and the reason the visit type is an IDENTIFIER rather than a label
   * (owner directive, 2026-08-29).
   *
   * Two overload-ish entry points on purpose:
   *  - {@link promptBindingFor} takes an ALREADY-RESOLVED entry, for a caller
   *    that matched the visit type itself (the resolver does, so it can record
   *    the key in its trace whether or not a binding answers);
   *  - {@link promptBinding} does both, for a caller that only holds a
   *    consultation.
   *
   * Both go through the SAME tenant -> SYSTEM catalogue, so there is one
   * cascade, not two.
   */
  promptBindingFor(visitType: VisitTypeDefinition | null | undefined, task: VisitTypePromptTask): VisitTypePromptBinding | null {
    return visitTypePromptBinding(visitType, task);
  }

  /**
   * The `(task, visitType)` binding for one consultation, resolved end to end:
   * the tenant's catalogue picks the visit type (recorded value first, parent
   * link second), and the visit type answers for this task.
   *
   * `null` means the tenant bound nothing for this pairing — the caller runs its
   * own chain, exactly as before the binding existed.
   */
  promptBinding(
    tenantId: string | null | undefined,
    input: VisitTypeSelectionInput,
    task: VisitTypePromptTask,
  ): { visitType: VisitTypeDefinition; binding: VisitTypePromptBinding } | null {
    const visitType = this.forConsultation(tenantId, input);
    const binding = visitTypePromptBinding(visitType, task);
    return binding ? { visitType, binding } : null;
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
 * The catalogue an UNWIRED composition sees: the two shipped visit types,
 * resolved with no settings lane.
 *
 * `VisitTypeService` holds no state beyond its optional dependency, so one
 * shared instance is safe — and it keeps every consumer's fallback a single
 * expression (`this.visitTypes ?? DEFAULT_VISIT_TYPE_SERVICE`) instead of a
 * null-branch repeated on a clinical generation path.
 */
export const DEFAULT_VISIT_TYPE_SERVICE = new VisitTypeService();
