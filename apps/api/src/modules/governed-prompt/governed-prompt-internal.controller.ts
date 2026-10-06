import { Body, Controller, HttpCode, HttpStatus, Inject, Post, UseGuards } from '@nestjs/common';
import { ApiExcludeController, ApiProperty, ApiPropertyOptional, ApiTags } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { ArrayMaxSize, ArrayMinSize, IsArray, IsIn, IsNotEmpty, IsOptional, IsString, Matches, MaxLength, ValidateNested } from 'class-validator';
import { type GovernedPieceInput, IGovernedPromptRegistry } from '@arcaai/applications';
import { Public } from '../../decorators';
import { HarnessServiceTokenGuard } from '../consultation/harness-service-token.guard';
import { InternalTenantLockGuard } from '../../guards/internal-tenant-lock.guard';

/** Only the platform-owned static pieces may be offered for registration; instruction text never is. */
const PLATFORM_PIECE_KINDS = ['PLATFORM', 'LANGUAGE', 'CONTRACT'] as const;
type PlatformPieceKind = (typeof PLATFORM_PIECE_KINDS)[number];

export class VerifyGovernedPiece {
  @ApiProperty({ enum: PLATFORM_PIECE_KINDS })
  @IsIn(PLATFORM_PIECE_KINDS)
  kind: PlatformPieceKind;

  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  @MaxLength(256)
  key: string;

  @ApiProperty({ description: 'sha256 hex of `text` (informational — the registry recomputes it).' })
  @Matches(/^[0-9a-f]{64}$/)
  digest: string;

  @ApiProperty({ description: 'The static piece text. Never echoed, never logged.' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(100_000)
  text: string;
}

export class VerifyGovernedPromptsRequest {
  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  tenantId: string;

  @ApiProperty({ type: [String], description: 'Piece digests (sha256 lower-hex), 1..64.' })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(64)
  @Matches(/^[0-9a-f]{64}$/, { each: true })
  digests: string[];

  @ApiPropertyOptional({ type: [VerifyGovernedPiece] })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(64)
  @ValidateNested({ each: true })
  @Type(() => VerifyGovernedPiece)
  pieces?: VerifyGovernedPiece[];
}

export class VerifyGovernedPromptsResponse {
  @ApiProperty()
  governed: boolean;

  @ApiProperty({ nullable: true, type: String })
  policyVersion: string | null;
}

/**
 * `POST /internal/governed-prompts/verify` — the harness asks whether every piece digest of the
 * system message it composed is registered PASS under the current guardrail policy version, so it
 * may tell apps/text the prompt is governed (FC-4/FC-6). Pieces whose kind the harness cannot stamp
 * on the agent (PLATFORM / LANGUAGE / CONTRACT) may ride along so they get registered for next time.
 *
 * Service-to-service only: authenticated by the controller's own guard AFTER the global chain (so
 * `@Public()`), then the restore lock. There is NO CLS tenant on this route — the tenant comes from
 * the body and is passed into the registry explicitly.
 */
@ApiExcludeController()
@ApiTags('internal-governed-prompts')
@Public()
@UseGuards(HarnessServiceTokenGuard, InternalTenantLockGuard)
@Controller('internal/governed-prompts')
export class GovernedPromptInternalController {
  constructor(@Inject(IGovernedPromptRegistry) private readonly registry: IGovernedPromptRegistry) {}

  @Post('verify')
  @HttpCode(HttpStatus.OK)
  async verify(@Body() body: VerifyGovernedPromptsRequest): Promise<VerifyGovernedPromptsResponse> {
    if (body.pieces?.length) {
      const inputs: GovernedPieceInput[] = body.pieces.map((piece) => ({
        kind: piece.kind,
        sourceType: 'PLATFORM',
        sourceId: null,
        sourceKey: piece.key,
        text: piece.text,
      }));
      // Fire-and-forget: registration is background screening; its failure must never fail the verdict.
      // swallow-ok: background registration; the call falls back to full screening until it lands.
      void this.registry.registerPlatformPieces(inputs, body.tenantId).catch(() => undefined);
    }
    const [governed, policyVersion] = await Promise.all([
      this.registry.areGoverned(body.tenantId, body.digests),
      this.registry.currentPolicyVersion(body.tenantId),
    ]);
    return { governed, policyVersion };
  }
}
