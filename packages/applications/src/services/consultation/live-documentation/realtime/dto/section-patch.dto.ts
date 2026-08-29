import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

/**
 * TASK-811 §2b — the `section.patch` SSE payload.
 *
 * ## The offset problem this exists to solve
 *
 * Every annotation on the live feed used to be GLOBALLY offset-addressed into one
 * concatenated `runningSummary`: `LiveSummaryEntityDto.start/end`,
 * `LiveSummaryFlaggedSpanDto.start/end`, `LiveSummaryGroundednessSegmentDto.start/end`,
 * and a section's `content` documented as "a contiguous substring of
 * `runningSummary`". That held only because there was exactly ONE document and it
 * was rebuilt whole on every flush.
 *
 * Stream sections independently — which is the point of multi-document — and
 * every offset after a growing section is wrong the moment that section grows.
 * The fix is not bigger numbers, it is a different address: annotations are
 * anchored to `{documentKey, sectionKey, local offset}`, so a section's spans stay
 * valid however much any other section changes.
 *
 * `LiveSummaryEventDto` is untouched and still carries the whole-document view for
 * every existing consumer; this is an ADDITIVE second event on the same stream.
 */

/**
 * Discriminates the kinds of annotation a section can carry.
 *
 * `finding` (Lane N) is deliberately its OWN kind rather than an `entity` with a special `type`.
 * The two are different claims about the text: an `entity` is what a detector RECOGNISED, a
 * `finding` is what the TENANT'S OWN INSTRUCTION said is important. Collapsing them would make a
 * console unable to render one differently from the other, which is precisely the "popped up and
 * highlighted" behaviour the owner asked for — and it would let a tenant's importance vocabulary
 * silently mix into the NER entity classes.
 */
export const SECTION_ANNOTATION_KINDS = ['entity', 'groundedness', 'flagged', 'finding'] as const;
export type SectionAnnotationKind = (typeof SECTION_ANNOTATION_KINDS)[number];

/**
 * One annotation, addressed LOCALLY.
 *
 * `start`/`end` index THIS SECTION'S `content` — never a concatenated document.
 * That is the whole contract; a consumer that resolves them against anything else
 * will mis-highlight the moment a second document exists.
 */
export class SectionAnnotationDto {
  @ApiProperty({ description: 'What this annotation is', enum: SECTION_ANNOTATION_KINDS })
  kind: SectionAnnotationKind;

  @ApiProperty({ description: "Character offset start within THIS SECTION's `content` (never a concatenated document)" })
  start: number;

  @ApiProperty({ description: "Character offset end within THIS SECTION's `content`" })
  end: number;

  @ApiPropertyOptional({
    description:
      'For `entity`: the entity class (MEDICATION, CONDITION, …). For `finding`: the label the TENANT`s own instruction told the model to assign — the platform supplies no importance vocabulary.',
  })
  type?: string;

  @ApiPropertyOptional({ description: 'For `groundedness`: grounded | ungrounded | unverified' })
  verdict?: 'grounded' | 'ungrounded' | 'unverified';

  @ApiPropertyOptional({ description: 'For `entity`: ICD-10-CM code linked by the NLP OntologyLinker, when one matched' })
  icd10?: string;

  @ApiPropertyOptional({ description: 'Model/NLI confidence, when the producer reported one' })
  score?: number;
}

/**
 * Where a section's content came from.
 *
 * A claim in a generated note is only defensible if it can be traced to the turn
 * it came from, so provenance points at TRANSCRIPT segments — the same anchors
 * `TranscriptSegment.charStart/charEnd` already carries.
 */
export class SectionProvenanceDto {
  @ApiPropertyOptional({ description: 'The `TranscriptSegment` id this content is grounded in' })
  transcriptSegmentId?: string;

  @ApiPropertyOptional({ description: 'Character offset start within the parent transcript' })
  transcriptStart?: number;

  @ApiPropertyOptional({ description: 'Character offset end within the parent transcript' })
  transcriptEnd?: number;
}

/**
 * One section's new state, streamed independently of every other section and of
 * every other document.
 */
export class SectionPatchDto {
  @ApiProperty({ description: 'Event discriminator — always `section.patch`', example: 'section.patch' })
  event: 'section.patch';

  @ApiProperty({ description: 'Consultation this section belongs to' })
  consultationId: string;

  @ApiProperty({ description: "WHICH document — the tenant's `DocumentTemplate.slug` (e.g. `soap_note`, `discharge_summary`)" })
  documentKey: string;

  @ApiProperty({ description: 'WHICH section within that document — the compiled template section key' })
  sectionKey: string;

  @ApiProperty({ description: 'Human-readable heading, so a reader needs no template join to render it' })
  title: string;

  @ApiProperty({ description: '0-based render ordinal within the document' })
  idx: number;

  @ApiProperty({
    description:
      'Monotonic per-section revision. A client MUST discard a patch whose revision is not greater than the one it already holds for this `(documentKey, sectionKey)` — patches may arrive out of order.',
  })
  revision: number;

  @ApiProperty({
    description:
      'Section state. `empty` renders as a SKELETON, not an error — an unpopulated section of an in-progress note is normal. `provisional` is model-written and freely replaceable. `confirmed` is clinician-touched and never overwritten by a flush. `locked` is finalized.',
    enum: ['empty', 'provisional', 'confirmed', 'locked'],
  })
  state: 'empty' | 'provisional' | 'confirmed' | 'locked';

  @ApiProperty({ description: 'The section body. Offsets in `annotations` index THIS string.' })
  content: string;

  @ApiPropertyOptional({ description: 'Section-LOCAL annotations', type: [SectionAnnotationDto] })
  annotations?: SectionAnnotationDto[];

  @ApiPropertyOptional({ description: 'Transcript anchors this content is grounded in', type: [SectionProvenanceDto] })
  provenance?: SectionProvenanceDto[];

  @ApiPropertyOptional({
    description:
      'The IMMUTABLE `DocumentTemplateVersion` this section was shaped by. Present so a reader can tell WHICH published shape produced the document it is rendering.',
    nullable: true,
  })
  documentTemplateVersionId?: string | null;

  @ApiProperty({ description: 'ISO-8601 timestamp of this patch' })
  updatedAt: string;
}
