/* eslint-disable @typescript-eslint/no-explicit-any */
import type React from 'react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { parse, stringify } from 'yaml';

import { Badge } from '@arcaai/ui/badge';
import { Button } from '@arcaai/ui/button';
import { Input } from '@arcaai/ui/input';
import { Label } from '@arcaai/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@arcaai/ui/select';
import { Separator } from '@arcaai/ui/separator';
import { Switch } from '@arcaai/ui/switch';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@arcaai/ui/tabs';
import { Textarea } from '@arcaai/ui/textarea';
import { Code, SlidersHorizontal } from 'lucide-react';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface PipelineConfig {
  version: string;
  models: {
    asr: { hf_model_id: string; engine: string };
    vad: { hf_model_id: string; engine: string; version: string };
    denoise: { hf_model_id: string; engine: string };
  };
  preprocessing: {
    target_sample_rate: number;
    normalize: boolean;
    vad: {
      enabled: boolean;
      threshold: number;
      min_speech_duration_ms: number;
      min_silence_duration_ms: number;
    };
    denoise: {
      enabled: boolean;
      strength: number;
    };
    dual_capture: {
      enabled: boolean;
      capture_raw: boolean;
    };
  };
  inference: {
    batch_size: number;
    compute_type: string;
    device: string;
    language: string | null;
  };
  postprocessing: {
    timestamps: {
      word_timestamps: boolean;
      sentence_timestamps: boolean;
    };
    punctuation: {
      enabled: boolean;
    };
    remove_disfluencies: boolean;
    lowercase: boolean;
    dual_capture: {
      enabled: boolean;
      capture_processed: boolean;
    };
  };
  // TASK-356 Phase 4 — speaker diarization (already read by the STT-v2 yaml_parser;
  // surfaced here in the structured form). A subset of the parser's fields.
  diarization: {
    enabled: boolean;
    max_speakers: number;
    high_threshold: number;
    low_threshold: number;
  };
}

interface PipelineConfigEditorProps {
  value: string;
  onChange?: (yaml: string) => void;
  error?: string;
  rows?: number;
  readOnly?: boolean;
}

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

export const DEFAULT_CONFIG: PipelineConfig = {
  version: '1.1',
  models: {
    asr: { hf_model_id: 'openai/whisper-large-v3-turbo', engine: 'safetensor' },
    vad: { hf_model_id: 'snakers4/silero-vad', engine: 'onnx', version: 'v6.0' },
    denoise: { hf_model_id: 'nickolay/rnnoise', engine: 'onnx' },
  },
  preprocessing: {
    target_sample_rate: 16000,
    normalize: true,
    vad: { enabled: true, threshold: 0.5, min_speech_duration_ms: 250, min_silence_duration_ms: 1000 },
    denoise: { enabled: true, strength: 0.7 },
    dual_capture: { enabled: false, capture_raw: false },
  },
  inference: { batch_size: 1, compute_type: 'auto', device: 'auto', language: null },
  postprocessing: {
    timestamps: { word_timestamps: true, sentence_timestamps: true },
    punctuation: { enabled: true },
    remove_disfluencies: false,
    lowercase: false,
    dual_capture: { enabled: false, capture_processed: false },
  },
  diarization: { enabled: false, max_speakers: 2, high_threshold: 0.7, low_threshold: 0.4 },
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

export function tryParseYaml(yaml: string): PipelineConfig | null {
  try {
    const parsed = parse(yaml);
    if (!parsed || typeof parsed !== 'object') return null;
    const normalized = normalizeLegacyModelRefs(parsed);
    return deepMerge(DEFAULT_CONFIG, normalized) as PipelineConfig;
  } catch {
    return null;
  }
}

function normalizeLegacyModelRefs(parsed: any): any {
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return parsed;
  }

  const root = { ...parsed };
  const models = root.models;

  if (!models || typeof models !== 'object' || Array.isArray(models)) {
    return root;
  }

  const normalizedModels = { ...models };
  const modelKeys: Array<'asr' | 'vad' | 'denoise'> = ['asr', 'vad', 'denoise'];

  modelKeys.forEach((modelKey) => {
    const value = normalizedModels[modelKey];
    if (typeof value === 'string') {
      normalizedModels[modelKey] = {
        ...DEFAULT_CONFIG.models[modelKey],
        hf_model_id: value,
      };
    }
  });

  return {
    ...root,
    models: normalizedModels,
  };
}

function deepMerge(target: any, source: any): any {
  const result = { ...target };
  for (const key of Object.keys(target)) {
    if (key in source) {
      if (
        typeof target[key] === 'object' &&
        target[key] !== null &&
        !Array.isArray(target[key]) &&
        typeof source[key] === 'object' &&
        source[key] !== null
      ) {
        result[key] = deepMerge(target[key], source[key]);
      } else {
        result[key] = source[key];
      }
    }
  }
  // Preserve any extra keys from source
  for (const key of Object.keys(source)) {
    if (!(key in target)) {
      result[key] = source[key];
    }
  }
  return result;
}

export function configToYaml(config: PipelineConfig): string {
  return stringify(config, { lineWidth: 0, nullStr: 'null' });
}

function setNestedValue(obj: any, path: string[], value: any): any {
  if (path.length === 0) return value;
  const [head, ...rest] = path;

  const safeObject = obj && typeof obj === 'object' && !Array.isArray(obj) ? obj : {};

  return {
    ...safeObject,
    [head!]: rest.length === 0 ? value : setNestedValue(safeObject[head!], rest, value),
  };
}

// ---------------------------------------------------------------------------
// Section components
// ---------------------------------------------------------------------------

function SectionHeader({ title, description }: { title: string; description?: string }) {
  return (
    <div className="mb-3">
      <h4 className="text-sm font-semibold">{title}</h4>
      {description && <p className="text-muted-foreground text-xs">{description}</p>}
    </div>
  );
}

function FieldRow({ children, label, htmlFor }: { children: React.ReactNode; label: string; htmlFor?: string }) {
  return (
    <div className="grid grid-cols-1 gap-2 md:grid-cols-[120px_1fr] md:items-center md:gap-3">
      <Label htmlFor={htmlFor} className="text-muted-foreground text-xs">
        {label}
      </Label>
      <div>{children}</div>
    </div>
  );
}

function ToggleRow({
  label,
  checked,
  onCheckedChange,
  id,
  disabled,
}: {
  label: string;
  checked: boolean;
  onCheckedChange: (v: boolean) => void;
  id: string;
  disabled?: boolean;
}) {
  return (
    <div className="grid grid-cols-1 gap-2 md:grid-cols-[120px_1fr] md:items-center md:gap-3">
      <Label htmlFor={id} className="text-muted-foreground text-xs">
        {label}
      </Label>
      <div>
        <Switch id={id} checked={checked} onCheckedChange={onCheckedChange} disabled={disabled} />
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Visual Form
// ---------------------------------------------------------------------------

function VisualForm({
  config,
  onFieldChange,
  readOnly,
}: {
  config: PipelineConfig;
  onFieldChange: (path: string[], value: any) => void;
  readOnly?: boolean;
}) {
  const onInput = (path: string[], e: React.ChangeEvent<HTMLInputElement>) => onFieldChange(path, e.target.value);
  const onNumericInput = (path: string[], e: React.ChangeEvent<HTMLInputElement>, fallback = 0) =>
    onFieldChange(path, Number(e.target.value) || fallback);

  return (
    <div className="flex flex-col gap-5">
      {/* Version */}
      <div>
        <SectionHeader title="General" />
        <FieldRow label="Config Version" htmlFor="cfg-version">
          <Input
            id="cfg-version"
            value={config.version}
            onChange={(e: React.ChangeEvent<HTMLInputElement>) => onInput(['version'], e)}
            readOnly={readOnly}
            className="h-8"
          />
        </FieldRow>
      </div>

      <Separator />

      {/* Models */}
      <div>
        <SectionHeader title="Models" description="HuggingFace model IDs and inference engines" />
        <div className="flex flex-col gap-3">
          {/* ASR */}
          <Badge variant="secondary" className="w-fit text-[10px] uppercase tracking-wide">
            ASR
          </Badge>
          <FieldRow label="Model ID" htmlFor="asr-model">
            <Input
              id="asr-model"
              value={config.models.asr.hf_model_id}
              onChange={(e: React.ChangeEvent<HTMLInputElement>) => onInput(['models', 'asr', 'hf_model_id'], e)}
              readOnly={readOnly}
              className="h-8 font-mono text-xs"
            />
          </FieldRow>
          <FieldRow label="Engine" htmlFor="asr-engine">
            <Select value={config.models.asr.engine} onValueChange={(v: string) => onFieldChange(['models', 'asr', 'engine'], v)} disabled={readOnly}>
              <SelectTrigger id="asr-engine" className="h-8">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="safetensor">safetensor</SelectItem>
                <SelectItem value="onnx">onnx</SelectItem>
                <SelectItem value="ctranslate2">ctranslate2</SelectItem>
              </SelectContent>
            </Select>
          </FieldRow>

          <Separator className="my-2" />

          {/* VAD */}
          <Badge variant="secondary" className="w-fit text-[10px] uppercase tracking-wide">
            VAD
          </Badge>
          <FieldRow label="Model ID" htmlFor="vad-model">
            <Input
              id="vad-model"
              value={config.models.vad.hf_model_id}
              onChange={(e: React.ChangeEvent<HTMLInputElement>) => onInput(['models', 'vad', 'hf_model_id'], e)}
              readOnly={readOnly}
              className="h-8 font-mono text-xs"
            />
          </FieldRow>
          <FieldRow label="Engine" htmlFor="vad-engine">
            <Select value={config.models.vad.engine} onValueChange={(v: string) => onFieldChange(['models', 'vad', 'engine'], v)} disabled={readOnly}>
              <SelectTrigger id="vad-engine" className="h-8">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="onnx">onnx</SelectItem>
                <SelectItem value="safetensor">safetensor</SelectItem>
              </SelectContent>
            </Select>
          </FieldRow>
          <FieldRow label="Version" htmlFor="vad-version">
            <Input
              id="vad-version"
              value={config.models.vad.version}
              onChange={(e: React.ChangeEvent<HTMLInputElement>) => onInput(['models', 'vad', 'version'], e)}
              readOnly={readOnly}
              className="h-8"
            />
          </FieldRow>

          <Separator className="my-2" />

          {/* Denoise */}
          <Badge variant="secondary" className="w-fit text-[10px] uppercase tracking-wide">
            Denoise
          </Badge>
          <FieldRow label="Model ID" htmlFor="denoise-model">
            <Input
              id="denoise-model"
              value={config.models.denoise.hf_model_id}
              onChange={(e: React.ChangeEvent<HTMLInputElement>) => onInput(['models', 'denoise', 'hf_model_id'], e)}
              readOnly={readOnly}
              className="h-8 font-mono text-xs"
            />
          </FieldRow>
          <FieldRow label="Engine" htmlFor="denoise-engine">
            <Select
              value={config.models.denoise.engine}
              onValueChange={(v: string) => onFieldChange(['models', 'denoise', 'engine'], v)}
              disabled={readOnly}
            >
              <SelectTrigger id="denoise-engine" className="h-8">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="onnx">onnx</SelectItem>
                <SelectItem value="safetensor">safetensor</SelectItem>
              </SelectContent>
            </Select>
          </FieldRow>
        </div>
      </div>

      <Separator />

      {/* Preprocessing */}
      <div>
        <SectionHeader title="Preprocessing" description="Audio preprocessing before inference" />
        <div className="flex flex-col gap-3">
          <FieldRow label="Sample Rate" htmlFor="pre-sample-rate">
            <Input
              id="pre-sample-rate"
              type="number"
              inputMode="numeric"
              value={config.preprocessing.target_sample_rate}
              onChange={(e: React.ChangeEvent<HTMLInputElement>) => onNumericInput(['preprocessing', 'target_sample_rate'], e, 16000)}
              readOnly={readOnly}
              className="h-8"
            />
          </FieldRow>
          <ToggleRow
            id="pre-normalize"
            label="Normalize Audio"
            checked={config.preprocessing.normalize}
            onCheckedChange={(v) => onFieldChange(['preprocessing', 'normalize'], v)}
            disabled={readOnly}
          />

          <Separator className="my-2" />

          {/* VAD preprocessing */}
          <ToggleRow
            id="pre-vad-enabled"
            label="VAD Enabled"
            checked={config.preprocessing.vad.enabled}
            onCheckedChange={(v) => onFieldChange(['preprocessing', 'vad', 'enabled'], v)}
            disabled={readOnly}
          />
          {config.preprocessing.vad.enabled && (
            <div className="border-muted flex flex-col gap-2.5 border-l-2 pl-4">
              <FieldRow label="Threshold" htmlFor="pre-vad-threshold">
                <Input
                  id="pre-vad-threshold"
                  type="number"
                  inputMode="decimal"
                  step={0.1}
                  min={0}
                  max={1}
                  value={config.preprocessing.vad.threshold}
                  onChange={(e: React.ChangeEvent<HTMLInputElement>) => onNumericInput(['preprocessing', 'vad', 'threshold'], e)}
                  readOnly={readOnly}
                  className="h-8"
                />
              </FieldRow>
              <FieldRow label="Min Speech (ms)" htmlFor="pre-vad-speech">
                <Input
                  id="pre-vad-speech"
                  type="number"
                  inputMode="numeric"
                  value={config.preprocessing.vad.min_speech_duration_ms}
                  onChange={(e: React.ChangeEvent<HTMLInputElement>) => onNumericInput(['preprocessing', 'vad', 'min_speech_duration_ms'], e)}
                  readOnly={readOnly}
                  className="h-8"
                />
              </FieldRow>
              <FieldRow label="Min Silence (ms)" htmlFor="pre-vad-silence">
                <Input
                  id="pre-vad-silence"
                  type="number"
                  inputMode="numeric"
                  value={config.preprocessing.vad.min_silence_duration_ms}
                  onChange={(e: React.ChangeEvent<HTMLInputElement>) => onNumericInput(['preprocessing', 'vad', 'min_silence_duration_ms'], e)}
                  readOnly={readOnly}
                  className="h-8"
                />
              </FieldRow>
            </div>
          )}

          <Separator className="my-2" />

          {/* Denoise preprocessing */}
          <ToggleRow
            id="pre-denoise-enabled"
            label="Denoise Enabled"
            checked={config.preprocessing.denoise.enabled}
            onCheckedChange={(v) => onFieldChange(['preprocessing', 'denoise', 'enabled'], v)}
            disabled={readOnly}
          />
          {config.preprocessing.denoise.enabled && (
            <div className="border-muted flex flex-col gap-2.5 border-l-2 pl-4">
              <FieldRow label="Strength" htmlFor="pre-denoise-strength">
                <Input
                  id="pre-denoise-strength"
                  type="number"
                  inputMode="decimal"
                  step={0.1}
                  min={0}
                  max={1}
                  value={config.preprocessing.denoise.strength}
                  onChange={(e: React.ChangeEvent<HTMLInputElement>) => onNumericInput(['preprocessing', 'denoise', 'strength'], e)}
                  readOnly={readOnly}
                  className="h-8"
                />
              </FieldRow>
            </div>
          )}

          <Separator className="my-2" />

          {/* Dual capture — raw (pre-filter) audio */}
          <ToggleRow
            id="pre-dual-capture-enabled"
            label="Dual Capture"
            checked={config.preprocessing.dual_capture.enabled}
            onCheckedChange={(v) => onFieldChange(['preprocessing', 'dual_capture', 'enabled'], v)}
            disabled={readOnly}
          />
          {config.preprocessing.dual_capture.enabled && (
            <div className="border-muted flex flex-col gap-2.5 border-l-2 pl-4">
              <ToggleRow
                id="pre-dual-capture-raw"
                label="Capture Raw"
                checked={config.preprocessing.dual_capture.capture_raw}
                onCheckedChange={(v) => onFieldChange(['preprocessing', 'dual_capture', 'capture_raw'], v)}
                disabled={readOnly}
              />
            </div>
          )}
        </div>
      </div>

      <Separator />

      {/* Inference */}
      <div>
        <SectionHeader title="Inference" description="Model inference settings" />
        <div className="flex flex-col gap-3">
          <FieldRow label="Batch Size" htmlFor="inf-batch">
            <Input
              id="inf-batch"
              type="number"
              inputMode="numeric"
              min={1}
              value={config.inference.batch_size}
              onChange={(e: React.ChangeEvent<HTMLInputElement>) => onNumericInput(['inference', 'batch_size'], e, 1)}
              readOnly={readOnly}
              className="h-8"
            />
          </FieldRow>
          <FieldRow label="Compute Type" htmlFor="inf-compute">
            <Select
              value={config.inference.compute_type}
              onValueChange={(v: string) => onFieldChange(['inference', 'compute_type'], v)}
              disabled={readOnly}
            >
              <SelectTrigger id="inf-compute" className="h-8">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="auto">auto</SelectItem>
                <SelectItem value="float16">float16</SelectItem>
                <SelectItem value="float32">float32</SelectItem>
                <SelectItem value="int8">int8</SelectItem>
              </SelectContent>
            </Select>
          </FieldRow>
          <FieldRow label="Device" htmlFor="inf-device">
            <Select value={config.inference.device} onValueChange={(v: string) => onFieldChange(['inference', 'device'], v)} disabled={readOnly}>
              <SelectTrigger id="inf-device" className="h-8">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="auto">auto</SelectItem>
                <SelectItem value="cpu">cpu</SelectItem>
                <SelectItem value="cuda">cuda</SelectItem>
                <SelectItem value="mps">mps</SelectItem>
              </SelectContent>
            </Select>
          </FieldRow>
          <FieldRow label="Language" htmlFor="inf-language">
            <Input
              id="inf-language"
              value={config.inference.language ?? ''}
              onChange={(e: React.ChangeEvent<HTMLInputElement>) => onFieldChange(['inference', 'language'], e.target.value || null)}
              readOnly={readOnly}
              placeholder="auto-detect"
              className="h-8"
            />
          </FieldRow>
        </div>
      </div>

      <Separator />

      {/* Postprocessing */}
      <div>
        <SectionHeader title="Postprocessing" description="Output formatting and cleanup" />
        <div className="flex flex-col gap-3">
          <ToggleRow
            id="post-word-ts"
            label="Word Timestamps"
            checked={config.postprocessing.timestamps.word_timestamps}
            onCheckedChange={(v) => onFieldChange(['postprocessing', 'timestamps', 'word_timestamps'], v)}
            disabled={readOnly}
          />
          <ToggleRow
            id="post-sentence-ts"
            label="Sentence Timestamps"
            checked={config.postprocessing.timestamps.sentence_timestamps}
            onCheckedChange={(v) => onFieldChange(['postprocessing', 'timestamps', 'sentence_timestamps'], v)}
            disabled={readOnly}
          />
          <ToggleRow
            id="post-punctuation"
            label="Punctuation"
            checked={config.postprocessing.punctuation.enabled}
            onCheckedChange={(v) => onFieldChange(['postprocessing', 'punctuation', 'enabled'], v)}
            disabled={readOnly}
          />
          <ToggleRow
            id="post-disfluencies"
            label="Remove Disfluencies"
            checked={config.postprocessing.remove_disfluencies}
            onCheckedChange={(v) => onFieldChange(['postprocessing', 'remove_disfluencies'], v)}
            disabled={readOnly}
          />
          <ToggleRow
            id="post-lowercase"
            label="Lowercase Output"
            checked={config.postprocessing.lowercase}
            onCheckedChange={(v) => onFieldChange(['postprocessing', 'lowercase'], v)}
            disabled={readOnly}
          />

          <Separator className="my-2" />

          {/* Dual capture — processed (post-filter) audio */}
          <ToggleRow
            id="post-dual-capture-enabled"
            label="Dual Capture"
            checked={config.postprocessing.dual_capture.enabled}
            onCheckedChange={(v) => onFieldChange(['postprocessing', 'dual_capture', 'enabled'], v)}
            disabled={readOnly}
          />
          {config.postprocessing.dual_capture.enabled && (
            <div className="border-muted flex flex-col gap-2.5 border-l-2 pl-4">
              <ToggleRow
                id="post-dual-capture-processed"
                label="Capture Processed"
                checked={config.postprocessing.dual_capture.capture_processed}
                onCheckedChange={(v) => onFieldChange(['postprocessing', 'dual_capture', 'capture_processed'], v)}
                disabled={readOnly}
              />
            </div>
          )}
        </div>
      </div>

      {/* Diarization (TASK-356 Phase 4) */}
      <div>
        <SectionHeader title="Diarization" description="Speaker separation in the transcript" />
        <div className="flex flex-col gap-3">
          <ToggleRow
            id="diar-enabled"
            label="Diarization"
            checked={config.diarization.enabled}
            onCheckedChange={(v) => onFieldChange(['diarization', 'enabled'], v)}
            disabled={readOnly}
          />
          {config.diarization.enabled && (
            <div className="border-muted flex flex-col gap-2.5 border-l-2 pl-4">
              <FieldRow label="Max Speakers" htmlFor="diar-max-speakers">
                <Input
                  id="diar-max-speakers"
                  type="number"
                  inputMode="numeric"
                  min={0}
                  value={config.diarization.max_speakers}
                  onChange={(e: React.ChangeEvent<HTMLInputElement>) => onNumericInput(['diarization', 'max_speakers'], e)}
                  readOnly={readOnly}
                  className="h-8"
                />
              </FieldRow>
              <FieldRow label="High Threshold" htmlFor="diar-high-threshold">
                <Input
                  id="diar-high-threshold"
                  type="number"
                  inputMode="decimal"
                  step={0.05}
                  min={0}
                  max={1}
                  value={config.diarization.high_threshold}
                  onChange={(e: React.ChangeEvent<HTMLInputElement>) => onNumericInput(['diarization', 'high_threshold'], e)}
                  readOnly={readOnly}
                  className="h-8"
                />
              </FieldRow>
              <FieldRow label="Low Threshold" htmlFor="diar-low-threshold">
                <Input
                  id="diar-low-threshold"
                  type="number"
                  inputMode="decimal"
                  step={0.05}
                  min={0}
                  max={1}
                  value={config.diarization.low_threshold}
                  onChange={(e: React.ChangeEvent<HTMLInputElement>) => onNumericInput(['diarization', 'low_threshold'], e)}
                  readOnly={readOnly}
                  className="h-8"
                />
              </FieldRow>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// PipelineConfigEditor
// ---------------------------------------------------------------------------

export function PipelineConfigEditor({ value, onChange, error, rows = 20, readOnly }: PipelineConfigEditorProps) {
  const [mode, setMode] = useState<'form' | 'yaml'>('form');
  const [yamlDraft, setYamlDraft] = useState(value);
  const [yamlError, setYamlError] = useState<string | null>(null);
  const lastSyncRef = useRef(value);

  // Sync external value changes into local state
  useEffect(() => {
    if (value !== lastSyncRef.current) {
      lastSyncRef.current = value;
      setYamlDraft(value);
    }
  }, [value]);

  const config = useMemo(() => tryParseYaml(yamlDraft), [yamlDraft]);

  const handleModeChange = useCallback(
    (next: string) => {
      if (next === 'yaml' && mode === 'form') {
        setMode('yaml');
      } else if (next === 'form' && mode === 'yaml') {
        const parsed = tryParseYaml(yamlDraft);
        if (!parsed) {
          setYamlError('Fix YAML errors before switching to Form view');
          return;
        }
        setYamlError(null);
        setMode('form');
      }
    },
    [mode, yamlDraft],
  );

  const handleYamlChange = useCallback(
    (raw: string) => {
      setYamlDraft(raw);
      setYamlError(null);
      lastSyncRef.current = raw;
      onChange?.(raw);
    },
    [onChange],
  );

  const handleFieldChange = useCallback(
    (path: string[], fieldValue: any) => {
      if (!config) return;
      const updated = setNestedValue(config, path, fieldValue) as PipelineConfig;
      const yaml = configToYaml(updated);
      setYamlDraft(yaml);
      lastSyncRef.current = yaml;
      onChange?.(yaml);
    },
    [config, onChange],
  );

  return (
    <div className="flex flex-col gap-2">
      <Tabs value={mode} onValueChange={handleModeChange}>
        <div className="flex items-center justify-between">
          <TabsList className="h-8" aria-label="Editor mode">
            <TabsTrigger value="form" className="gap-1.5 text-xs px-3">
              <SlidersHorizontal data-icon="inline-start" />
              Form
            </TabsTrigger>
            <TabsTrigger value="yaml" className="gap-1.5 text-xs px-3">
              <Code data-icon="inline-start" />
              YAML
            </TabsTrigger>
          </TabsList>
          {mode === 'yaml' && yamlError && !error && (
            <p className="text-destructive text-xs" aria-live="polite" role="status">
              {yamlError}
            </p>
          )}
        </div>

        <TabsContent value="form" className="mt-3">
          {config ? (
            <VisualForm config={config} onFieldChange={handleFieldChange} readOnly={readOnly} />
          ) : (
            <div className="flex flex-col gap-3">
              <p className="text-destructive text-sm" aria-live="polite" role="status">
                Unable to parse current YAML. Switch to YAML mode to fix errors.
              </p>
              <Button type="button" variant="outline" size="sm" onClick={() => setMode('yaml')}>
                Switch to YAML
              </Button>
            </div>
          )}
        </TabsContent>

        <TabsContent value="yaml" className="mt-3">
          {readOnly ? (
            <Textarea
              value={yamlDraft}
              readOnly
              className="font-mono text-xs"
              rows={rows}
              spellCheck={false}
              aria-label="Pipeline YAML configuration"
            />
          ) : (
            <Textarea
              value={yamlDraft}
              onChange={(e: React.ChangeEvent<HTMLTextAreaElement>) => handleYamlChange(e.target.value)}
              className="font-mono text-xs"
              rows={rows}
              spellCheck={false}
              autoComplete="off"
            />
          )}
        </TabsContent>
      </Tabs>

      {error && (
        <p className="text-destructive text-xs" aria-live="polite" role="status">
          {error}
        </p>
      )}
    </div>
  );
}
