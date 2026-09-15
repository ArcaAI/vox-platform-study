import { IsOptional, IsBoolean, IsInt, IsString, Min } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class SummaryApprovalRequest {
  @ApiPropertyOptional({
    description:
      'One-click clinician acknowledgement to sign past a safety FLAG. ' +
      'Recorded as a SAFETY_OVERRIDE WORM audit event; no free-text justification required.',
  })
  @IsOptional()
  @IsBoolean()
  overrideSafetyFlag?: boolean;

  /**
   * optimistic-concurrency token. Mirrors
   * `UpdateDepartmentRequest.expectedVersion` verbatim: required. Approval
   * writes the ContextItem row (and flips the parent Consultation to
   * SIGNED), so it needs the same Compare-And-Set predicate as the other
   * note-content write routes. On a `@RequiresIfMatch()` route the
   * controller folds the `If-Match` header value over this field when both
   * are present.
   */
  @ApiProperty({
    description: 'Current version of the summary row (from the prior GET). The approval fails with 412 if the version drifted.',
    example: 7,
  })
  @IsInt()
  @Min(1)
  expectedVersion!: number;

  /**
   * TASK-972 Lane 1/4 — the clinician this note is ATTESTED BY.
   *
   * REQUIRED for a machine credential (`approveSummary` refuses one that names nobody — a
   * machine is never the attesting clinician, it is recorded as the ACTOR beside them) and
   * refused for a human who names another clinician without `SUPER_ADMIN` / `TENANT_ADMIN`. The
   * whole rule is `consultation/summary/clinician-attribution.ts`; the field is declared here
   * because the global pipe runs `forbidNonWhitelisted`, so an undeclared field REJECTS the
   * request rather than arriving stripped — and `@arcaai/vox-node` already sends it
   * (`ApproveSummaryRequest.clinicianUserId`).
   */
  @ApiPropertyOptional({
    description:
      'The clinician this sign-off is attested by. REQUIRED for a machine credential (API key / service account); a human may ' +
      'name another clinician only while holding SUPER_ADMIN or TENANT_ADMIN, and omits it to sign as themselves.',
  })
  @IsOptional()
  @IsString()
  clinicianUserId?: string;
}
