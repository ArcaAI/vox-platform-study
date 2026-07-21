/**
 * Wire types for the read-only AI-services plane.
 *
 * ⚠ UPSTREAM-OWNED SHAPES. `GuardrailStatus`, `NlpStatus` and both halves of
 * `GuardrailConfig` are the guardrail/NLP Python services' own health/config
 * documents, proxied through the gateway VERBATIM
 * (`apps/api/src/modules/ai-service-admin/ai-service-proxy.client.ts`). The
 * console does NOT own, version, or validate them — they are typed as open
 * records on purpose, and the panels render them defensively (badge what is
 * recognizable, key/value the rest). Never add a zod schema or a fixed
 * interface here: an upstream field rename must degrade the panel, not crash
 * the screen.
 *
 * `AgenticInstructions` is the one shape we DO own — it mirrors
 * `AgenticInstructionsResponse` in @arcaai/applications field-for-field (the
 * console cannot import that server package).
 */

/** Upstream guardrail `GET /api/health`, proxied verbatim. Shape not ours. */
export type GuardrailStatus = Record<string, unknown>;

/** Upstream NLP `GET /api/v1/health`, proxied verbatim. Shape not ours. */
export type NlpStatus = Record<string, unknown>;

/** `GuardrailConfigResult` — two upstream documents joined by the gateway. */
export interface GuardrailConfig {
    /** Guardian engine settings (provider, model, thresholds). Upstream-owned. */
    medicalValidation: Record<string, unknown>;
    /** Supported analysis types with descriptions. Upstream-owned. */
    analysisTypes: Record<string, unknown>;
}

/** Where the effective harness policy behind the instruction set resolved from. */
export type HarnessPolicySource = 'tenant' | 'system-default' | 'code-default';

/** The prompt tier resolution picked (preferred → department → default). */
export interface ResolvedPromptTier {
    template: string;
    promptId: string;
    resolvedFrom: 'preferred' | 'department' | 'default';
    departmentId: string | null;
    promptType: string;
}

/** The vendored PDSQI-9 judge-prompt pin — version/hash only, non-editable. */
export interface JudgePromptPin {
    instrument: string;
    version: string;
    promptHash: string;
    source: string;
    license: string;
    paperDoi: string;
    rubricDimensions: string[];
    editable: boolean;
}

/** The five clinical-loop sensor thresholds from the effective policy. */
export interface SensorThresholds {
    entityFaithfulnessThreshold: number;
    coverageThreshold: number;
    citationPresenceThreshold: number;
    numericDoseThreshold: number;
    groundednessThreshold: number;
}

/** One safety criterion the loop enforces (derived from the effective policy). */
export interface SafetyCriterion {
    key: string;
    label: string;
    enabled: boolean;
    detail: string | null;
}

/** GET /admin/agentic/instructions — the effective instruction set for a tenant. */
export interface AgenticInstructions {
    tenantId: string;
    policySource: HarnessPolicySource;
    promptTier: ResolvedPromptTier;
    judgePrompt: JudgePromptPin;
    sensorThresholds: SensorThresholds;
    safetyCriteria: SafetyCriterion[];
}

/** Query params for the instruction-set read (all optional). */
export interface AgenticInstructionsParams {
    /** Global admins target a tenant; tenant admins are pinned server-side. */
    tenantId?: string;
    /** Resolve the prompt tier against a department (omit = tenant baseline). */
    departmentId?: string;
    promptType?: 'pre-summary' | 'new-patient' | 'revisit';
}
