import { IsString, IsOptional, IsBoolean, IsObject } from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';

/**
 * Request DTO for generating a comprehensive cross-chain summary.
 *
 * A comprehensive summary aggregates content from all consultations
 * in the chain (parent-child linked + same-day same-patient) and
 * produces a single unified summary spanning all departments.
 *
 * This supports Step 13 of the consultation workflow: Doctor A
 * requests a final comprehensive summary across all consultations.
 */
export class ComprehensiveSummaryRequest {
    @ApiPropertyOptional({
        description: 'DNA Style ID override (if not provided, auto-resolves from department)',
        example: 'style_DNA_doctor_department_hematology_cp',
    })
    @IsOptional()
    @IsString()
    dnaStyleId?: string;

    @ApiPropertyOptional({
        description: 'Summary template override (e.g., "SOAP", "comprehensive")',
        example: 'comprehensive',
    })
    @IsOptional()
    @IsString()
    template?: string;

    @ApiPropertyOptional({
        description: 'Include NER-extracted named entities in the summary input',
        default: true,
    })
    @IsOptional()
    @IsBoolean()
    includeNER?: boolean;

    @ApiPropertyOptional({
        description: 'Include lab/test results from linked consultations',
        default: true,
    })
    @IsOptional()
    @IsBoolean()
    includeLabResults?: boolean;

    @ApiPropertyOptional({
        description: 'Additional options for the SMR service',
    })
    @IsOptional()
    @IsObject()
    options?: Record<string, unknown>;
}
