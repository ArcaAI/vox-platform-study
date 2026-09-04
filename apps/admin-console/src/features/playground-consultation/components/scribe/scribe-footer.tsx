'use client';

/**
 * Scribe workspace footer: the transcription-agent (published ASR
 * Agent) and note-assistant model selectors, plus real per-session metric
 * cards. Metrics are REAL or an em-dash — throughput/latency come from the
 * live-summary SSE stats (`useLiveMetrics`); bandwidth stays em-dash until the
 * SDK uplink-bitrate signal lands (SDK follow-up), never fabricated.
 *
 * Naming — the Family 2 rollout called the ASR pipeline the "Listener"
 * capability and forbade the word "agent" here. That is reversed: the platform
 * ships a single-task TRANSCRIPTION AGENT (a published `Agent` of task
 * `SPEECH_TO_TEXT`, TASK-863), and this screen offers a second, different
 * choice next to it — the consultation WORKFLOW, picked at session-open. The
 * two selectors read as agent vs workflow. The old parenthesised suffix named
 * the pipeline substrate the agent used to compile to; that substrate retires
 * with TASK-861, so the label is just the agent. `naming.test.ts` locks it.
 */

import { ModelSelector, type ModelOption } from '@arcaai/ui/components/custom/model-selector';
import { SttLanguageModePicker, type SttLanguageModeOption } from '@arcaai/ui/components/custom/stt-language-mode-picker';
import { Label } from '@arcaai/ui/components/shadcn/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@arcaai/ui/components/shadcn/select';
import { StatCard } from '@arcaai/ui/components/metrics/stat-card';

export interface ScribeMetrics {
  tokensPerSecond: number | null;
  latencyP95Ms: number | null;
  /** Uplink bitrate (bits/sec); null until the SDK signal ships. */
  uplinkBitsPerSecond: number | null;
}

function formatThroughput(value: number | null): string | null {
  return value == null ? null : `${Math.round(value)} tok/s`;
}

function formatLatency(value: number | null): string | null {
  return value == null ? null : `${Math.round(value)} ms`;
}

function formatBandwidth(value: number | null): string | null {
  if (value == null) return null;
  return `${(value / 1_000_000).toFixed(1)} Mbps`;
}

export interface ScribeFooterProps {
  transcriptionModels: ModelOption[];
  selectedTranscriptionId: string;
  onTranscriptionChange: (id: string) => void;
  transcriptionLoading: boolean;
  /** Selectable STT language modes. */
  languageModes: SttLanguageModeOption[];
  selectedLanguageMode: string;
  onLanguageModeChange: (id: string) => void;
  languageModesLoading: boolean;
  noteModels: ModelOption[];
  selectedNoteId: string;
  onNoteChange: (id: string) => void;
  /**
   * W2 — DNA writing styles selectable for the next generation
   * (`GenerateSummaryRequest.dnaStyleId`). Empty ⇒ the control is hidden.
   * The server still gates it: `resolveEffectiveDnaStyleId` drops the id
   * unless DNA is effective for this tenant/department/doctor.
   */
  dnaStyles?: DnaStyleOption[];
  selectedDnaStyleId?: string;
  onDnaStyleChange?: (id: string) => void;
  metrics: ScribeMetrics;
}

/** A selectable DNA writing-style report. */
export interface DnaStyleOption {
  id: string;
  label: string;
}

/** Sentinel for "no style" — Radix Select forbids an empty-string value. */
const NO_DNA_STYLE = '__none__';

export function ScribeFooter({
  transcriptionModels,
  selectedTranscriptionId,
  onTranscriptionChange,
  transcriptionLoading,
  languageModes,
  selectedLanguageMode,
  onLanguageModeChange,
  languageModesLoading,
  noteModels,
  selectedNoteId,
  onNoteChange,
  dnaStyles = [],
  selectedDnaStyleId = '',
  onDnaStyleChange,
  metrics,
}: ScribeFooterProps) {
  return (
    <footer className="bg-card flex shrink-0 flex-wrap items-stretch gap-3 border-t p-3">
      <div className="bg-background min-w-52 flex-1 rounded-lg border p-2.5">
        <ModelSelector
          label="Transcription agent"
          models={transcriptionModels}
          selectedModelId={selectedTranscriptionId}
          onChange={onTranscriptionChange}
          isLoading={transcriptionLoading}
        />
      </div>
      <div className="bg-background min-w-44 flex-1 rounded-lg border p-2.5">
        <SttLanguageModePicker
          modes={languageModes}
          value={selectedLanguageMode || undefined}
          onValueChange={onLanguageModeChange}
          isLoading={languageModesLoading}
        />
      </div>
      <div className="bg-background min-w-52 flex-1 rounded-lg border p-2.5">
        <ModelSelector label="Note assistant" models={noteModels} selectedModelId={selectedNoteId} onChange={onNoteChange} />
      </div>
      {dnaStyles.length > 0 ? (
        <div className="bg-background flex min-w-52 flex-1 flex-col gap-1.5 rounded-lg border p-2.5">
          <Label htmlFor="scribe-dna-style" className="text-xs">
            Writing style
          </Label>
          <Select
            value={selectedDnaStyleId || NO_DNA_STYLE}
            onValueChange={(next) => onDnaStyleChange?.(next === NO_DNA_STYLE ? '' : next)}
          >
            <SelectTrigger id="scribe-dna-style" size="sm" className="w-full">
              <SelectValue placeholder="Default style" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={NO_DNA_STYLE}>Default style</SelectItem>
              {dnaStyles.map((style) => (
                <SelectItem key={style.id} value={style.id}>
                  {style.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      ) : null}
      <div className="grid flex-[2] grid-cols-1 gap-3 sm:grid-cols-3">
        <StatCard label="Throughput" value={formatThroughput(metrics.tokensPerSecond)} accent="success" hint="note model" density="compact" />
        <StatCard label="Bandwidth" value={formatBandwidth(metrics.uplinkBitsPerSecond)} accent="default" hint="audio uplink" density="compact" />
        <StatCard label="Latency p95" value={formatLatency(metrics.latencyP95Ms)} accent="ai" hint="this session" density="compact" />
      </div>
    </footer>
  );
}
