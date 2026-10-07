import { ApiProperty } from '@nestjs/swagger';
import { IsIn, IsNotEmpty, IsString, IsUUID, MaxLength } from 'class-validator';
import {
  RESIDENCY_CONTROLLED_SERVICES,
  type ReadinessCheckId,
  type ResidencyControlledService,
  type CatalogueSizeSource,
  READINESS_CHECK_IDS,
} from '../model-residency.types';

/**
 * TASK-1051 — the four routes the review redesign adds under
 * `/api/v1/admin/model-residency/*`, pinned by
 * `tests/contracts/model-residency-admin.fixture.json` (`preview`, `links`,
 * `dismiss`, `readiness`). Same gate as the rest of the prefix: platform admin,
 * tenant-less, never an API key.
 */

// ── POST load/preview — the dry-run admission (body = LoadModelResidencyRequest) ──

export class ModelResidencyPreviewModel {
  @ApiProperty() service!: string;
  @ApiProperty() modelRef!: string;
  @ApiProperty() name!: string;
  @ApiProperty({ nullable: true, type: Number }) bytes!: number | null;
  @ApiProperty({ example: 'On demand · idle 5 h', description: 'Why it is (or is not) offered, in plain words.' }) reason!: string;
}

export class ModelResidencyLoadPreviewResponse {
  @ApiProperty() service!: string;
  @ApiProperty() modelRef!: string;
  @ApiProperty({
    nullable: true,
    type: String,
    description: 'Where the load would land (`gpu0`, `multi`, `cpu:<service>`); `null` when the service`s device is unknown.',
  })
  device!: string | null;
  @ApiProperty({ nullable: true, type: Number, description: 'Bytes admission reserves (measured, else catalogue × 1.2); `null` = no size known.' })
  needBytes!: number | null;
  @ApiProperty({ enum: ['measured', 'catalogue', 'unknown'] }) needSource!: CatalogueSizeSource;
  @ApiProperty({ nullable: true, type: Number }) freeBytes!: number | null;
  @ApiProperty({ nullable: true, type: Number }) headroomBytes!: number | null;
  @ApiProperty({ nullable: true, type: Number }) unattributedBytes!: number | null;
  @ApiProperty({ description: '`max(0, needBytes − (freeBytes − headroomBytes))`; 0 when it fits.' }) shortfallBytes!: number;
  @ApiProperty({ description: 'Admission would accept it without force.' }) fits!: boolean;
  @ApiProperty({
    nullable: true,
    enum: ['NO_SIZE', 'OVER_BUDGET', 'ALREADY_LOADED', 'LOAD_IN_PROGRESS', 'IN_FLIGHT'],
    description: 'What an un-forced load would answer; `null` when it would be admitted.',
  })
  refusal!: 'NO_SIZE' | 'OVER_BUDGET' | 'ALREADY_LOADED' | 'LOAD_IN_PROGRESS' | 'IN_FLIGHT' | null;
  @ApiProperty({
    type: [ModelResidencyPreviewModel],
    description: 'ON_DEMAND resident models on the same device that could be unloaded to make room, largest first.',
  })
  evictable!: ModelResidencyPreviewModel[];
  @ApiProperty({
    type: [ModelResidencyPreviewModel],
    description: 'Resident models on the same device that are pinned (live path or policy) and are NOT offered.',
  })
  pinned!: ModelResidencyPreviewModel[];
}

// ── POST links — confirm which catalogue row a reported engine key is ──

export class LinkModelResidencyRuntimeKeyRequest {
  @ApiProperty({ enum: RESIDENCY_CONTROLLED_SERVICES })
  @IsIn(RESIDENCY_CONTROLLED_SERVICES)
  service!: ResidencyControlledService;

  @ApiProperty({ example: 'gemma-4-e2b-it-qat@q4_0', description: 'The key EXACTLY as the service reports it.' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(512)
  runtimeKey!: string;

  @ApiProperty({ description: 'The SYSTEM catalogue row it is.' })
  @IsUUID()
  aiModelId!: string;
}

export class LinkModelResidencyRuntimeKeyResponse {
  @ApiProperty() aiModelId!: string;
  @ApiProperty() service!: string;
  @ApiProperty({ type: [String], description: 'Every key the row is now recognised under (catalogue ref first).' }) runtimeKeys!: string[];
}

// ── POST suggestions/:id/dismiss ──

export class DismissModelResidencySuggestionResponse {
  @ApiProperty() id!: string;
  @ApiProperty({
    description: 'Hidden until the controller reaches a DIFFERENT conclusion for this model, or the gateway restarts (in-memory, shadow mode).',
  })
  dismissed!: boolean;
}

// ── GET readiness ──

export class ModelResidencyReadinessCheck {
  @ApiProperty({ enum: READINESS_CHECK_IDS }) id!: ReadinessCheckId;
  @ApiProperty() title!: string;
  @ApiProperty() passed!: boolean;
  @ApiProperty({ description: 'The evidence, in plain words.' }) detail!: string;
}

export class ModelResidencyShadowSummary {
  @ApiProperty({ description: 'Start of the window the counts cover (gateway start — the log is in memory).' }) since!: string;
  @ApiProperty() loads!: number;
  @ApiProperty() unloads!: number;
  @ApiProperty() refusedOverBudget!: number;
  @ApiProperty({ description: 'Loads of a model that was already resident under an unmatched key.' }) duplicateLoads!: number;
}

export class ModelResidencyReadinessResponse {
  @ApiProperty({ enum: ['shadow', 'enforce'] }) mode!: 'shadow' | 'enforce';
  @ApiProperty() passed!: number;
  @ApiProperty() total!: number;
  @ApiProperty({ type: [ModelResidencyReadinessCheck], description: 'In `READINESS_CHECK_IDS` order.' }) checks!: ModelResidencyReadinessCheck[];
  @ApiProperty({ type: ModelResidencyShadowSummary }) shadow!: ModelResidencyShadowSummary;
}
