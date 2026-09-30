'use client';

import { Input } from '@arcaai/ui/components/shadcn/input';
import { Label } from '@arcaai/ui/components/shadcn/label';
import { Switch } from '@arcaai/ui/components/shadcn/switch';
import { Textarea } from '@arcaai/ui/components/shadcn/textarea';
import {
  AI_MODEL_ASR_PROFILE_DECODING_RANGES,
  AI_MODEL_ASR_PROFILE_HOTWORDS_MAX_ITEMS,
  AI_MODEL_ASR_PROFILE_INITIAL_PROMPT_MAX_LENGTH,
  AI_MODEL_ASR_PROFILE_WINDOW_RANGES,
  type AiModelAsrProfile,
  type AiModelAsrProfileDecoding,
} from '../api/types';
import { Field } from './register-parts';

/**
 * The ASR decode profile (`AiModel._metadata.asr`, TASK-934) as form strings. Every field is optional and
 * blank-clearable; a blank profile is sent as `null` (the PATCH semantics for "clear it").
 */
export interface AsrValues {
  maxDecodeWindowSec: string;
  partialWindowSec: string;
  beamSize: string;
  temperature: string;
  noSpeechThreshold: string;
  compressionRatioThreshold: string;
  logprobThreshold: string;
  conditionOnPrevTokens: boolean;
  noRepeatNgramSize: string;
  prevTextContextWords: string;
  hotwords: string;
  hotwordsInPrompt: boolean;
  initialPrompt: string;
}

function numOrEmpty(value: number | undefined): string {
  return value != null ? String(value) : '';
}

function splitList(value: string): string[] {
  return value
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

export function asrValuesFromProfile(profile: AiModelAsrProfile | null | undefined): AsrValues {
  return {
    maxDecodeWindowSec: numOrEmpty(profile?.maxDecodeWindowSec),
    partialWindowSec: numOrEmpty(profile?.partialWindowSec),
    beamSize: numOrEmpty(profile?.decoding?.beamSize),
    temperature: numOrEmpty(profile?.decoding?.temperature),
    noSpeechThreshold: numOrEmpty(profile?.decoding?.noSpeechThreshold),
    compressionRatioThreshold: numOrEmpty(profile?.decoding?.compressionRatioThreshold),
    logprobThreshold: numOrEmpty(profile?.decoding?.logprobThreshold),
    conditionOnPrevTokens: profile?.decoding?.conditionOnPrevTokens ?? false,
    noRepeatNgramSize: numOrEmpty(profile?.decoding?.noRepeatNgramSize),
    prevTextContextWords: numOrEmpty(profile?.decoding?.prevTextContextWords),
    hotwords: profile?.decoding?.hotwords?.join(', ') ?? '',
    hotwordsInPrompt: profile?.decoding?.hotwordsInPrompt ?? false,
    initialPrompt: profile?.initialPrompt ?? '',
  };
}

/** `decoding`, built from the fields. `undefined` when every one is blank, so the profile omits an empty object. */
function toDecoding(values: AsrValues): AiModelAsrProfileDecoding | undefined {
  const decoding: AiModelAsrProfileDecoding = {};
  if (values.beamSize.trim()) decoding.beamSize = Number(values.beamSize);
  if (values.temperature.trim()) decoding.temperature = Number(values.temperature);
  if (values.noSpeechThreshold.trim()) decoding.noSpeechThreshold = Number(values.noSpeechThreshold);
  if (values.compressionRatioThreshold.trim()) decoding.compressionRatioThreshold = Number(values.compressionRatioThreshold);
  if (values.logprobThreshold.trim()) decoding.logprobThreshold = Number(values.logprobThreshold);
  if (values.conditionOnPrevTokens) decoding.conditionOnPrevTokens = true;
  if (values.noRepeatNgramSize.trim()) decoding.noRepeatNgramSize = Number(values.noRepeatNgramSize);
  if (values.prevTextContextWords.trim()) decoding.prevTextContextWords = Number(values.prevTextContextWords);
  if (values.hotwords.trim()) decoding.hotwords = splitList(values.hotwords);
  // Omitted when off (absence = the engine default, which for whisper.cpp is off), so the profile stays free of members nobody set.
  if (values.hotwordsInPrompt) decoding.hotwordsInPrompt = true;
  return Object.keys(decoding).length > 0 ? decoding : undefined;
}

/** The whole `asrProfile`. `null` when every field is blank — the PATCH semantics for "clear it". */
export function toAsrProfileRequest(values: AsrValues): AiModelAsrProfile | null {
  const profile: AiModelAsrProfile = {};
  if (values.maxDecodeWindowSec.trim()) profile.maxDecodeWindowSec = Number(values.maxDecodeWindowSec);
  if (values.partialWindowSec.trim()) profile.partialWindowSec = Number(values.partialWindowSec);
  const decoding = toDecoding(values);
  if (decoding) profile.decoding = decoding;
  if (values.initialPrompt.trim()) profile.initialPrompt = values.initialPrompt.trim();
  return Object.keys(profile).length > 0 ? profile : null;
}

/** `true` when a non-blank value falls outside `range` (or isn't a whole number for an integer range). */
export function isOutOfRange(value: string, range: { min: number; max: number; integer?: boolean }): boolean {
  if (!value.trim()) return false;
  const num = Number(value);
  if (Number.isNaN(num)) return true;
  if (range.integer && !Number.isInteger(num)) return true;
  return num < range.min || num > range.max;
}

export function hasAsrValidationError(values: AsrValues): boolean {
  const { maxDecodeWindowSec, partialWindowSec } = AI_MODEL_ASR_PROFILE_WINDOW_RANGES;
  const r = AI_MODEL_ASR_PROFILE_DECODING_RANGES;
  return (
    isOutOfRange(values.maxDecodeWindowSec, maxDecodeWindowSec) ||
    isOutOfRange(values.partialWindowSec, partialWindowSec) ||
    isOutOfRange(values.beamSize, r.beamSize) ||
    isOutOfRange(values.temperature, r.temperature) ||
    isOutOfRange(values.noSpeechThreshold, r.noSpeechThreshold) ||
    isOutOfRange(values.compressionRatioThreshold, r.compressionRatioThreshold) ||
    isOutOfRange(values.logprobThreshold, r.logprobThreshold) ||
    isOutOfRange(values.noRepeatNgramSize, r.noRepeatNgramSize) ||
    isOutOfRange(values.prevTextContextWords, r.prevTextContextWords)
  );
}

/**
 * A numeric field with min/max from the SAME range table the gateway DTO validates against, and the out-of-range
 * error rendered BELOW the field (rule 11 §9) rather than only discovered on submit.
 */
function RangedNumberField({
  id,
  label,
  value,
  onChange,
  range,
  placeholder,
}: {
  id: string;
  label: string;
  value: string;
  onChange: (value: string) => void;
  range: { min: number; max: number; integer?: boolean };
  placeholder?: string;
}) {
  const invalid = isOutOfRange(value, range);
  return (
    <Field id={id} label={label}>
      <Input
        id={id}
        type="number"
        min={range.min}
        max={range.max}
        step={range.integer ? 1 : 'any'}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder={placeholder}
        aria-invalid={invalid || undefined}
        aria-describedby={invalid ? `${id}-error` : undefined}
      />
      {invalid ? (
        <p id={`${id}-error`} className="text-destructive text-sm">
          Must be between {range.min} and {range.max}
          {range.integer ? ' (whole number)' : ''}.
        </p>
      ) : null}
    </Field>
  );
}

/**
 * The model-level ASR defaults: decode geometry and thresholds that travel with the weights. Resolved
 * agent → this profile → engine default; a value an agent sets always wins.
 */
export function AsrDefaultsFields({ uid, values, onChange }: { uid: string; values: AsrValues; onChange: <K extends keyof AsrValues>(key: K, value: AsrValues[K]) => void }) {
  const win = AI_MODEL_ASR_PROFILE_WINDOW_RANGES;
  const dec = AI_MODEL_ASR_PROFILE_DECODING_RANGES;
  return (
    <div className="flex flex-col gap-4">
      <p className="text-muted-foreground text-xs">
        Model-level defaults for this ASR model (TASK-934): they travel with the weights, not with whichever agent binds them. Tenants tune these per Agent, and a
        value an agent sets always wins over the ones here.
      </p>
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <RangedNumberField id={`${uid}-asr-max-decode-window`} label="Max decode window (s)" value={values.maxDecodeWindowSec} onChange={(v) => onChange('maxDecodeWindowSec', v)} range={win.maxDecodeWindowSec} placeholder="7" />
        <RangedNumberField id={`${uid}-asr-partial-window`} label="Partial window (s)" value={values.partialWindowSec} onChange={(v) => onChange('partialWindowSec', v)} range={win.partialWindowSec} placeholder="15" />
        <RangedNumberField id={`${uid}-asr-beam-size`} label="Beam size" value={values.beamSize} onChange={(v) => onChange('beamSize', v)} range={dec.beamSize} />
        <RangedNumberField id={`${uid}-asr-temperature`} label="Temperature" value={values.temperature} onChange={(v) => onChange('temperature', v)} range={dec.temperature} />
        <RangedNumberField id={`${uid}-asr-no-speech-threshold`} label="No-speech threshold" value={values.noSpeechThreshold} onChange={(v) => onChange('noSpeechThreshold', v)} range={dec.noSpeechThreshold} />
        <RangedNumberField id={`${uid}-asr-compression-ratio-threshold`} label="Compression ratio threshold" value={values.compressionRatioThreshold} onChange={(v) => onChange('compressionRatioThreshold', v)} range={dec.compressionRatioThreshold} />
        <RangedNumberField id={`${uid}-asr-logprob-threshold`} label="Logprob threshold" value={values.logprobThreshold} onChange={(v) => onChange('logprobThreshold', v)} range={dec.logprobThreshold} />
        <RangedNumberField id={`${uid}-asr-no-repeat-ngram-size`} label="No-repeat n-gram size" value={values.noRepeatNgramSize} onChange={(v) => onChange('noRepeatNgramSize', v)} range={dec.noRepeatNgramSize} />
        <RangedNumberField id={`${uid}-asr-prev-text-context-words`} label="Previous-text context words" value={values.prevTextContextWords} onChange={(v) => onChange('prevTextContextWords', v)} range={dec.prevTextContextWords} />
      </div>
      <div className="flex items-center justify-between gap-3 rounded-md border px-3 py-2">
        <div className="flex flex-col">
          <Label htmlFor={`${uid}-asr-condition-on-prev-tokens`}>Condition on previous tokens</Label>
          <span className="text-muted-foreground text-xs">Feed the previous window&apos;s tokens to the decoder as context.</span>
        </div>
        <Switch id={`${uid}-asr-condition-on-prev-tokens`} checked={values.conditionOnPrevTokens} onCheckedChange={(checked) => onChange('conditionOnPrevTokens', checked)} />
      </div>
      <Field id={`${uid}-asr-hotwords`} label={`Hotwords (comma-separated, max ${AI_MODEL_ASR_PROFILE_HOTWORDS_MAX_ITEMS})`}>
        <Input id={`${uid}-asr-hotwords`} value={values.hotwords} onChange={(event) => onChange('hotwords', event.target.value)} placeholder="sephotrioxone, imoxicillin" />
      </Field>
      <div className="flex items-center justify-between gap-3 rounded-md border px-3 py-2">
        <div className="flex flex-col">
          <Label htmlFor={`${uid}-asr-hotwords-in-prompt`}>Append hotwords to the decoder prompt</Label>
          <span className="text-muted-foreground text-xs">
            whisper.cpp has no hotword API, so the prompt is its only bias channel — and on the seeded ml-en code-switch fine-tune that append measured 2% Latin
            output against 100% without it. Leave off unless this model was measured with it. The terms still reach the clinical-vocabulary correction stage
            either way.
          </span>
        </div>
        <Switch id={`${uid}-asr-hotwords-in-prompt`} checked={values.hotwordsInPrompt} onCheckedChange={(checked) => onChange('hotwordsInPrompt', checked)} />
      </div>
      <Field id={`${uid}-asr-initial-prompt`} label="Initial prompt">
        <Textarea
          id={`${uid}-asr-initial-prompt`}
          value={values.initialPrompt}
          onChange={(event) => onChange('initialPrompt', event.target.value)}
          rows={2}
          maxLength={AI_MODEL_ASR_PROFILE_INITIAL_PROMPT_MAX_LENGTH}
          placeholder="Clinical consultation between a clinician and a patient. English and Malayalam medical terminology."
        />
      </Field>
    </div>
  );
}
