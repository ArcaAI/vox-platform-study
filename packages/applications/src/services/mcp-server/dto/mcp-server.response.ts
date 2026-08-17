import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

/**
 * a registered MCP external-tools server row.
 *
 * SECURITY: this projection carries NO secret material. `authRef` is a Vault
 * PATH ONLY (e.g. `secret/data/mcp/terminology`); the credential itself lives
 * in Vault and is NEVER stored in the DB nor echoed
 * here. The same object shape backs both the super-admin CRUD surface and the
 * console "Tools & MCP" registry read.
 */
export class McpServerResponse {
  @ApiProperty({ description: 'Server row id' })
  id!: string;

  @ApiProperty({ description: 'Owning tenant id (SYSTEM tenant = shared registry row)' })
  tenantId!: string;

  @ApiProperty({ description: 'Human-readable server name (unique per tenant)', example: 'fhir-terminology' })
  name!: string;

  @ApiPropertyOptional({ description: 'Optional description', nullable: true })
  description?: string | null;

  @ApiProperty({ description: 'MCP server root URL (streamable-HTTP endpoint)', example: 'https://terminology.internal/mcp' })
  baseUrl!: string;

  @ApiProperty({ description: 'Transport (only "streamable-http" is supported)', example: 'streamable-http' })
  transport!: string;

  @ApiPropertyOptional({
    description: 'Vault PATH to the server credential — NEVER secret material. Null when the server needs no auth.',
    nullable: true,
    example: 'secret/data/mcp/terminology',
  })
  authRef?: string | null;

  @ApiPropertyOptional({
    description:
      'Per-server tool allow-list (tool ids). The effective allowlist is HarnessPolicy.toolAllowlist ∩ this. Null = no server-side restriction.',
    nullable: true,
    type: [String],
  })
  toolAllowlist?: string[] | null;

  @ApiProperty({ description: 'PHI boundary: "external" (cloud egress; PHI guard fail-closed) | "in-boundary" (self-hosted).', example: 'external' })
  phiBoundary!: string;

  @ApiProperty({ description: 'Per-server runtime kill-switch. False = dormant.', example: false })
  enabled!: boolean;

  @ApiPropertyOptional({ description: 'Resource status' })
  resourceStatus?: string;

  @ApiProperty({ description: 'OCC version (drives the If-Match token).', example: 1 })
  version!: number;

  @ApiPropertyOptional({ description: 'Created timestamp (ISO)' })
  createdAt?: string;

  @ApiPropertyOptional({ description: 'Updated timestamp (ISO)' })
  updatedAt?: string;
}

/** list envelope for the registry read (console + admin). */
export class McpServerListResponse {
  @ApiProperty({ type: [McpServerResponse] })
  items!: McpServerResponse[];

  @ApiProperty({ description: 'Total number of servers returned', example: 1 })
  total!: number;
}
