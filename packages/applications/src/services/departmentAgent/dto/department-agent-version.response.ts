import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

/**
 * One immutable `DepartmentAgentVersion` snapshot, read-
 * only. Mirrors `ConsultationContextSchemaVersionResponse`
 * (`consultation-context-schema/dto/consultation-context-schema.response.ts`)
 * exactly: an `id`/`agentId`/`versionNumber` header, the canonical JSON
 * `configSnapshot` + its `checksum`, an optional `changeReason` (populated by
 * `DepartmentAgentService#clone`, absent on an ordinary create/update save —
 * see that service's `writeLoopConfigVersionIfNeeded`), and provenance.
 */
export class DepartmentAgentVersionResponse {
  @ApiProperty({ description: 'Version row id' })
  id!: string;

  @ApiProperty({ description: 'The DepartmentAgent this snapshot belongs to' })
  agentId!: string;

  @ApiProperty({ description: 'Monotonically increasing per agent, starting at 1' })
  versionNumber!: number;

  @ApiProperty({ description: 'The seven TASK-659 loop-configuration fields, canonical snapshot', type: 'object', additionalProperties: true })
  configSnapshot!: Record<string, unknown>;

  @ApiProperty({ description: 'sha256 over the canonical (key-sorted) JSON of `configSnapshot`' })
  checksum!: string;

  @ApiPropertyOptional({ description: 'Why this version was written, when recorded (e.g. clone lineage)', nullable: true })
  changeReason?: string | null;

  @ApiPropertyOptional({ description: 'Acting user', nullable: true })
  createdBy?: string | null;

  @ApiProperty({ description: 'Creation timestamp (ISO)' })
  createdAt!: string;
}
