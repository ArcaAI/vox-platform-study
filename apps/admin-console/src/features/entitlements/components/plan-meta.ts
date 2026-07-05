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
        plan.storageQuotaBytes === null || plan.storageQuotaBytes === undefined
            ? 'Unlimited storage'
            : `${formatBytes(plan.storageQuotaBytes)} storage`;
    return `${users} \u00b7 ${minutes} \u00b7 ${storage}`;
}

export interface LimitField {
    key: 'maxUsers' | 'maxDepartments' | 'maxPromptTemplates' | 'maxAsrPipelines' | 'maxApiKeys' | 'storageQuotaBytes' | 'maxConcurrentSessions' | 'monthlyConsultations' | 'monthlyTranscriptionMinutes' | 'monthlySummaries';
    label: string;
}

export const LIMIT_FIELDS: LimitField[] = [
    { key: 'maxUsers', label: 'Max users' },
    { key: 'maxDepartments', label: 'Max departments' },
    { key: 'maxPromptTemplates', label: 'Max prompt templates' },
    { key: 'maxAsrPipelines', label: 'Max ASR pipelines' },
    { key: 'maxApiKeys', label: 'Max API keys' },
    { key: 'maxConcurrentSessions', label: 'Max concurrent sessions' },
    { key: 'monthlyConsultations', label: 'Monthly consultations' },
    { key: 'monthlyTranscriptionMinutes', label: 'Monthly transcription minutes' },
    { key: 'monthlySummaries', label: 'Monthly summaries' },
    { key: 'storageQuotaBytes', label: 'Storage quota (bytes)' },
];

export interface FeatureField {
    key: 'featureDnaReports' | 'featureVoiceEnrollment' | 'featureMonitoringAccess';
    label: string;
}

export const FEATURE_FIELDS: FeatureField[] = [
    { key: 'featureDnaReports', label: 'DNA reports' },
    { key: 'featureVoiceEnrollment', label: 'Voice enrollment' },
    { key: 'featureMonitoringAccess', label: 'Monitoring access' },
];
