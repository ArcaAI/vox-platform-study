import type { StatusColorRole } from '@arcaai/ui/components/shared';
import type { DnaReportData } from '@arcaai/vox';
import { format } from 'date-fns';

/**
 * TASK-408 — pure presentation logic for the Playground tier (screens 50–59).
 * Status is always presented dot+label (never color-only), counts/latency use
 * `tabular-nums` at the call sites, ids render `font-mono`.
 */

/** Consultation lifecycle status → semantic color role (SDK `ConsultationStatus`). */
export function consultationStatusRole(status?: string): StatusColorRole {
  switch ((status ?? '').toUpperCase()) {
    case 'CLOSED':
    case 'COMPLETED':
      return 'success';
    case 'OPEN':
    case 'RECORDING':
    case 'TRANSCRIBING':
    case 'SUMMARIZING':
    case 'ACTIVE':
      return 'info';
    case 'REVIEW':
      return 'warning';
    case 'CANCELLED':
      return 'destructive';
    default:
      return 'neutral';
  }
}

/** Minimal consultation shape the label needs (works for both SDK consultation types). */
export interface ConsultationLabelInput {
  id: string;
  status?: string;
  appointmentDate?: string;
  createdAt?: string;
  patientId?: string;
}

function safeFormatDate(value: string): string {
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? value : format(d, 'd MMM yyyy');
}

/** Compact one-line option label: `#abcdef12  ·  patient PAT-42  ·  OPEN  ·  1 Jul 2026`. */
export function consultationOptionLabel(c: ConsultationLabelInput): string {
  const when = c.appointmentDate ?? c.createdAt;
  const parts = [`#${c.id.slice(0, 8)}`, c.patientId ? `patient ${c.patientId.slice(0, 6)}` : null, c.status, when ? safeFormatDate(when) : null];
  return parts.filter(Boolean).join('  ·  ');
}

/**
 * Doctor-identity gate for the sandbox "Start consultation" affordance.
 * `POST /consultations` creates doctor-owned records, so the legacy playground
 * blocks plain admins (they must impersonate a doctor first — TASK-401 swaps
 * the whole session, so the current roles already reflect the impersonation).
 */
const SANDBOX_CONSULTATION_ROLES = ['DOCTOR', 'SPECIALIST'];

export function canStartSandboxConsultation(roles?: string[] | null): boolean {
  return !!roles && roles.some((r) => SANDBOX_CONSULTATION_ROLES.includes(r));
}

export interface VoiceProfileStateBadge {
  label: 'Active' | 'Inactive';
  colorRole: StatusColorRole;
}

/** Voice profile activation state (dot+label). */
export function voiceProfileState(profile: { isActive?: boolean }): VoiceProfileStateBadge {
  return profile.isActive === true ? { label: 'Active', colorRole: 'success' } : { label: 'Inactive', colorRole: 'neutral' };
}

export interface DnaAttributeEntry {
  label: string;
  value: string;
}

/**
 * Known DNA style attributes in display order (only rendered when present).
 * Keyed by raw field name: covers the typed `DnaReportData` fields plus `tone`,
 * which the generator emits but the SDK type doesn't model yet.
 */
const DNA_ATTRIBUTE_LABELS: ReadonlyArray<[key: string, label: string]> = [
  ['tone', 'Tone'],
  ['formality', 'Formality'],
  ['sentenceLength', 'Sentence length'],
  ['medicalTermUsage', 'Medical terms'],
  ['abbreviationStyle', 'Abbreviation style'],
  ['avgSentenceLength', 'Avg sentence length'],
  ['vocabularyComplexity', 'Vocabulary complexity'],
  ['formalityLevel', 'Formality level'],
];

/** Extract the report's style attributes as human-labelled chips. */
export function dnaAttributeEntries(reportData?: DnaReportData): DnaAttributeEntry[] {
  if (!reportData) return [];
  const bag = reportData as Record<string, unknown>;
  const entries: DnaAttributeEntry[] = [];
  for (const [key, label] of DNA_ATTRIBUTE_LABELS) {
    const value = bag[key];
    if (typeof value === 'string' && value.trim() !== '') {
      entries.push({ label, value });
    } else if (typeof value === 'number' && Number.isFinite(value)) {
      entries.push({ label, value: String(value) });
    }
  }
  return entries;
}

/** SMR processing time: ms below a second, one-decimal seconds above. */
export function formatProcessingTime(ms?: number): string {
  if (ms === undefined || !Number.isFinite(ms)) return '—';
  if (ms < 1000) return `${ms} ms`;
  return `${(ms / 1000).toFixed(1)} s`;
}

/**
 * Summary-ish context item types (API `ContextItemType`). The admin
 * consultation GET embeds generated summaries as context items of these types
 * — the playground splits them out into the Summaries rail.
 */
const SUMMARY_CONTEXT_TYPES = new Set(['RAW_SUMMARY', 'MODIFIED_SUMMARY', 'PRE_SUMMARY']);

export function isSummaryContextType(type?: string): boolean {
  return !!type && SUMMARY_CONTEXT_TYPES.has(type.toUpperCase());
}

/** Context item type → compact display label (`RAW_SUMMARY` → `Summary`). */
export function contextTypeLabel(type?: string): string {
  switch ((type ?? '').toUpperCase()) {
    case 'RAW_SUMMARY':
      return 'Summary';
    case 'MODIFIED_SUMMARY':
      return 'Modified summary';
    case 'PRE_SUMMARY':
      return 'Pre-summary';
    case '':
      return 'unknown';
    default:
      return (type ?? '').toLowerCase().replace(/_/g, ' ');
  }
}

/**
 * Context item as the ADMIN consultation GET returns it (wire
 * `ContextItemResponse`). The SDK's `AdminConsultation` models relations via
 * its index signature only, so the playground types the slice it renders.
 */
export interface PlaygroundContextItem {
  id: string;
  type?: string;
  content?: string;
  isAiGenerated?: boolean;
  createdAt?: string;
  /** Present on summary-type items — generation metadata. */
  summaryMeta?: {
    aiModelId?: string;
    aiModelVersion?: string;
    processingTimeMs?: number;
    totalTokens?: number;
  } | null;
  [key: string]: unknown;
}

export interface SplitContext {
  /** Non-summary items (notes, transcripts, attachments…), original order. */
  items: PlaygroundContextItem[];
  /** Summary-type items (RAW/MODIFIED/PRE_SUMMARY), original order. */
  summaries: PlaygroundContextItem[];
}

/** Split a consultation's context items into content vs generated summaries. */
export function splitPlaygroundContext(items?: PlaygroundContextItem[] | null): SplitContext {
  const result: SplitContext = { items: [], summaries: [] };
  for (const item of items ?? []) {
    (isSummaryContextType(item.type) ? result.summaries : result.items).push(item);
  }
  return result;
}

/** DNA generate input: split a textarea into text samples on blank lines. */
export function splitTextSamples(raw: string): string[] {
  return raw
    .split(/\n\s*\n/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}
