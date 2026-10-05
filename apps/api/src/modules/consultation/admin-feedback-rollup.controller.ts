import { Controller, Get, Inject, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiPropertyOptional, ApiResponse, ApiTags } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { ArrayMaxSize, ArrayUnique, IsArray, IsDateString, IsIn, IsOptional, IsString } from 'class-validator';
import {
  FEEDBACK_ROLLUP_DIMENSIONS,
  FeedbackRollupDimension,
  FeedbackRollupResponse,
  IFeedbackRollupReader,
  IFeedbackRollupReaderToken,
} from '@arcaai/applications';
import { CanRead, ForbidApiKey, RequiredSvcScopes } from '../../decorators';

export class FeedbackRollupQuery {
  @ApiPropertyOptional({ description: 'Inclusive start day (ISO 8601 date).' })
  @IsOptional()
  @IsDateString()
  from?: string;

  @ApiPropertyOptional({ description: 'Inclusive end day (ISO 8601 date).' })
  @IsOptional()
  @IsDateString()
  to?: string;

  @ApiPropertyOptional({ description: `Comma-separated dimensions: ${FEEDBACK_ROLLUP_DIMENSIONS.join(', ')}.`, type: String })
  @IsOptional()
  @Transform(({ value }) => (typeof value === 'string' ? value.split(',').map((s) => s.trim()).filter(Boolean) : value))
  @IsArray()
  @ArrayUnique()
  @ArrayMaxSize(FEEDBACK_ROLLUP_DIMENSIONS.length)
  @IsIn(FEEDBACK_ROLLUP_DIMENSIONS, { each: true })
  groupBy?: FeedbackRollupDimension[];

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  agentSlug?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  modelName?: string;
}

@ApiBearerAuth()
@ApiTags('admin-consultations')
@ForbidApiKey()
@RequiredSvcScopes('svc:admin:consultation-admin:manage')
@Controller('admin/feedback')
export class AdminFeedbackRollupController {
  constructor(@Inject(IFeedbackRollupReaderToken) private readonly reader: IFeedbackRollupReader) {}

  @Get('rollups')
  @CanRead('Consultation')
  @ApiOperation({
    summary: 'Feedback rollups by day, agent version, model, prompt version, section, entity label, reason or target kind',
    description: 'Counts of up / down / cleared ratings, comments, corrections and reasoned ratings. Dimensions and counts only; no content. Scoped to the caller tenant.',
  })
  @ApiResponse({ status: 200, type: FeedbackRollupResponse })
  @ApiResponse({ status: 400, description: 'Unknown groupBy dimension or malformed date.' })
  @ApiResponse({ status: 403, description: 'API keys cannot reach administration routes.' })
  async rollups(@Query() query: FeedbackRollupQuery): Promise<FeedbackRollupResponse> {
    return this.reader.query({
      from: query.from,
      to: query.to,
      groupBy: query.groupBy ?? [],
      agentSlug: query.agentSlug,
      modelName: query.modelName,
    });
  }
}
