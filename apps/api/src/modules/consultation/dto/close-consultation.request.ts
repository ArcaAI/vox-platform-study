import { IsOptional, IsString } from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';

/**
 * TASK-972 Lane 4 — the body of `POST /api/v1/consultations/:id/close`.
 *
 * ## Why this route grew a body at all
 *
 * It had none: a close was a state transition a human made for themselves, and the clinician was
 * the authenticated user. Opening the route to a MACHINE removes that identity — a service
 * account is not a person — so the clinician has to be NAMED, exactly as `open` already requires
 * it. The rule itself lives in one place for all three finish-half routes
 * (`packages/applications/src/services/consultation/summary/clinician-attribution.ts`); this DTO
 * only makes the field REACHABLE.
 *
 * ## Why it must be declared here and cannot simply be read off the body
 *
 * The global pipe runs `whitelist + forbidNonWhitelisted + forbidUnknownValues`, so an
 * undeclared field does not arrive stripped — it REJECTS the whole request. `@arcaai/vox-node`
 * already ships `CloseConsultationRequest.clinicianUserId` (Lane 5), so without this class the
 * SDK's own close call is a 400 before any handler runs.
 *
 * ## Why every field is optional
 *
 * A human JWT closing their own consultation sends no body at all, and must keep working. Nest
 * hands an absent body to the pipe as `{}`, which validates clean against a class whose fields
 * are all optional — that is the property that keeps this additive.
 *
 * It lives in `apps/api` rather than in `@arcaai/applications` because nothing in the service
 * layer consumes the CLASS: `IConsultationService.closeConsultation` takes
 * `{ clinicianUserId?, caller? }` options the controller assembles. This is the gateway's own
 * wire shape, and the other response DTOs for these routes are already declared in this module.
 */
export class CloseConsultationRequest {
  /**
   * The clinician this close is attributed to.
   *
   * REQUIRED for a machine credential — a machine is never the clinician (400
   * `CLINICIAN_REQUIRED`); refused for a human who is naming someone else without
   * `SUPER_ADMIN` / `TENANT_ADMIN` (400 `CLINICIAN_NOT_ALLOWED`); a clinician outside the
   * caller's tenant is 404, never 403 (the house posture, and a consultation is PHI).
   */
  @ApiPropertyOptional({
    description:
      'The clinician this close is attributed to. REQUIRED for a machine credential (API key / service account) — a machine is ' +
      'never the clinician; a human may name another clinician only while holding SUPER_ADMIN or TENANT_ADMIN, and omits it to ' +
      'act as themselves.',
  })
  @IsOptional()
  @IsString()
  clinicianUserId?: string;
}
