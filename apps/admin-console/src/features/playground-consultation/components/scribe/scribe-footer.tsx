'use client';

/**
 * Scribe workspace footer (TASK-543): the transcription-Listener (ASR
 * pipeline) and note-assistant model selectors, plus real per-session metric
 * cards. Metrics are REAL or an em-dash — throughput/latency come from the
 * live-summary SSE stats (`useLiveMetrics`); bandwidth stays em-dash until the
 * SDK uplink-bitrate signal lands (TASK-543 SDK follow-up), never fabricated.
 *
 * Naming (TASK-547 Family 2 clinician vocabulary): the ASR pipeline is the
 * "Listener" capability — never labeled an "agent" on this clinician-facing
 * surface.
 */

import { ModelSelector, type ModelOption } from '@arcaai/ui/components/custom/model-selector';
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
  noteModels: ModelOption[];
  selectedNoteId: string;
  onNoteChange: (id: string) => void;
  metrics: ScribeMetrics;
}

export function ScribeFooter({
  transcriptionModels,
  selectedTranscriptionId,
  onTranscriptionChange,
  transcriptionLoading,
  noteModels,
  selectedNoteId,
  onNoteChange,
  metrics,
}: ScribeFooterProps) {
  return (
    <footer className="bg-card flex shrink-0 flex-wrap items-stretch gap-3 border-t p-3">
      <div className="bg-background min-w-52 flex-1 rounded-lg border p-2.5">
        <ModelSelector
          label="Transcription Listener"
          models={transcriptionModels}
          selectedModelId={selectedTranscriptionId}
          onChange={onTranscriptionChange}
          isLoading={transcriptionLoading}
        />
      </div>
      <div className="bg-background min-w-52 flex-1 rounded-lg border p-2.5">
        <ModelSelector label="Note assistant" models={noteModels} selectedModelId={selectedNoteId} onChange={onNoteChange} />
      </div>
      <div className="grid flex-[2] grid-cols-1 gap-3 sm:grid-cols-3">
        <StatCard label="Throughput" value={formatThroughput(metrics.tokensPerSecond)} accent="success" hint="note model" density="compact" />
        <StatCard label="Bandwidth" value={formatBandwidth(metrics.uplinkBitsPerSecond)} accent="default" hint="audio uplink" density="compact" />
        <StatCard label="Latency p95" value={formatLatency(metrics.latencyP95Ms)} accent="ai" hint="this session" density="compact" />
      </div>
    </footer>
  );
}
