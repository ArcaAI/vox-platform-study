import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsInt, IsOptional, IsString, MaxLength, Min } from 'class-validator';

/**
 * A clinician's edit to ONE section of ONE document.
 *
 * Deliberately carries CONTENT ONLY. `title`, `idx`, `annotations`, `provenance`
 * and `documentTemplateVersionId` are compiled from the document template and
 * pinned at write time — a clinician edits the prose, not the shape of the note,
 * and a request that could move `idx` would let one editor reorder a document
 * another is reading. `state`, `revision`, `confirmedAt/By` and `lockedAt` are
 * OUTCOMES of the state machine, never inputs to it.
 *
 * The global pipe runs `whitelist + forbidNonWhitelisted + forbidUnknownValues`,
 * so anything not declared here is rejected with 400 rather than silently dropped.
 */
export class UpdateDocumentSectionRequest {
  /**
   * Not `@IsNotEmpty()`: an empty string is a VALID edit. A clinician emptying a
   * section is authorized by definition — the transcript-contradiction rule
   * (`section-store.ts` exists to stop the MODEL deleting content it wrote,
   * not to make a clinician justify deleting their own.
   */
  @ApiProperty({
    description:
      'The section body as the clinician wants it stored. MAY be empty — a clinician emptying a section needs no transcript contradiction, unlike a flush.',
    maxLength: 100_000,
  })
  @IsString()
  @MaxLength(100_000)
  content: string;

  @ApiPropertyOptional({
    description:
      'The section `_version` the client read, as the compare-and-set operand. The `If-Match` header is REQUIRED on this route and OVERRIDES this field when both are present; the body field exists for non-browser callers that drive optimistic concurrency through the payload.',
    minimum: 0,
  })
  @IsOptional()
  @IsInt()
  @Min(0)
  expectedVersion?: number;
}
