'use client';

/**
 * Scribe workspace footer: the STT language-mode picker plus real per-session
 * metric cards. Metrics are REAL or an em-dash — throughput/latency come from
 * the live-summary SSE stats (`useLiveMetrics`); bandwidth stays em-dash until
 * the SDK uplink-bitrate signal lands (SDK follow-up), never fabricated.
 *
 * TASK-891 OD-5 — the Transcription agent, Note assistant and Writing style
 * dropdowns are REMOVED. The consultation WORKFLOW (picked at session-open,
 * `consultations-column.tsx`) is now the single selector: it names the ASR
 * agent, the partial/finalize summarization agents, and the DNA writing-style
 * redaction agent, so a second, competing choice here was redundant and
 * unused. See `docs/implementation/TASK-891-Realtime-Consultation-Scribe-Fixes/README.md`
 * §3 OD-5. `naming.test.ts` locks that the retired labels never come back.
 */

import { SttLanguageModePicker, type SttLanguageModeOption } from '@arcaai/ui/components/custom/stt-language-mode-picker';
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
  /** Selectable STT language modes. */
  languageModes: SttLanguageModeOption[];
  selectedLanguageMode: string;
  onLanguageModeChange: (id: string) => void;
  languageModesLoading: boolean;
  metrics: ScribeMetrics;
}

/**
 * TASK-891 A6/OD-1 — sentinel for "no language declared". The default STAYS
 * empty (OD-1: code-switch is always on unless a language is declared), but
 * an empty `value` renders `SttLanguageModePicker`'s bare "Select a language"
 * placeholder, which reads as a missing choice rather than the deliberate
 * default it is. Radix `Select` also forbids an empty-string item value (the
 * same reason `NO_DEPARTMENT`/`ASSIGNED_WORKFLOW` sentinels exist in
 * `consultations-column.tsx`). So this option is prepended locally and always
 * shown selected when nothing is declared, translating back to `''` on
 * change — no English default is introduced, and nothing is preselected.
 */
const AUTO_LANGUAGE = '__auto__';

const AUTO_LANGUAGE_OPTION: SttLanguageModeOption = {
  id: AUTO_LANGUAGE,
  label: 'Auto (code-switch)',
  kind: 'auto',
};

export function ScribeFooter({ languageModes, selectedLanguageMode, onLanguageModeChange, languageModesLoading, metrics }: ScribeFooterProps) {
  return (
    <footer className="bg-card flex shrink-0 flex-wrap items-stretch gap-3 border-t p-3">
      <div className="bg-background min-w-52 flex-1 rounded-lg border p-2.5">
        <SttLanguageModePicker
          modes={[AUTO_LANGUAGE_OPTION, ...languageModes]}
          value={selectedLanguageMode || AUTO_LANGUAGE}
          onValueChange={(next) => onLanguageModeChange(next === AUTO_LANGUAGE ? '' : next)}
          isLoading={languageModesLoading}
        />
        <p className="text-muted-foreground mt-1.5 text-xs">
          Auto keeps the session on the agent&apos;s own code-switch mode; pick a language to declare one explicitly.
        </p>
      </div>
      <div className="grid flex-[2] grid-cols-1 gap-3 sm:grid-cols-3">
        <StatCard label="Throughput" value={formatThroughput(metrics.tokensPerSecond)} accent="success" hint="note model" density="compact" />
        <StatCard label="Bandwidth" value={formatBandwidth(metrics.uplinkBitsPerSecond)} accent="default" hint="audio uplink" density="compact" />
        <StatCard label="Latency p95" value={formatLatency(metrics.latencyP95Ms)} accent="ai" hint="this session" density="compact" />
      </div>
    </footer>
  );
}
