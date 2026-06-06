import { IsArray, IsBoolean, IsNumber, IsObject, IsOptional, IsString } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

/**
 * TASK-330 Phase 1 — Lane G internal-harness contract DTOs.
 *
 * Every request carries `tenantId` in the body: the harness calls these
 * endpoints out-of-band of the API edge ClsModule middleware, so the internal
 * service re-establishes CLS from this field (mirroring the BullMQ workers).
 */

// ---------------------------------------------------------------------------
// entities
// ---------------------------------------------------------------------------

export class HarnessEntityItem {
  @ApiProperty({ description: 'Recognized text span' })
  @IsString()
  text: string;

  @ApiProperty({ description: 'Entity class/type (e.g. MEDICATION, CONDITION, PROCEDURE)' })
  @IsString()
  type: string;

  @ApiPropertyOptional({ description: 'Normalized / canonical form' })
  @IsOptional()
  @IsString()
  normalizedText?: string;

  @ApiPropertyOptional({ description: 'Source-text character offset start' })
  @IsOptional()
  @IsNumber()
  startOffset?: number;

  @ApiPropertyOptional({ description: 'Source-text character offset end' })
  @IsOptional()
  @IsNumber()
  endOffset?: number;

  @ApiPropertyOptional({ description: 'Confidence score (0.0 - 1.0)' })
  @IsOptional()
  @IsNumber()
  confidence?: number;

  @ApiPropertyOptional({ description: 'Transcript ContextItem the span maps back to (provenance)' })
  @IsOptional()
  @IsString()
  transcriptContextItemId?: string;

  @ApiPropertyOptional({ description: 'Transcript-span offset start (provenance)' })
  @IsOptional()
  @IsNumber()
  transcriptStartOffset?: number;

  @ApiPropertyOptional({ description: 'Transcript-span offset end (provenance)' })
  @IsOptional()
  @IsNumber()
  transcriptEndOffset?: number;
}

export class HarnessPersistEntitiesRequest {
  @ApiProperty({ description: 'Tenant the harness is acting on behalf of' })
  @IsString()
  tenantId: string;

  @ApiPropertyOptional({ description: 'Responsible user id, if any (falls back to a worker session)' })
  @IsOptional()
  @IsString()
  userId?: string;

  @ApiProperty({ description: 'The ContextItem (transcript) the entities were extracted from' })
  @IsString()
  contextItemId: string;

  @ApiProperty({ description: 'Recognized named entities to persist', type: [HarnessEntityItem] })
  @IsArray()
  entities: HarnessEntityItem[];
}

export interface HarnessPersistEntitiesResponse {
  savedCount: number;
  entityIds: string[];
}

// ---------------------------------------------------------------------------
// assemble
// ---------------------------------------------------------------------------

export class HarnessAssembleRequest {
  @ApiProperty({ description: 'Tenant the harness is acting on behalf of' })
  @IsString()
  tenantId: string;

  @ApiPropertyOptional({ description: 'Responsible user id, if any' })
  @IsOptional()
  @IsString()
  userId?: string;

  @ApiPropertyOptional({ description: 'Explicit prompt template override (else resolved via tier chain)' })
  @IsOptional()
  @IsString()
  template?: string;

  @ApiPropertyOptional({ description: 'DNA writing style id' })
  @IsOptional()
  @IsString()
  dnaStyleId?: string;

  @ApiPropertyOptional({ description: 'Conversation language (default en)' })
  @IsOptional()
  @IsString()
  conversationLanguage?: string;
}

export interface HarnessAssembleResponse {
  userPrompt: string;
  systemPrompt: string;
  hyperparameters: Record<string, number>;
  responseFormat: { type: string; json_schema: Record<string, unknown>; strict: boolean } | null;
  promptTemplateId: string | null;
  promptVersion: string | null;
  resolvedFrom: string;
}

// ---------------------------------------------------------------------------
// draft
// ---------------------------------------------------------------------------

export class HarnessDraftRequest {
  @ApiProperty({ description: 'Tenant the harness is acting on behalf of' })
  @IsString()
  tenantId: string;

  @ApiPropertyOptional({ description: 'Responsible user id, if any' })
  @IsOptional()
  @IsString()
  userId?: string;

  @ApiPropertyOptional({ description: 'SSE job id minted at start, for progress notifications' })
  @IsOptional()
  @IsString()
  jobId?: string;

  @ApiProperty({ description: 'The generated SOAP note content' })
  @IsString()
  content: string;

  @ApiPropertyOptional({ description: 'Generating model name' })
  @IsOptional()
  @IsString()
  modelName?: string;

  @ApiPropertyOptional({ description: 'Generating model version' })
  @IsOptional()
  @IsString()
  modelVersion?: string;

  @ApiPropertyOptional({ description: 'Full sensor score detail object' })
  @IsOptional()
  @IsObject()
  sensorScores?: Record<string, unknown>;

  @ApiPropertyOptional({ description: 'Per-claim citation/provenance map' })
  @IsOptional()
  @IsObject()
  citationsMap?: Record<string, unknown>;

  @ApiPropertyOptional({ description: 'Entity-faithfulness sensor score column' })
  @IsOptional()
  @IsNumber()
  entityFaithfulnessScore?: number;

  @ApiPropertyOptional({ description: 'Coverage/omission sensor score column' })
  @IsOptional()
  @IsNumber()
  coverageScore?: number;

  @ApiPropertyOptional({ description: 'RAG-triad score column' })
  @IsOptional()
  @IsNumber()
  ragTriadScore?: number;

  @ApiPropertyOptional({ description: 'Resolved prompt template id (from assemble)' })
  @IsOptional()
  @IsString()
  promptTemplateId?: string;

  @ApiPropertyOptional({ description: 'Resolved prompt version (from assemble)' })
  @IsOptional()
  @IsString()
  promptVersion?: string;

  @ApiPropertyOptional({ description: 'DNA writing style id used for generation' })
  @IsOptional()
  @IsString()
  dnaStyleId?: string;

  @ApiPropertyOptional({ description: 'Gate verdict (PASS | REGEN | FLAG)' })
  @IsOptional()
  @IsString()
  gateDecision?: string;

  @ApiPropertyOptional({ description: 'Whether this draft was produced by an auto-triggered pipeline' })
  @IsOptional()
  @IsBoolean()
  isAutoGenerated?: boolean;
}

export interface HarnessDraftResponse {
  contextItemId: string;
}

// ---------------------------------------------------------------------------
// gate-decision
// ---------------------------------------------------------------------------

export class HarnessGateDecisionRequest {
  @ApiProperty({ description: 'Tenant the harness is acting on behalf of' })
  @IsString()
  tenantId: string;

  @ApiPropertyOptional({ description: 'Responsible user id, if any' })
  @IsOptional()
  @IsString()
  userId?: string;

  @ApiPropertyOptional({ description: 'Clinician sign-off decision (e.g. SIGNED | REJECTED)' })
  @IsOptional()
  @IsString()
  decision?: string;

  @ApiPropertyOptional({ description: 'Gate verdict at draft time (PASS | REGEN | FLAG)' })
  @IsOptional()
  @IsString()
  gateDecision?: string;

  @ApiPropertyOptional({ description: 'The signed ContextItemVersion id' })
  @IsOptional()
  @IsString()
  contextItemVersionId?: string;

  @ApiPropertyOptional({ description: 'Attestation hash bound to the signed note' })
  @IsOptional()
  @IsString()
  attestationHash?: string;

  @ApiPropertyOptional({ description: 'Clinician who signed off' })
  @IsOptional()
  @IsString()
  clinicianId?: string;
}

export interface HarnessGateDecisionResponse {
  recorded: boolean;
}
