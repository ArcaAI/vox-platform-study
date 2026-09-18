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
 * TASK-985 (QW-8) — `AiModel._metadata.asr.decoding.{partial,final}` on the wire.
 *
 * A strict SUBSET of {@link AsrProfileDecodingRequest}: only the knobs a decoder reads per
 * call may be narrowed per pass. `conditionOnPrevTokens`, `noRepeatNgramSize`,
 * `prevTextContextWords`, `compressionRatioThreshold`, `hotwords` and `hotwordsInPrompt` are
 * session- or engine-level policy, so narrowing them per pass would promise something no
 * decoder can deliver.
 *
 * Ranges are the SAME table the flat block uses — one engine field, one accepted range.
 */
export class AsrProfileDecodingPassRequest {
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
    description: 'Average token log-probability floor below which a decode is treated as failed.',
    minimum: DECODING.logprobThreshold.min,
    maximum: DECODING.logprobThreshold.max,
  })
  @IsOptional()
  @IsNumber()
  @Min(DECODING.logprobThreshold.min)
  @Max(DECODING.logprobThreshold.max)
  logprobThreshold?: number;

  @ApiPropertyOptional({
    description: 'whisper.cpp `entropy_thold`. NOT `compressionRatioThreshold` under another name.',
    minimum: DECODING.entropyThreshold.min,
    maximum: DECODING.entropyThreshold.max,
  })
  @IsOptional()
  @IsNumber()
  @Min(DECODING.entropyThreshold.min)
  @Max(DECODING.entropyThreshold.max)
  entropyThreshold?: number;

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

  @ApiPropertyOptional({ description: 'whisper.cpp `single_segment`.' })
  @IsOptional()
  @IsBoolean()
  singleSegment?: boolean;

  @ApiPropertyOptional({ description: 'whisper.cpp `suppress_blank`.' })
  @IsOptional()
  @IsBoolean()
  suppressBlank?: boolean;

  @ApiPropertyOptional({ description: 'whisper.cpp `suppress_nst`.' })
  @IsOptional()
  @IsBoolean()
  suppressNonSpeechTokens?: boolean;

  @ApiPropertyOptional({ description: 'whisper.cpp `max_tokens`. `0` = no limit.', minimum: DECODING.maxTokens.min, maximum: DECODING.maxTokens.max })
  @IsOptional()
  @IsInt()
  @Min(DECODING.maxTokens.min)
  @Max(DECODING.maxTokens.max)
  maxTokens?: number;

  @ApiPropertyOptional({ description: 'whisper.cpp `audio_ctx`. `0` = the full trained 1500.', minimum: DECODING.audioCtx.min, maximum: DECODING.audioCtx.max })
  @IsOptional()
  @IsInt()
  @Min(DECODING.audioCtx.min)
  @Max(DECODING.audioCtx.max)
  audioCtx?: number;
}

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

  /**
   * TASK-985 (M-35 / owner decision OD-E) — the governed WRITE PATH for the TASK-946 OD-1
   * switch, which until now had none at EITHER tier.
   *
   * The resolver read it from two places; both were unwritable. The agent's `decoding` block is
   * `additionalProperties: false` and declares no such key, so a draft carrying it fails publish
   * validation; and this DTO had no field, so `PATCH admin/ai-models/:id` with it was a 400 under
   * `forbidNonWhitelisted` — not a silent drop, an outright refusal. The only way to flip it was
   * a direct database write, which is why the measurement arm that needs it was unrunnable.
   *
   * OD-E settles the tier count at ONE, and this is it: whether a fine-tune tolerates a
   * vocabulary prompt is a fact about the weights, not an agent-wide truth.
   */
  @ApiPropertyOptional({
    description:
      'May this model\u2019s engine append `hotwords` to its decoder prompt? whisper.cpp has no hotword API, so the prompt is the only bias channel — and on the seeded ml-en fine-tune that append measured 2 % Latin output against 100 % without it. Leave unset for the engine default (OFF on whisper.cpp). The terms still reach the lexicon correction stage either way.',
  })
  @IsOptional()
  @IsBoolean()
  hotwordsInPrompt?: boolean;

  /**
   * TASK-985 (QW-9) — whisper.cpp's own degenerate-decode gate.
   *
   * Deliberately NOT an alias of {@link compressionRatioThreshold}: they share the default 2.4
   * and pywhispercpp's schema calls one "similar to" the other, but a gzip ratio rejects text
   * ABOVE the threshold and a token entropy rejects a distribution BELOW it. Aliasing would
   * silently mean the opposite thing.
   */
  @ApiPropertyOptional({
    description:
      'whisper.cpp `entropy_thold`: token-distribution entropy BELOW which a decode is treated as degenerate. NOT the same quantity as `compressionRatioThreshold` (opposite direction, different scale).',
    minimum: DECODING.entropyThreshold.min,
    maximum: DECODING.entropyThreshold.max,
  })
  @IsOptional()
  @IsNumber()
  @Min(DECODING.entropyThreshold.min)
  @Max(DECODING.entropyThreshold.max)
  entropyThreshold?: number;

  @ApiPropertyOptional({ description: 'whisper.cpp `single_segment`: force one segment out of one decode.' })
  @IsOptional()
  @IsBoolean()
  singleSegment?: boolean;

  @ApiPropertyOptional({ description: 'whisper.cpp `suppress_blank`. Engine default true.' })
  @IsOptional()
  @IsBoolean()
  suppressBlank?: boolean;

  @ApiPropertyOptional({ description: 'whisper.cpp `suppress_nst`: drop `[music]`/`(laughter)`-class emissions. Engine default false.' })
  @IsOptional()
  @IsBoolean()
  suppressNonSpeechTokens?: boolean;

  @ApiPropertyOptional({
    description: 'whisper.cpp `max_tokens`: bound a runaway repetition loop at the decoder. `0` = no limit.',
    minimum: DECODING.maxTokens.min,
    maximum: DECODING.maxTokens.max,
  })
  @IsOptional()
  @IsInt()
  @Min(DECODING.maxTokens.min)
  @Max(DECODING.maxTokens.max)
  maxTokens?: number;

  @ApiPropertyOptional({
    description:
      'whisper.cpp `audio_ctx`: encoder context frames. `0` = the full trained 1500, which is what upstream\u2019s streaming example ships; truncating below the trained context is a documented cause of endless repetition.',
    minimum: DECODING.audioCtx.min,
    maximum: DECODING.audioCtx.max,
  })
  @IsOptional()
  @IsInt()
  @Min(DECODING.audioCtx.min)
  @Max(DECODING.audioCtx.max)
  audioCtx?: number;

  /**
   * TASK-985 (QW-8) — per-pass narrowing of the knobs above.
   *
   * Precedence, stated once: pass block \u2192 the flat members above \u2192 the engine default.
   */
  @ApiPropertyOptional({ description: 'Decode overrides for the PARTIAL pass (the in-flight re-decode).', type: AsrProfileDecodingPassRequest })
  @IsOptional()
  @ValidateNested()
  @Type(() => AsrProfileDecodingPassRequest)
  partial?: AsrProfileDecodingPassRequest;

  @ApiPropertyOptional({ description: 'Decode overrides for the FINAL (committing) pass.', type: AsrProfileDecodingPassRequest })
  @IsOptional()
  @ValidateNested()
  @Type(() => AsrProfileDecodingPassRequest)
  final?: AsrProfileDecodingPassRequest;
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
