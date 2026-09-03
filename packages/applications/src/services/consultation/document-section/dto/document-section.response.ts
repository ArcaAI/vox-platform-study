import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { SectionAnnotationDto, SectionProvenanceDto } from '../../live-documentation/realtime/dto/section-patch.dto';

/**
 * One persisted `DocumentSection`, as the REST surface renders it.
 *
 * ## Why this is not `SectionPatchDto`
 *
 * They describe the same row and are deliberately different shapes. `SectionPatchDto`
 * is the SSE wire event: it carries `revision`, the monotonic token a streaming
 * client uses to discard an out-of-order patch. This is the REST representation:
 * it additionally carries `version`, the row's `_version` — the OPTIMISTIC
 * CONCURRENCY token a client must echo back as `If-Match` to edit the section.
 *
 * Those two numbers are not interchangeable and conflating them would break both
 * jobs. `revision` counts accepted WRITES to the section and is what makes the
 * stream orderable; `version` is the compare-and-set operand the database owns.
 * A flush and a clinician edit both advance both, but only `version` is a
 * precondition.
 *
 * `version` sits at the TOP LEVEL because that is where `ETagInterceptor` looks:
 * a positive-integer `version` on the body is what makes it emit
 * `ETag: "<n>"`, which is the only way a client can obtain the validator this
 * resource's PATCH route requires.
 */
export class DocumentSectionResponse {
  @ApiProperty({ description: 'Row id' })
  id: string;

  @ApiProperty({ description: 'Consultation this section belongs to' })
  consultationId: string;

  @ApiProperty({ description: "WHICH document — the tenant's `DocumentTemplate.slug` (e.g. `soap_note`)" })
  documentKey: string;

  @ApiProperty({ description: 'WHICH section within that document — the compiled template section key' })
  sectionKey: string;

  @ApiProperty({ description: 'Human-readable heading, so a reader needs no template join to render it' })
  title: string;

  @ApiProperty({ description: '0-based render ordinal within the document' })
  idx: number;

  @ApiProperty({
    description:
      'Section state. `empty` renders as a SKELETON, not an error. `provisional` is model-written and freely replaceable by the next flush. `confirmed` is clinician-touched and never overwritten by a flush. `locked` is finalized at the endpoint and rejects EVERY writer — a PATCH against it returns 409.',
    enum: ['empty', 'provisional', 'confirmed', 'locked'],
  })
  state: 'empty' | 'provisional' | 'confirmed' | 'locked';

  @ApiProperty({
    description:
      'Monotonic per-section revision, advanced by every accepted write. Orders the SSE `section.patch` stream; NOT the concurrency token — see `version`.',
  })
  revision: number;

  @ApiProperty({
    description: "The row's `_version`, and the ONLY value valid as this section's `If-Match` precondition. Also emitted as the response `ETag`.",
  })
  version: number;

  @ApiProperty({ description: 'The section body. Offsets in `annotations` index THIS string.' })
  content: string;

  @ApiPropertyOptional({ description: 'Section-LOCAL annotations (entity / groundedness / flagged spans)', type: [SectionAnnotationDto] })
  annotations?: SectionAnnotationDto[];

  @ApiPropertyOptional({ description: 'Transcript anchors this content is grounded in', type: [SectionProvenanceDto] })
  provenance?: SectionProvenanceDto[];

  @ApiPropertyOptional({
    description: 'The IMMUTABLE `DocumentTemplateVersion` this section was compiled from, pinned at write time.',
    nullable: true,
  })
  documentTemplateVersionId?: string | null;

  @ApiPropertyOptional({ description: 'When a clinician first confirmed this section', nullable: true })
  confirmedAt?: string | null;

  @ApiPropertyOptional({ description: 'Who confirmed it', nullable: true })
  confirmedBy?: string | null;

  @ApiPropertyOptional({ description: 'When the endpoint finalization locked it', nullable: true })
  lockedAt?: string | null;

  @ApiProperty()
  createdAt: string;

  @ApiProperty()
  updatedAt: string;
}
