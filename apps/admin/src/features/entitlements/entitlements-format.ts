/**
 * TASK-392 Phase 5 — pure presentation helpers for the entitlements console.
 *
 * All display logic (usage %, near-limit tone, byte/count formatting, trial
 * countdown) lives here so it is unit-testable without rendering. The
 * `nearLimit`/`exceeded`/`unlimited` flags are computed server-side (the source
 * of truth); the FE only maps them to labels + colors.
 */

import type { CapabilityUsageRow, TrialInfo } from '@arcaai/vox';

/** Human labels for the capability keys emitted by the snapshot (proposal §2). */
const CAPABILITY_LABELS: Record<string, string> = {
  users: 'Users / seats',
  departments: 'Departments',
  promptTemplates: 'Prompt templates',
  asrPipelines: 'ASR pipelines',
  apiKeys: 'API keys',
  storageBytes: 'Storage',
  concurrentSessions: 'Concurrent sessions',
  monthlyConsultations: 'Consultations / mo',
  monthlyTranscriptionMinutes: 'Transcription min / mo',
  monthlySummaries: 'Summaries / mo',
};

export function capabilityLabel(key: string): string {
  return CAPABILITY_LABELS[key] ?? key;
}

/** Storage rows render as bytes; everything else as plain integer counts. */
export function isByteCapability(key: string): boolean {
  return key === 'storageBytes' || /bytes|storage/i.test(key);
}

/** Compact byte size (`∞` when unlimited/null). */
export function formatBytes(bytes?: number | null): string {
  if (bytes == null) return '∞';
  if (bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
  const i = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
  const val = bytes / 1024 ** i;
  // Whole values render without a trailing ".0" (1 KB, not 1.0 KB); fractional
  // values keep one decimal (1.5 MB).
  const rounded = Number(val.toFixed(i === 0 ? 0 : 1));
  return `${rounded} ${units[i]}`;
}

/** Localized integer count (`∞` when unlimited/null). */
export function formatCount(n?: number | null): string {
  if (n == null) return '∞';
  return new Intl.NumberFormat().format(n);
}

/** Format one metric honoring byte-vs-count semantics for its key. */
export function formatCapabilityValue(key: string, value?: number | null): string {
  return isByteCapability(key) ? formatBytes(value) : formatCount(value);
}

/** "12 / 50", "12 / ∞", "— / 50" (used is `—` when not yet metered). */
export function usageLabel(row: CapabilityUsageRow): string {
  const used = row.used == null ? '—' : formatCapabilityValue(row.key, row.used);
  const limit = row.unlimited ? '∞' : formatCapabilityValue(row.key, row.limit);
  return `${used} / ${limit}`;
}

/** 0–100 fill percentage; `null` when unlimited or usage not metered. */
export function usagePercent(row: CapabilityUsageRow): number | null {
  if (row.unlimited || row.limit == null || row.limit <= 0 || row.used == null) return null;
  return Math.min(100, Math.round((row.used / row.limit) * 100));
}

export type UsageTone = 'exceeded' | 'near' | 'ok' | 'unlimited' | 'unmetered';

export function usageTone(row: CapabilityUsageRow): UsageTone {
  if (row.unlimited) return 'unlimited';
  if (row.used == null) return 'unmetered';
  if (row.exceeded) return 'exceeded';
  if (row.nearLimit) return 'near';
  return 'ok';
}

/** Maps a row to a `StatusColorRole`-compatible tone for badges/bars. */
export function usageColorRole(row: CapabilityUsageRow): 'destructive' | 'warning' | 'success' | 'neutral' {
  switch (usageTone(row)) {
    case 'exceeded':
      return 'destructive';
    case 'near':
      return 'warning';
    case 'ok':
      return 'success';
    default:
      return 'neutral';
  }
}

// ── Trial clock (Q4) ─────────────────────────────────────────────────────────

export type TrialTone = 'expired' | 'urgent' | 'info' | 'none';

export function trialTone(trial: TrialInfo): TrialTone {
  if (!trial.isTrial) return 'none';
  if (trial.expired) return 'expired';
  return (trial.daysRemaining ?? 99) <= 3 ? 'urgent' : 'info';
}

/** Short countdown/expiry copy for the trial banner. */
export function trialCountdownText(trial: TrialInfo): string {
  if (!trial.isTrial) return '';
  if (trial.expired) return 'Trial expired — pending downgrade to Starter';
  const d = trial.daysRemaining;
  if (d == null) return 'On trial';
  if (d <= 0) return 'Trial ends today';
  return `${d} day${d === 1 ? '' : 's'} left on trial`;
}

// ── Blocked-action UX (server maps quota blocks to 409/429/413/403) ──────────

/** Pull an HTTP status off an error (top-level or nested `AgenticError.context`). */
function statusOf(error: unknown): number | undefined {
  if (!error || typeof error !== 'object') return undefined;
  const top = error as { status?: unknown; statusCode?: unknown; context?: unknown };
  if (typeof top.status === 'number') return top.status;
  if (typeof top.statusCode === 'number') return top.statusCode;
  const ctx = top.context;
  if (ctx && typeof ctx === 'object') {
    const c = ctx as { status?: unknown; statusCode?: unknown };
    if (typeof c.status === 'number') return c.status;
    if (typeof c.statusCode === 'number') return c.statusCode;
  }
  return undefined;
}

/**
 * Map an enforcement block to friendly, actionable copy for a toast. Mirrors the
 * server's `ExceptionInterceptor` mapping: 409 quantity / 429 meter / 413
 * storage / 403 feature. Returns `undefined` for non-quota errors so callers can
 * fall through to their generic error handling.
 */
export function quotaErrorMessage(error: unknown): string | undefined {
  switch (statusOf(error)) {
    case 409:
      return "You've reached a plan limit for this resource. Upgrade the plan or request a higher limit.";
    case 429:
      return "You've hit this month's usage limit. It resets next cycle — or upgrade the plan for a higher cap.";
    case 413:
      return 'Storage quota exceeded. Free up space or upgrade the plan for more storage.';
    case 403:
      return "This capability isn't available on the current plan.";
    default:
      return undefined;
  }
}
