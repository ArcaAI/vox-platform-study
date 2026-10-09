/**
 * Action confirmations (TASK-1057) — the catalogue of every admin action that asks its caller for a
 * reason, evidence, an acknowledgement, a typed confirmation, break-glass credentials or a password
 * step-up before a change, and the platform-only policy that decides whether each is required.
 *
 * Shared by the gateway (enforcement + audit stamp) and the admin console (dialogs + the
 * `/action-confirmations` screen). Pure data — no runtime dependencies.
 *
 * Owner decisions (2026-10-09):
 *  - switchable per DOMAIN OPERATION (one row per action), with an "apply to all" per kind on the screen;
 *  - the switch is PLATFORM-ONLY (SYSTEM tier) — there is no tenant override;
 *  - when a requirement is off, the audit event still records that it was not required;
 *  - break-glass, impersonation, password step-up and the billing reason code are LOCKED on;
 *  - typed-name confirmations stay console-only, controlled by the same setting.
 */

export const CONFIRMATION_KINDS = [
  'reason',
  'evidence',
  'acknowledgement',
  'typeToConfirm',
  'reasonCode',
  'breakGlass',
  'stepUp',
] as const;
export type ConfirmationKind = (typeof CONFIRMATION_KINDS)[number];

/**
 * `required` — always demanded. `not-required` — offered (where a field exists) but never demanded.
 * `when-risky` — demanded only when the action's own risk rule fires (model residency: a live-path or
 * pinned model, or a forced operation). Only rows that list it in `modes` may hold it.
 */
export const CONFIRMATION_MODES = ['required', 'when-risky', 'not-required'] as const;
export type ConfirmationMode = (typeof CONFIRMATION_MODES)[number];

/** Who meets the prompt — mirrors the console audience tiers. */
export type ConfirmationAudience = 'platform' | 'tenant' | 'both';

/** Where the requirement is enforced: by the gateway (400) or only by the console dialog. */
export type ConfirmationEnforcement = 'server' | 'console';

export interface ActionConfirmationSpec {
  /** Stable id, `<domain>.<operation>`; the setting key is `confirmation.<actionId>`. */
  actionId: string;
  /** Grouping label on the screen (the "domain"). */
  domain: string;
  label: string;
  kind: ConfirmationKind;
  audience: ConfirmationAudience;
  enforcement: ConfirmationEnforcement;
  /** Today's behaviour — the code default an absent SYSTEM row resolves to. */
  default: ConfirmationMode;
  /** The modes this row may hold. A locked row has exactly one. */
  modes: readonly ConfirmationMode[];
  /** Locked rows are displayed but have no setting and can never be switched off. */
  locked?: boolean;
  /** Minimum trimmed length of a free-text value when it is required. Absent = non-empty. */
  minLength?: number;
  /** Maximum length of a free-text value. */
  maxLength?: number;
  /** Gateway route(s) the action reaches — documentation for the screen and the audit trail. */
  routes: readonly string[];
}

const ON_OFF = ['required', 'not-required'] as const;
const RISKY = ['required', 'when-risky', 'not-required'] as const;
const LOCKED = ['required'] as const;

function reason(
  actionId: string,
  domain: string,
  label: string,
  audience: ConfirmationAudience,
  def: ConfirmationMode,
  routes: readonly string[],
  extra: Partial<ActionConfirmationSpec> = {},
): ActionConfirmationSpec {
  return { actionId, domain, label, kind: 'reason', audience, enforcement: 'server', default: def, modes: ON_OFF, routes, ...extra };
}

function typed(actionId: string, domain: string, label: string, audience: ConfirmationAudience): ActionConfirmationSpec {
  return { actionId, domain, label, kind: 'typeToConfirm', audience, enforcement: 'console', default: 'required', modes: ON_OFF, routes: [] };
}

export const ACTION_CONFIRMATION_CATALOGUE: readonly ActionConfirmationSpec[] = [
  // ── Model residency & serving (platform) ─────────────────────────────────
  reason('modelResidency.load', 'Model residency', 'Load a model', 'platform', 'when-risky', ['POST admin/model-residency/load'], { modes: RISKY, maxLength: 500 }),
  reason('modelResidency.reload', 'Model residency', 'Apply & reload a model', 'platform', 'when-risky', ['POST admin/model-residency/load (replace: true, stt / nlp)'], { modes: RISKY, maxLength: 500 }),
  reason('modelResidency.unload', 'Model residency', 'Unload a model', 'platform', 'when-risky', ['POST admin/model-residency/unload'], { modes: RISKY, maxLength: 500 }),
  reason('lmStudioServing.apply', 'Model residency', 'Apply an LM Studio serving profile', 'platform', 'when-risky', ['POST admin/model-residency/load (service: lm-studio, replace: true)'], { modes: RISKY, maxLength: 500 }),

  // ── Prompt templates ─────────────────────────────────────────────────────
  reason('promptTemplate.create', 'Prompt templates', 'Create a prompt template', 'both', 'not-required', ['POST admin/prompt-templates'], { maxLength: 500 }),
  reason('promptTemplate.update', 'Prompt templates', 'Save a new prompt template version', 'both', 'not-required', ['PATCH admin/prompt-templates/:id'], { maxLength: 500 }),
  reason('promptTemplate.approve', 'Prompt templates', 'Approve a prompt template', 'both', 'not-required', ['POST admin/prompt-templates/:id/approve'], { maxLength: 500 }),

  // ── Agents ───────────────────────────────────────────────────────────────
  reason('agent.promoteToSystem', 'Agents', 'Promote an agent to SYSTEM', 'platform', 'required', ['POST admin/agents/promote-to-system'], { maxLength: 500 }),
  reason('agent.sync', 'Agents', 'Sync an agent from the reference set', 'both', 'not-required', ['POST admin/agents/:slug/sync'], { maxLength: 500 }),
  reason('agentAssignment.set', 'Agents', 'Set an agent assignment', 'both', 'not-required', ['PUT admin/agent-assignments'], { maxLength: 500 }),
  reason('agentAssignment.remove', 'Agents', 'Remove an agent assignment', 'both', 'not-required', ['DELETE admin/agent-assignments/:id'], { maxLength: 500 }),

  // ── Workflows ────────────────────────────────────────────────────────────
  reason('workflowDefinition.promoteToSystem', 'Workflows', 'Promote a workflow to SYSTEM', 'platform', 'not-required', ['POST admin/workflow-definitions/promote-to-system'], { maxLength: 500 }),
  reason('workflowDefinition.sync', 'Workflows', 'Sync a workflow from the reference set', 'both', 'not-required', ['POST admin/workflow-definitions/slug/:slug/sync'], { maxLength: 500 }),
  reason('workflowAssignment.set', 'Workflows', 'Set a workflow assignment', 'both', 'not-required', ['PUT admin/workflow-assignments'], { maxLength: 500 }),
  reason('workflowReview.decide', 'Workflows', 'Decide a workflow exposure review', 'both', 'not-required', ['POST workflows/:slug/runs/:runId/reviews/:nodeId/decide'], { maxLength: 2000 }),
  reason('workflowInvariantRule.save', 'Workflows', 'Create or edit a workflow invariant rule', 'both', 'not-required', ['POST|PATCH admin/workflow-invariant-rules'], { maxLength: 2000 }),
  reason('workflowRun.cancel', 'Workflows', 'Cancel a running workflow (AI Operations)', 'platform', 'not-required', ['POST admin/harness/workflows/:id/cancel'], { maxLength: 500 }),

  // ── Policies ─────────────────────────────────────────────────────────────
  reason('harnessPolicy.update', 'Policies', 'Update a harness / agentic policy', 'both', 'not-required', ['PATCH admin/harness/policy', 'PATCH admin/harness/policy/global'], { maxLength: 500 }),
  reason('harnessLiveConfig.update', 'Policies', 'Switch the live engine on or off', 'platform', 'not-required', ['PATCH admin/harness/live/config'], { maxLength: 500 }),
  reason('guardrailAvailability.update', 'Policies', 'Change guardrail availability', 'both', 'not-required', ['PATCH admin/guardrail-availability'], { maxLength: 500 }),

  // ── Content ──────────────────────────────────────────────────────────────
  reason('documentTemplate.update', 'Content', 'Publish a document template version', 'both', 'not-required', ['POST admin/document-templates/:id/publish'], { maxLength: 500 }),
  reason('contextSchema.publish', 'Content', 'Publish a context schema', 'both', 'not-required', ['POST admin/consultation-context-schemas/:id/publish'], { maxLength: 500 }),
  {
    actionId: 'contextSchema.publishImpact',
    domain: 'Content',
    label: 'Acknowledge downstream impact when publishing a context schema',
    kind: 'acknowledgement',
    audience: 'both',
    enforcement: 'server',
    default: 'required',
    modes: ON_OFF,
    routes: ['POST admin/consultation-context-schemas/:id/publish'],
  },
  reason('dnaSettings.update', 'Content', 'Change DNA writing-style settings', 'both', 'not-required', ['PUT dna-writing-styles/settings'], { maxLength: 500 }),

  // ── Consent ──────────────────────────────────────────────────────────────
  {
    actionId: 'consent.record',
    domain: 'Consent',
    label: 'Evidence reference when recording consent',
    kind: 'evidence',
    audience: 'tenant',
    enforcement: 'server',
    default: 'not-required',
    modes: ON_OFF,
    maxLength: 500,
    routes: ['POST admin/consent-grants'],
  },
  reason('consent.revoke', 'Consent', 'Revoke a consent grant', 'tenant', 'not-required', ['POST admin/consent-grants/:id/revoke'], { maxLength: 500 }),

  // ── Tenancy ──────────────────────────────────────────────────────────────
  reason('tenantCheckpoint.restore', 'Tenancy', 'Restore a tenant checkpoint', 'both', 'required', ['POST admin/tenants/:tenantId/checkpoints/:id/restore'], {
    minLength: 10,
    maxLength: 1000,
  }),

  // ── Locked: never switchable ─────────────────────────────────────────────
  {
    actionId: 'impersonation.start',
    domain: 'Access',
    label: 'Reason to impersonate a user',
    kind: 'reason',
    audience: 'platform',
    enforcement: 'server',
    default: 'required',
    modes: LOCKED,
    locked: true,
    maxLength: 500,
    routes: ['POST admin/users/:id/impersonate', 'POST auth/impersonate'],
  },
  {
    actionId: 'rbac.breakGlass',
    domain: 'Access',
    label: 'Break-glass to delete a role or policy, detach a policy, or edit a multi-role policy',
    kind: 'breakGlass',
    audience: 'both',
    enforcement: 'server',
    default: 'required',
    modes: LOCKED,
    locked: true,
    routes: ['DELETE admin/rbac/roles/:id', 'DELETE admin/rbac/roles/:roleId/policies/:policyId', 'DELETE admin/rbac/policies/:id', 'PATCH admin/rbac/policies/:id'],
  },
  {
    actionId: 'tenantCheckpoint.restoreBreakGlass',
    domain: 'Tenancy',
    label: 'Break-glass to restore a tenant checkpoint',
    kind: 'breakGlass',
    audience: 'both',
    enforcement: 'server',
    default: 'required',
    modes: LOCKED,
    locked: true,
    routes: ['POST admin/tenants/:tenantId/checkpoints/:id/restore'],
  },
  {
    actionId: 'globalSetting.secretStepUp',
    domain: 'Access',
    label: 'Password to reveal or rotate a secret setting',
    kind: 'stepUp',
    audience: 'both',
    enforcement: 'server',
    default: 'required',
    modes: LOCKED,
    locked: true,
    routes: ['POST admin/settings/:id/reveal', 'POST admin/settings/:id/rotate'],
  },
  {
    actionId: 'billing.adjustment',
    domain: 'Billing',
    label: 'Reason code on an invoice adjustment',
    kind: 'reasonCode',
    audience: 'platform',
    enforcement: 'server',
    default: 'required',
    modes: LOCKED,
    locked: true,
    routes: ['POST admin/billing/invoices/:id/adjustments'],
  },

  // ── Typed-name confirmations (console only) ──────────────────────────────
  typed('tenant.delete', 'Tenancy', 'Type the tenant name to delete a tenant', 'platform'),
  typed('user.delete', 'Access', 'Type the username to delete a user', 'both'),
  typed('apiKey.delete', 'Access', 'Type the key name to delete an API key', 'both'),
  typed('identityProvider.delete', 'Access', 'Type the name to delete an identity provider', 'both'),
  typed('tenantStorage.delete', 'Storage', 'Type the slug to delete a storage configuration', 'both'),
  typed('storageObject.delete', 'Storage', 'Type the object name to delete a stored object', 'both'),
  typed('knowledgeDocument.delete', 'Content', 'Type the title to delete a knowledge document', 'both'),
  typed('department.delete', 'Tenancy', 'Type the confirmation token to delete a department', 'both'),
  typed('agent.deprecate', 'Agents', 'Type the slug to deprecate an active agent version', 'both'),
  typed('agent.delete', 'Agents', 'Type the slug to delete an agent lineage', 'both'),
  typed('versionedContent.lifecycle', 'Content', 'Type the slug or phrase to archive or delete versioned content', 'both'),
  typed('contextSchema.delete', 'Content', 'Type the schema name to delete a context schema', 'both'),
  typed('promptTemplate.delete', 'Prompt templates', 'Type the name to delete a prompt template', 'both'),
  typed('documentTemplate.delete', 'Content', 'Type the name to delete a document template', 'both'),
  typed('workflow.delete', 'Workflows', 'Type the phrase to delete a workflow', 'both'),
  typed('harnessWorkflow.action', 'Workflows', 'Type the workflow id to act on a harness workflow', 'platform'),
];

export type ActionConfirmationId = string;

/** The setting key that stores one action's mode on the SYSTEM tier. */
export function actionConfirmationSettingKey(actionId: string): string {
  return `confirmation.${actionId}`;
}

export function findActionConfirmation(actionId: string): ActionConfirmationSpec | undefined {
  return ACTION_CONFIRMATION_CATALOGUE.find((spec) => spec.actionId === actionId);
}

/** One row of `GET admin/settings/action-confirmations/effective` — what a dialog needs. */
export interface EffectiveActionConfirmation {
  actionId: string;
  kind: ConfirmationKind;
  mode: ConfirmationMode;
  locked: boolean;
  minLength?: number;
  maxLength?: number;
}

/**
 * The audit stamp every confirmable action writes onto its audit / sys-event metadata under the key
 * `confirmation` — INCLUDING when nothing was required, so the trail stays complete.
 */
export interface ActionConfirmationAuditStamp {
  actionId: string;
  kind: ConfirmationKind;
  mode: ConfirmationMode;
  locked: boolean;
  /** Whether the policy demanded a value for THIS request (after `when-risky` is evaluated). */
  required: boolean;
  /** Whether the caller supplied a non-empty value. */
  provided: boolean;
  /** Human-readable verdict, e.g. `reason required`, `reason not required`. */
  note: string;
}

/** The 400 body when a required confirmation is missing or too short. */
export const CONFIRMATION_REQUIRED_CODE = 'CONFIRMATION_REQUIRED';

/**
 * The audit stamp of a LOCKED row (always required, never switchable). Pure, so a service that
 * records a locked confirmation needs no settings dependency (and no module edge to the settings
 * registry — `GlobalSettingServiceModule` is imported BY it, so the edge would close a cycle).
 */
export function lockedConfirmationStamp(actionId: string, provided = true): ActionConfirmationAuditStamp {
  const spec = findActionConfirmation(actionId);
  if (!spec || !spec.locked) throw new Error(`'${actionId}' is not a locked action confirmation.`);
  const noun = spec.kind === 'stepUp' ? 'password confirmation' : spec.kind === 'breakGlass' ? 'break-glass confirmation' : spec.kind === 'reasonCode' ? 'reason code' : 'reason';
  return { actionId, kind: spec.kind, mode: 'required', locked: true, required: true, provided, note: `${noun} required` };
}
