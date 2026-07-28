'use client';

import { Fragment } from 'react';
import { normalizeGenerationStats, type NormalizedGenerationStats } from '@/features/ai-operations-metrics/api/normalize-generation-stats';
import type { GenerationStats } from '../api';

/** Known GenerationStats keys rendered as a compact key/value grid (rest ignored). */
const STAT_ROWS: {
  key: keyof NormalizedGenerationStats;
  label: string;
  format: (value: unknown) => string;
}[] = [
  { key: 'ttftMs', label: 'TTFT', format: (v) => `${Math.round(Number(v))} ms` },
  { key: 'tokensPerSecond', label: 'tok/s', format: (v) => Number(v).toFixed(1) },
  { key: 'totalMs', label: 'total', format: (v) => `${Math.round(Number(v))} ms` },
  { key: 'promptTokens', label: 'prompt tok', format: (v) => String(v) },
  { key: 'completionTokens', label: 'completion tok', format: (v) => String(v) },
  { key: 'stopReason', label: 'stop reason', format: (v) => String(v) },
  { key: 'model', label: 'model', format: (v) => String(v) },
];

/** AD-1 GenerationStats grid on an LLM_CALL step; renders only the keys present. */
export function StepStats({ stats }: { stats: GenerationStats }) {
  const normalized = normalizeGenerationStats(stats);
  const rows = STAT_ROWS.filter((row) => normalized && normalized[row.key] !== undefined && normalized[row.key] !== null);
  if (!normalized || rows.length === 0) {
    return <pre className="bg-muted/40 mt-1 overflow-x-auto rounded-md border p-2 font-mono text-[11px]">{JSON.stringify(stats, null, 2)}</pre>;
  }
  return (
    <dl className="bg-muted/30 mt-1 grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-0.5 rounded-md border p-2">
      {rows.map((row) => (
        <Fragment key={String(row.key)}>
          <dt className="text-muted-foreground font-mono text-[11px]">{row.label}</dt>
          <dd className="font-mono text-[11px] tabular-nums">{row.format(normalized[row.key])}</dd>
        </Fragment>
      ))}
    </dl>
  );
}
