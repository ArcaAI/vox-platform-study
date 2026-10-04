import type { TenantPlan } from '@/features/tenants/api/types';
import { formatBytes, formatNumber } from '@/shared/format';
import type { PlanEntitlement } from '../api/types';

export const PLAN_LABELS: Record<TenantPlan, string> = {
  ENTERPRISE: 'Enterprise',
  PRO: 'Pro',
  TRIAL: 'Trial',
  STARTER: 'Starter',
};

export const PLAN_VALUES: TenantPlan[] = ['STARTER', 'PRO', 'ENTERPRISE', 'TRIAL'];

/** Numeric limit display — the wire contract treats null/undefined as unlimited. */
export function formatLimit(value: number | null | undefined): string {
  return value === null || value === undefined ? 'Unlimited' : formatNumber(value);
}

/** Key entitlements one-liner for the plans table (real fields only). */
export function planSummary(plan: PlanEntitlement): string {
  const users = plan.maxUsers === null || plan.maxUsers === undefined ? 'Unlimited users' : `${formatNumber(plan.maxUsers)} users`;
  const minutes =
    plan.monthlyTranscriptionMinutes === null || plan.monthlyTranscriptionMinutes === undefined
      ? 'Unlimited STT min/mo'
      : `${formatNumber(plan.monthlyTranscriptionMinutes)} STT min/mo`;
  const storage =
    plan.storageQuotaBytes === null || plan.storageQuotaBytes === undefined ? 'Unlimited storage' : `${formatBytes(plan.storageQuotaBytes)} storage`;
  return `${users} \u00b7 ${minutes} \u00b7 ${storage}`;
}

export interface LimitField {
  key:
    | 'maxUsers'
    | 'maxDepartments'
    | 'maxPromptTemplates'
    | 'maxApiKeys'
    | 'maxWorkflowDefinitions'
    | 'maxAiProviderConnections'
    | 'storageQuotaBytes'
    | 'maxConcurrentSessions'
    | 'monthlyConsultations'
    | 'monthlyTranscriptionMinutes'
    | 'monthlySummaries'
    | 'monthlyWorkflowInvocations'
    | 'monthlySttSessionSeconds'
    | 'monthlyLlmTokens'
    | 'monthlyTtsCharacters'
    | 'monthlyNlpTextUnits'
    | 'monthlyEmbeddingTokens';
  label: string;
  group: LimitGroupId;
}

/**
 * Which half of the plan form a limit belongs to. NOT a display choice: the
 * gateway already draws this line. `MeterCapabilityKey`
 * (`packages/applications/src/services/entitlements/enforcement.ts`) names
 * exactly the nine rolling-monthly meters — over-limit there is a 429 against
 * a window that resets — and every other limit is a point-in-time quantity,
 * where over-limit is a 409 against a count that does not. It is the same
 * division the tenant card renders as "Quantities" and "Meters (this period)".
 */
export type LimitGroupId = 'quantity' | 'meter';

export const LIMIT_FIELDS: LimitField[] = [
  { key: 'maxUsers', label: 'Max users', group: 'quantity' },
  { key: 'maxDepartments', label: 'Max departments', group: 'quantity' },
  { key: 'maxPromptTemplates', label: 'Max Hope Prompts', group: 'quantity' },
  { key: 'maxApiKeys', label: 'Max API keys', group: 'quantity' },
  { key: 'maxWorkflowDefinitions', label: 'Max published workflow definitions', group: 'quantity' },
  { key: 'maxAiProviderConnections', label: 'Max AI provider connections', group: 'quantity' },
  { key: 'maxConcurrentSessions', label: 'Max concurrent sessions', group: 'quantity' },
  { key: 'monthlyConsultations', label: 'Monthly consultations', group: 'meter' },
  { key: 'monthlyTranscriptionMinutes', label: 'Monthly transcription minutes', group: 'meter' },
  { key: 'monthlySummaries', label: 'Monthly summaries', group: 'meter' },
  { key: 'monthlyWorkflowInvocations', label: 'Monthly workflow invocations', group: 'meter' },
  { key: 'monthlySttSessionSeconds', label: 'Monthly STT session seconds', group: 'meter' },
  { key: 'monthlyLlmTokens', label: 'Monthly LLM tokens', group: 'meter' },
  { key: 'monthlyTtsCharacters', label: 'Monthly TTS characters', group: 'meter' },
  { key: 'monthlyNlpTextUnits', label: 'Monthly NLP text units', group: 'meter' },
  { key: 'monthlyEmbeddingTokens', label: 'Monthly embedding tokens', group: 'meter' },
  { key: 'storageQuotaBytes', label: 'Storage quota (bytes)', group: 'quantity' },
];

/**
 * TASK-998 OD-4 — the per-provider cloud-ASR capacity field.
 *
 * Deliberately OUTSIDE {@link LIMIT_FIELDS}: every entry there is a scalar the
 * plan form renders as a numeric input and sends as `number | null`, while this
 * is a `{ provider: { requestsPerMinute, maxConcurrentStreams } }` map. It gets
 * its own JSON section in the plan dialog and rides the tenant panel's existing
 * override document.
 *
 * The provider list is NOT restated here. It lives in `CLOUD_BYO_PROVIDERS.stt`
 * on the gateway, which validates every key on write (unknown id ⇒ 400) — a copy
 * in the console would go stale the moment a provider is added and would then
 * refuse a number the platform can actually use.
 */
export const PROVIDER_QUOTA_FIELD = {
  label: 'Cloud ASR capacity (per provider)',
  help:
    'Per-provider vendor capacity, as JSON keyed by provider id. `requestsPerMinute` bounds BATCH transcription (the vendor\u2019s sync-REST cap); ' +
    '`maxConcurrentStreams` bounds LIVE sessions (its concurrent-WebSocket cap). Omit a provider or a dimension to state no opinion \u2014 ' +
    'unresolved at both the plan and tenant tiers means unlimited.',
} as const;

/** One-line render of a plan's platform-default capacity, for the plans table. */
export function providerQuotaSummary(quotas: PlanEntitlement['sttProviderQuotas']): string {
  const entries = Object.entries(quotas ?? {});
  if (entries.length === 0) return 'No cloud ASR capacity limit';
  return entries
    .map(([provider, quota]) => {
      const rpm = quota?.requestsPerMinute == null ? '\u2014' : formatNumber(quota.requestsPerMinute);
      const streams = quota?.maxConcurrentStreams == null ? '\u2014' : formatNumber(quota.maxConcurrentStreams);
      return `${provider} ${rpm}/min \u00b7 ${streams} streams`;
    })
    .join(' \u00b7 ');
}

/**
 * The form's sections, derived from `LIMIT_FIELDS` rather than listed again —
 * a new limit is classified once, on the field, and cannot go missing from the
 * form or appear in two places. The cloud-ASR capacity map is NOT one of them —
 * see {@link PROVIDER_QUOTA_FIELD}; the plan dialog renders it as its own JSON
 * section.
 */
export const LIMIT_GROUPS: { id: LimitGroupId; title: string; fields: LimitField[] }[] = [
  { id: 'quantity', title: 'Quantity ceilings', fields: LIMIT_FIELDS.filter((field) => field.group === 'quantity') },
  { id: 'meter', title: 'Monthly meters', fields: LIMIT_FIELDS.filter((field) => field.group === 'meter') },
];
