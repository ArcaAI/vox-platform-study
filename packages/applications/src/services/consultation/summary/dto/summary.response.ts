import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

/**
 * TASK-1001 (wave 2, final note) — a passage of one section of the note that ANOTHER section of the
 * same note already carries. The same `duplicate` annotation the live note publishes
 * (`SectionAnnotationDto`, kind `duplicate`), computed over the note's FINAL text by the same
 * detector. A flag only: nothing it addresses was dropped or altered.
 */
export class SummaryDuplicateAnnotationDto {
  @ApiProperty({ description: 'Always `duplicate` — the only annotation the final note carries', enum: ['duplicate'] })
  kind: 'duplicate';

  @ApiProperty({
    description: "Character offset start within THIS SECTION's text — `content.slice(section.start, section.end)` — never within the whole `content`",
  })
  start: number;

  @ApiProperty({ description: "Character offset end within THIS SECTION's text (exclusive)" })
  end: number;

  @ApiProperty({ description: 'The `sectionKey` of the EARLIER section of this note that already carries the passage' })
  duplicateOf: string;

  @ApiPropertyOptional({
    description: 'The heading of that section as this note prints it — prefer it over `duplicateOf` when naming the section to a reader',
  })
  duplicateOfTitle?: string;
}

/**
 * TASK-1001 (wave 2, final note) — one headed section of `SummaryResponse.content`, located rather
 * than copied: its body is `content.slice(start, end)`, so `content` itself stays the one, unaltered
 * copy of the note.
 */
export class SummaryNoteSectionDto {
  @ApiProperty({
    description:
      "The key of this consultation's document section with the same title (the key `GET consultations/:id/documents/sections` reports), else a key derived from the heading (`Family History` → `family_history`)",
  })
  sectionKey: string;

  @ApiProperty({ description: 'The heading as the note prints it (`## Family History`, `**Family History:**` → `Family History`)' })
  title: string;

  @ApiProperty({ description: "Character offset in `content` where this section's body starts (after the heading line, leading whitespace skipped)" })
  start: number;

  @ApiProperty({ description: "Character offset in `content` where this section's body ends (exclusive, trailing whitespace excluded)" })
  end: number;

  @ApiPropertyOptional({
    description:
      '`duplicate` flags ONLY — runs of at least two consecutive sentences that an EARLIER section of this note already carries (normalised-equal, or word-token Jaccard >= 0.8 with identical numbers). Offsets are section-LOCAL. Absent when nothing is flagged.',
    type: [SummaryDuplicateAnnotationDto],
  })
  annotations?: SummaryDuplicateAnnotationDto[];
}

export class SummaryResponse {
  @ApiProperty()
  id: string;

  @ApiProperty()
  consultationId: string;

  @ApiProperty({ enum: ['summary', 'pre_summary'] })
  type: string;

  @ApiProperty()
  content: string;

  @ApiPropertyOptional({ description: 'Summary metadata including LLM info' })
  structuredData?: {
    llmProvider?: string;
    modelName?: string;
    processingTimeMs?: number;
    dnaStyleId?: string;
    inputTokens?: number;
    outputTokens?: number;
    entities?: Record<string, unknown>[];
    cacheHit?: boolean;
    qualityScore?: number;
    promptResolvedFrom?: 'preferred' | 'department' | 'default';
    resolvedPromptId?: string;
  };

  @ApiProperty()
  createdAt: string;

  @ApiProperty()
  updatedAt: string;

  /**
   * `SummaryDtoMapper.toResponse` maps this DTO from the
   * underlying `ContextItemEntity` (the summary IS a ContextItem row), so
   * `_version` is the same OCC compare-and-set counter `ContextItemResponse`
   * exposes. Echo back via `If-Match: "<version>"` (or the body-field
   * `expectedVersion`) on `PATCH :id/summary/:summaryId` and
   * `POST :id/summary/:contextItemId/approve`.
   */
  @ApiProperty({
    description: 'Row version for optimistic concurrency control. Echo back as `If-Match: "<version>"` or `expectedVersion` on PATCH.',
    example: 7,
  })
  version!: number;

  /**
   * TASK-1001 (wave 2, final note) — the note's headed sections, each with the cross-section
   * `duplicate` flags computed over this FINAL text. The live note carries those flags while it is
   * being written; without this, a flagged passage lost its flag the moment the note was finalised.
   *
   * Populated by `GET consultations/:id/summary/latest` only. Derived, never stored: `content` is
   * returned byte-for-byte as persisted, and nothing here removes or rewrites a character of it.
   */
  @ApiPropertyOptional({
    description:
      '`GET :id/summary/latest` only — `content` split at its heading lines (`## Title`, `**Title**`, `**Title:**`; text before the first heading belongs to no section), each section located by offsets into `content` and carrying the cross-section `duplicate` flags computed over this final text. A flag never removes or alters content. Absent when `content` has fewer than two headed sections.',
    type: [SummaryNoteSectionDto],
  })
  sections?: SummaryNoteSectionDto[];
}
