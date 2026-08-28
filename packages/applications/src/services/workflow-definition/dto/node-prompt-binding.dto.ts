import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsInt, IsObject, IsOptional, IsString, MaxLength, Min } from 'class-validator';
import { WorkflowDefinitionResponse } from './workflow-definition.response';

/**
 * DD-11 — edit a node's prompt FROM WITHIN THE NODE.
 *
 * Deliberately NOT a "set the pin" request. Supplying `content` is what makes
 * this path meaningful: it mints a new `PromptVersion` AND moves this node's
 * pin to it, atomically. Splitting those into two calls would leave a window in
 * which a version exists that no node points at, or a pin that names a version
 * a failed second call never created.
 *
 * `promptVersionNumber` is absent by design — it is SERVER-STAMPED (the next
 * version number, computed inside the transaction from `max(existing) + 1`).
 * The global pipe runs `forbidNonWhitelisted`, so a caller cannot submit one.
 */
export class UpdateNodePromptRequest {
  @ApiProperty({ description: 'The new prompt body. Minted as a new immutable PromptVersion.' })
  @IsString()
  @MaxLength(50000)
  content: string;

  @ApiPropertyOptional({ description: 'Recorded immutably on the new version row.' })
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  changeReason?: string;

  @ApiPropertyOptional({ description: 'Template variables to store alongside the new version.' })
  @IsOptional()
  @IsObject()
  variables?: Record<string, unknown>;

  @ApiPropertyOptional({ description: 'Optimistic-concurrency version of the WORKFLOW DEFINITION; the `If-Match` header overrides it.' })
  @IsOptional()
  @IsInt()
  @Min(1)
  expectedVersion?: number;
}

/** One node's prompt binding, plus whether a newer version of its template exists. */
export class NodePromptBindingResponse {
  @ApiProperty() nodeId: string;
  @ApiProperty() nodeType: string;
  @ApiProperty() promptTemplateId: string;
  @ApiPropertyOptional({ nullable: true }) promptTemplateName: string | null;
  @ApiPropertyOptional({ nullable: true, description: 'The node’s own pin. Null = never pinned.' })
  pinnedVersionNumber: number | null;
  @ApiPropertyOptional({ nullable: true, description: 'The highest version number the template currently has.' })
  latestVersionNumber: number | null;
  @ApiProperty({
    description:
      'True when the template has a version newer than this node’s pin. This is the "new version available" ' +
      'affordance: an out-of-band edit on the Prompt management screen deliberately moves NO node’s pin, so ' +
      'each referencing node is re-pinned separately and visibly.',
  })
  hasNewVersion: boolean;
}

/**
 * The result of an in-node prompt update — the workflow definition as it now
 * stands, PLUS what the request actually did to the prompt plane.
 *
 * A superset of `WorkflowDefinitionResponse`, not a wrapper around it,
 * deliberately: existing callers (the Studio's `WithEtag<WorkflowDefinition>`,
 * the generated Node SDK) keep reading the definition straight off the body,
 * while a caller that cares can now tell the two outcomes apart. Wrapping it
 * would have been a breaking change for a purely additive fact.
 *
 * The distinction is the whole point of §7b item 1: adopting a version
 * unchanged moves the pin and mints NOTHING, so a client that reports
 * "minted v10" on every save would now be lying on the common path.
 */
export class NodePromptUpdateResponse extends WorkflowDefinitionResponse {
  @ApiProperty({
    description:
      'True when this request created a new immutable PromptVersion. False when the submitted content was byte-identical to the template’s latest version, in which case the node’s pin was simply moved to that existing version and nothing was minted.',
  })
  promptVersionMinted: boolean;

  @ApiProperty({ description: 'The prompt version this node is pinned to AFTER the request.' })
  promptVersionNumber: number;

  @ApiPropertyOptional({ nullable: true, description: 'The node’s pin BEFORE the request. Null when the node was unpinned.' })
  previousPromptVersionNumber: number | null;
}
