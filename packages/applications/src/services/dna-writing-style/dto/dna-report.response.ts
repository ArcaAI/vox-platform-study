import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { ResourceStatusType } from '@arcaai/domains';

export class DnaReportResponse {
  @ApiProperty({ description: 'Report ID' })
  id: string;

  @ApiProperty({ description: 'Doctor ID' })
  doctorId: string;

  @ApiPropertyOptional({ description: 'Report data (JSON)' })
  reportData?: Record<string, unknown>;

  @ApiPropertyOptional({ description: 'Extracted writing style text' })
  styleText?: string;

  @ApiProperty({ description: 'Whether this is the latest report' })
  isLatest: boolean;

  @ApiProperty({ description: 'Current version number' })
  currentVersionNumber: number;

  @ApiProperty({ description: 'Creation timestamp' })
  createdAt: string;

  @ApiProperty({ description: 'Last update timestamp' })
  updatedAt: string;

  @ApiPropertyOptional({ description: 'Resource status', enum: ['ENABLED', 'DISABLED'] })
  resourceStatus?: ResourceStatusType;

  /**
   * Row `_version` for optimistic concurrency control (TASK-326 X7 / D-2).
   * Clients echo this back via `If-Match: "<version>"` (or `expectedVersion`
   * in the body for service-to-service callers) on the next PATCH. The
   * server's compare-and-set (`dnaReportRepository.updateWithVersion`) fails
   * with `412 Precondition Failed` if `_version` has drifted under the client
   * between read and write.
   *
   * **Distinct from `currentVersionNumber`**: that field is the
   * human-meaningful counter that increments per content edit and drives the
   * `DnaVersion` history sibling table. `version` here is the database-owned
   * OCC token.
   *
   * The `ETagInterceptor` also stamps `ETag: "<version>"` on the response so
   * SDK clients can use the canonical RFC 7232 `If-Match` mechanism without
   * parsing the body.
   */
  @ApiProperty({
    description:
      'Row version for optimistic concurrency control (NOT the DnaVersion counter). Echo back as `If-Match: "<version>"` or `expectedVersion` on PATCH.',
    example: 1,
  })
  version!: number;
}
