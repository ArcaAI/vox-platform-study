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

  // TASK-356 Phase 6 (S1) — surface the template scope so the doctor "My
  // Prompts" UI can distinguish the caller's OWN editable personal prompts
  // (`USER_PERSONAL`) from the read-only tenant/department defaults in the
  // `listAvailableForCaller` result. Additive; admin surfaces ignore it.
  @ApiPropertyOptional({ description: 'Template scope (e.g. USER_PERSONAL, DEPARTMENT_DEFAULT, TENANT_DEFAULT)' })
  scope?: string;

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

  // TASK-407 — the Agent Jobs surface shows each agent's last prompt-test
  // outcome. Score + timestamp only; `lastTestOutput` is vault-encrypted and
  // deliberately NOT exposed on list/detail responses (the test route returns
  // the fresh output directly).
  @ApiPropertyOptional({ description: 'Score (0-100) of the most recent prompt test run', example: 87 })
  lastTestScore?: number;

  @ApiPropertyOptional({ description: 'Timestamp of the most recent prompt test run' })
  lastTestAt?: string;

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
