import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { ResourceStatusType } from '@arcaai/domains';
import { PromptVariableDeclarationDto } from './prompt-variable-declaration.dto';

export class PromptTemplateResponse {
  @ApiProperty({ description: 'Template ID' })
  id: string;

  /**
   * The OWNING tenant. Load-bearing for the console: the approval gate is a
   * SPLIT gate (`assertCanApprove`) — a SYSTEM/library row is SUPER_ADMIN-only
   * while a tenant-owned row devolves to `manage:PromptTemplate` — and a client
   * that cannot tell the two apart has to hide approval from every tenant admin.
   */
  @ApiPropertyOptional({ description: 'Owning tenant id. The SYSTEM tenant marks a platform/library template.' })
  tenantId?: string;

  @ApiProperty({ description: 'Template name' })
  name: string;

  @ApiPropertyOptional({ description: 'Template description' })
  description?: string;

  @ApiProperty({ description: 'Prompt content text' })
  content: string;

  @ApiProperty({ description: 'Template category' })
  category: string;

  // Surface the template scope so the doctor "My
  // Prompts" UI can distinguish the caller's OWN editable personal prompts
  // (`USER_PERSONAL`) from the read-only tenant/department defaults in the
  // `listAvailableForCaller` result. Additive; admin surfaces ignore it.
  @ApiPropertyOptional({ description: 'Template scope (e.g. USER_PERSONAL, DEPARTMENT_DEFAULT, TENANT_DEFAULT)' })
  scope?: string;

  // Real Draft/Published/Approved lifecycle column (was previously
  // dropped server-side; the admin status filter is now server-side).
  //
  // `APPROVED` was missing from the declared union even though the enum, the
  // list filter and the approve route all produce it — an approved row was
  // already outside this contract. Widened rather than worked around.
  @ApiProperty({ description: 'Publication status', enum: ['DRAFT', 'PUBLISHED', 'APPROVED'], default: 'DRAFT' })
  status: 'DRAFT' | 'PUBLISHED' | 'APPROVED';

  @ApiPropertyOptional({ description: 'Template variable definitions (raw, as stored)' })
  variables?: Record<string, unknown>;

  /**
   * Server-truncated (400 chars) copy of `content` (TASK-890 §3.6) — the
   * picker/list projection so a row list never has to ship every template's
   * full (up to 50,000-char) body just to render a preview. The full `content`
   * field above stays populated on `GET :id`.
   */
  @ApiPropertyOptional({ description: 'Server-truncated (400 chars) preview of `content`, for list/picker surfaces' })
  contentPreview?: string;

  /** Typed variable declarations, parsed from `variables` (§3.6). Always an array, empty when none are declared. */
  @ApiProperty({ description: 'Typed prompt-variable declarations', type: [PromptVariableDeclarationDto] })
  declaredVariables: PromptVariableDeclarationDto[];

  @ApiProperty({ description: 'Current version number' })
  currentVersionNumber: number;

  /**
   * The `PromptVersion` snapshot pinned at the last approval — `null` when the
   * template has never been approved.
   *
   * Load-bearing for admin surfaces: `PromptResolutionService` serves THIS
   * snapshot to clinical flows, never the mutable `content` column. So when
   * `approvedVersionNumber < currentVersionNumber` the template is being edited
   * ahead of what is actually running, and an admin can only see that if the
   * field is exposed. It previously was not, which made the pinned-vs-current
   * distinction invisible in the console.
   */
  @ApiPropertyOptional({
    description: 'PromptVersion number pinned at the last approval — what resolution actually serves. Null = never approved.',
    example: 3,
    nullable: true,
  })
  approvedVersionNumber?: number | null;

  /**
   * TASK-890 §3.4 — REFERENCE-SET provenance, the prompt counterpart of
   * `AgentResponse.sourceAgentId`. `sourceTemplateId` names the SYSTEM row this
   * one was CLONED from when the tenant was provisioned (null = hand-written by
   * the tenant); `templateLocked` means the tenant may not edit it, so a console
   * that cannot see either field cannot explain why an edit is refused, or which
   * rows a re-sync would replace.
   */
  @ApiPropertyOptional({
    description: 'The SYSTEM reference row this template was cloned from at provisioning. Null = the tenant authored it.',
    nullable: true,
  })
  sourceTemplateId?: string | null;

  @ApiPropertyOptional({ description: 'The clone is platform-managed: the tenant may not edit it.', default: false })
  templateLocked?: boolean;

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

  // The Agent Jobs surface shows each agent's last prompt-test
  // outcome. Score + timestamp only; `lastTestOutput` is vault-encrypted and
  // deliberately NOT exposed on list/detail responses (the test route returns
  // the fresh output directly).
  @ApiPropertyOptional({ description: 'Score (0-100) of the most recent prompt test run', example: 87 })
  lastTestScore?: number;

  @ApiPropertyOptional({ description: 'Timestamp of the most recent prompt test run' })
  lastTestAt?: string;

  /**
   * Row `_version` for optimistic concurrency control. Clients echo this back via
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
