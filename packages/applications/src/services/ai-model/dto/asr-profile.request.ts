import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsInt,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';
import {
  AI_MODEL_ASR_PROFILE_DECODING_RANGES,
  AI_MODEL_ASR_PROFILE_HOTWORDS_MAX_ITEMS,
  AI_MODEL_ASR_PROFILE_INITIAL_PROMPT_MAX_LENGTH,
  AI_MODEL_ASR_PROFILE_WINDOW_RANGES,
} from '@arcaai/types';

const DECODING = AI_MODEL_ASR_PROFILE_DECODING_RANGES;
const WINDOW = AI_MODEL_ASR_PROFILE_WINDOW_RANGES;

/**
 * `AiModel._metadata.asr.decoding` on the wire (TASK-934 R-3/G-1).
 *
 * Ranges are IMPORTED from `AI_MODEL_ASR_PROFILE_DECODING_RANGES` (`@arcaai/types`)
 * rather than retyped — the same table `parseAiModelAsrProfile` validates against at
 * read time (defensively; an out-of-range stored value is dropped, not rejected) and
 * `SPEECH_TO_TEXT_PARAMETERS.decoding` (`@arcaai/workflow-contract`) mirrors at the
 * agent level. Three places reading one engine field must accept exactly the same
 * values, so the table is the only place the range is spelled out. This DTO is the
 * ADMIN WRITE boundary and is strict (fail closed on an out-of-range value, unlike the
 * lenient runtime parser) — an admin gets a 400 naming the field, not a silently
 * dropped edit.
 */
export class AsrProfileDecodingRequest {
  @ApiPropertyOptional({ description: 'Beam width.', minimum: DECODING.beamSize.min, maximum: DECODING.beamSize.max })
  @IsOptional()
  @IsInt()
  @Min(DECODING.beamSize.min)
  @Max(DECODING.beamSize.max)
  beamSize?: number;

  @ApiPropertyOptional({ description: 'Sampling temperature.', minimum: DECODING.temperature.min, maximum: DECODING.temperature.max })
  @IsOptional()
  @IsNumber()
  @Min(DECODING.temperature.min)
  @Max(DECODING.temperature.max)
  temperature?: number;

  @ApiPropertyOptional({
    description: 'Above this no-speech probability a decoded segment is discarded.',
    minimum: DECODING.noSpeechThreshold.min,
    maximum: DECODING.noSpeechThreshold.max,
  })
  @IsOptional()
  @IsNumber()
  @Min(DECODING.noSpeechThreshold.min)
  @Max(DECODING.noSpeechThreshold.max)
  noSpeechThreshold?: number;

  @ApiPropertyOptional({
    description: 'Gzip compression ratio above which a decode is treated as looping and retried at a higher temperature.',
    minimum: DECODING.compressionRatioThreshold.min,
    maximum: DECODING.compressionRatioThreshold.max,
  })
  @IsOptional()
  @IsNumber()
  @Min(DECODING.compressionRatioThreshold.min)
  @Max(DECODING.compressionRatioThreshold.max)
  compressionRatioThreshold?: number;

  @ApiPropertyOptional({
    description: 'Average token log-probability floor below which a decode is retried.',
    minimum: DECODING.logprobThreshold.min,
    maximum: DECODING.logprobThreshold.max,
  })
  @IsOptional()
  @IsNumber()
  @Min(DECODING.logprobThreshold.min)
  @Max(DECODING.logprobThreshold.max)
  logprobThreshold?: number;

  @ApiPropertyOptional({ description: "Feed the previous window's tokens to the decoder as context." })
  @IsOptional()
  @IsBoolean()
  conditionOnPrevTokens?: boolean;

  @ApiPropertyOptional({
    description: 'Block repeats of an n-gram this long within one decode (0 disables).',
    minimum: DECODING.noRepeatNgramSize.min,
    maximum: DECODING.noRepeatNgramSize.max,
  })
  @IsOptional()
  @IsInt()
  @Min(DECODING.noRepeatNgramSize.min)
  @Max(DECODING.noRepeatNgramSize.max)
  noRepeatNgramSize?: number;

  @ApiPropertyOptional({
    description: 'How many words of already-committed text ride as decoder context on the next window.',
    minimum: DECODING.prevTextContextWords.min,
    maximum: DECODING.prevTextContextWords.max,
  })
  @IsOptional()
  @IsInt()
  @Min(DECODING.prevTextContextWords.min)
  @Max(DECODING.prevTextContextWords.max)
  prevTextContextWords?: number;

  @ApiPropertyOptional({
    description: `Terms biased into the decode (max ${AI_MODEL_ASR_PROFILE_HOTWORDS_MAX_ITEMS}, each non-empty).`,
    type: [String],
  })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(AI_MODEL_ASR_PROFILE_HOTWORDS_MAX_ITEMS)
  @IsString({ each: true })
  @IsNotEmpty({ each: true })
  hotwords?: string[];
}

/**
 * `AiModel._metadata.asr` on the wire — the decode profile a registered fine-tune
 * carries (TASK-934 R-3/G-1). `PATCH admin/ai-models/:id` accepts `null` here to CLEAR
 * the stored profile without disturbing any other `_metadata` key; `undefined`
 * (the field simply absent from the body) leaves the stored profile untouched.
 */
export class AsrProfileRequest {
  @ApiPropertyOptional({
    description: 'Longest audio fed to the engine in ONE decode, seconds.',
    minimum: WINDOW.maxDecodeWindowSec.min,
    maximum: WINDOW.maxDecodeWindowSec.max,
  })
  @IsOptional()
  @IsNumber()
  @Min(WINDOW.maxDecodeWindowSec.min)
  @Max(WINDOW.maxDecodeWindowSec.max)
  maxDecodeWindowSec?: number;

  @ApiPropertyOptional({
    description: 'Tail window of the live utterance decoded for PARTIALs, seconds.',
    minimum: WINDOW.partialWindowSec.min,
    maximum: WINDOW.partialWindowSec.max,
  })
  @IsOptional()
  @IsNumber()
  @Min(WINDOW.partialWindowSec.min)
  @Max(WINDOW.partialWindowSec.max)
  partialWindowSec?: number;

  @ApiPropertyOptional({ description: 'Recommended decode knobs for this fine-tune.', type: AsrProfileDecodingRequest })
  @IsOptional()
  @ValidateNested()
  @Type(() => AsrProfileDecodingRequest)
  decoding?: AsrProfileDecodingRequest;

  @ApiPropertyOptional({
    description: 'The priming prompt this fine-tune was measured with (OD-11) — a per-model property, not an agent-wide truth.',
    maxLength: AI_MODEL_ASR_PROFILE_INITIAL_PROMPT_MAX_LENGTH,
  })
  @IsOptional()
  @IsString()
  @MaxLength(AI_MODEL_ASR_PROFILE_INITIAL_PROMPT_MAX_LENGTH)
  initialPrompt?: string;
}
