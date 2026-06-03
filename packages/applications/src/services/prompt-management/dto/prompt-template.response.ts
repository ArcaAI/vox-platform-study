import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { ResourceStatusType } from '@arcaai/domains';

export class PromptTemplateResponse {
  @ApiProperty({ description: 'Template ID' })
  id: string;

  @ApiProperty({ description: 'Template name' })
  name: string;

  @ApiPropertyOptional({ description: 'Template description' })
  description?: string;

  @ApiProperty({ description: 'Prompt content text' })
  content: string;

  @ApiProperty({ description: 'Template category' })
  category: string;

  // TASK-331 doc-02 F5 — real Draft/Published lifecycle column (was previously
  // dropped server-side; the admin status filter is now server-side).
  @ApiProperty({ description: 'Publication status', enum: ['DRAFT', 'PUBLISHED'], default: 'DRAFT' })
  status: 'DRAFT' | 'PUBLISHED';

  @ApiPropertyOptional({ description: 'Template variable definitions' })
  variables?: Record<string, unknown>;

  @ApiProperty({ description: 'Current version number' })
  currentVersionNumber: number;

  @ApiPropertyOptional({ description: 'Department ID' })
  departmentId?: string;

  @ApiPropertyOptional({ description: 'Tags', type: [String] })
  tags?: string[];

  @ApiProperty({ description: 'Creation timestamp' })
  createdAt: string;

  @ApiProperty({ description: 'Last update timestamp' })
  updatedAt: string;

  @ApiPropertyOptional({ description: 'Resource status', enum: ['ENABLED', 'DISABLED'] })
  resourceStatus?: ResourceStatusType;

  /**
   * Row `_version` for optimistic concurrency control (TASK-302
   * Stream D Phase E.3). Clients echo this back via
   * `If-Match: "<version>"` (or `expectedVersion` in the body for
   * service-to-service callers) on the next PATCH. The server's
   * compare-and-set (`promptTemplateRepository.updateWithVersion`)
   * fails with `412 Precondition Failed` if `_version` has drifted
   * under the client between read and write.
   *
   * **Distinct from `currentVersionNumber`**: that field is the
   * human-meaningful counter that increments per content edit and
   * drives the `PromptVersion` history sibling table. `version`
   * here is the database-owned OCC token.
   *
   * The `ETagInterceptor` (Phase D.1) also stamps `ETag: "<version>"`
   * on the response so SDK clients can use the canonical RFC 7232
   * `If-Match` mechanism without parsing the body.
   */
  @ApiProperty({
    description:
      'Row version for optimistic concurrency control (NOT the PromptVersion counter). Echo back as `If-Match: "<version>"` or `expectedVersion` on PATCH.',
    example: 7,
  })
  version!: number;
}
