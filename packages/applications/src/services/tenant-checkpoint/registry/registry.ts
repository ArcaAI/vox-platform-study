/**
 * The checkpoint model registry — one descriptor per Prisma model, deciding what a tenant
 * checkpoint captures and what a restore may write back. It is the security and data-loss
 * verdict of the whole feature, so every non-obvious call carries a `notes` entry.
 *
 * Policies:
 * - RECONCILE    — retire live rows absent from the checkpoint, update rows in both, insert rows missing live.
 * - INSERT_ONLY  — insert rows missing live; never update, never retire.
 * - RETIRE_ONLY  — retire live rows absent from the checkpoint; never update, never insert (never revive).
 * - CAPTURE_ONLY — written to the archive, never restored.
 * - EXCLUDED     — not captured at all.
 *
 * `immutableColumns: ['*']` means the trigger freezes the WHOLE row (it raises on every UPDATE and
 * DELETE) while `immutableWhen` holds; the restore must then leave the row untouched entirely —
 * including retirement, because a soft delete is an UPDATE.
 *
 * `immutableWhen` is SQL over the LIVE row alias `l`. Tests pin `immutableColumns` to the guard
 * functions in `packages/database/src/prisma/db_main/migrations/`.
 */
import type { CheckpointCategory, CheckpointModelDescriptor, CheckpointPolicy, CheckpointRetire, CheckpointScope } from '../contracts';

const TENANT: CheckpointScope = { kind: 'tenantColumn' };
const NONE: CheckpointScope = { kind: 'none' };
const parentOf = (fk: string, parent: string): CheckpointScope => ({ kind: 'parent', fk, parent });

const SOFT: CheckpointRetire = { kind: 'softDelete' };
const HARD: CheckpointRetire = { kind: 'hardDelete' };
const NEVER: CheckpointRetire = { kind: 'never' };
const revoke = (setSql: string): CheckpointRetire => ({ kind: 'revoke', setSql });

type Extra = Pick<CheckpointModelDescriptor, 'table' | 'immutableColumns' | 'immutableWhen' | 'derivedFrom' | 'notes'>;

function m(
  model: string,
  category: CheckpointCategory,
  policy: CheckpointPolicy,
  softDelete: boolean,
  retire: CheckpointRetire,
  scope: CheckpointScope = TENANT,
  extra: Extra = {},
): CheckpointModelDescriptor {
  return Object.freeze({ model, category, policy, scope, softDelete, retire, ...extra });
}

/** Restorable tenant-owned model, reconciled: soft delete when it has it, hard delete otherwise. */
const rec = (model: string, category: CheckpointCategory, softDelete: boolean, extra: Extra = {}) =>
  m(model, category, 'RECONCILE', softDelete, softDelete ? SOFT : HARD, TENANT, extra);
const log = (model: string, softDelete: boolean, scope: CheckpointScope = TENANT, extra: Extra = {}) =>
  m(model, 'LOGS', 'CAPTURE_ONLY', softDelete, NEVER, scope, extra);
const excluded = (model: string, softDelete: boolean, extra: Extra = {}) =>
  m(model, 'EXCLUDED', 'EXCLUDED', softDelete, NEVER, NONE, extra);

const PUBLISHED_OR_DEPRECATED = `l."status" IN ('PUBLISHED','DEPRECATED')`;

// ============================================================================================
// CONFIG_CONTENT — configuration and content the tenant admin authors. Reconciled; mixed
// models (SYSTEM rows next to tenant rows) only ever match `tenantId = $1`, so SYSTEM rows are
// never captured and never touched.
// ============================================================================================
const CONFIG_CONTENT: CheckpointModelDescriptor[] = [
  rec('Agent', 'CONFIG_CONTENT', true, {
    immutableColumns: [
      'compiledConfig', 'compiledConfigChecksum', 'modelId', 'task', 'instruction', 'parameters',
      'inputSchema', 'outputSchema', 'tools', 'tenantId', 'slug', 'versionNumber', 'parentVersionId', 'publishedAt',
    ],
    immutableWhen: PUBLISHED_OR_DEPRECATED,
    notes:
      'agent_immutability_guard blocks hard DELETE and these columns once PUBLISHED/DEPRECATED; resourceStatus/isActive stay writable, so a soft-delete retire is allowed. When a published row\'s immutable content differs from the checkpoint the row is left untouched (IMMUTABLE_DIVERGED). modelId may point at a SYSTEM AiModel (FK Restrict) — never captured, must exist live.',
  }),
  rec('AgentModelFallback', 'CONFIG_CONTENT', true, {
    immutableColumns: ['*'],
    immutableWhen: `EXISTS (SELECT 1 FROM core."Agent" a WHERE a."id" = l."agentId" AND a."status" IN ('PUBLISHED','DEPRECATED'))`,
    notes:
      'agent_model_fallback_immutability_guard refuses EVERY update and delete (soft delete included) while the parent Agent is PUBLISHED/DEPRECATED. Retire and update are skipped for such rows; inserts are unaffected (the trigger is not on INSERT).',
  }),
  rec('AgentAssignment', 'CONFIG_CONTENT', true),
  rec('PromptTemplate', 'CONFIG_CONTENT', true, {
    notes: 'Personal (USER_PERSONAL) templates are tenant rows too and are captured with the tenant.',
  }),
  rec('PromptVersion', 'CONFIG_CONTENT', false, {
    notes: 'No soft delete and no trigger: a version created after the checkpoint is hard-deleted. No FK points at it.',
  }),
  rec('WorkflowDefinition', 'CONFIG_CONTENT', true, {
    immutableColumns: [
      'graph', 'graphChecksum', 'compiledConfig', 'compiledConfigChecksum', 'contextSchemaId',
      'contextSchemaVersionNumber', 'contextSchemaFollowsLatest', 'tenantId', 'slug', 'paletteKey',
      'versionNumber', 'parentVersionId', 'publishedAt',
    ],
    immutableWhen: PUBLISHED_OR_DEPRECATED,
    notes: 'workflow_definition_immutability_guard (latest body: the context-schema binding migration). Soft-delete retire allowed; hard DELETE of a published row is refused.',
  }),
  rec('WorkflowAssignment', 'CONFIG_CONTENT', true),
  rec('WorkflowTestFixture', 'CONFIG_CONTENT', true),
  rec('WorkflowWebhookSecret', 'CONFIG_CONTENT', true, {
    notes: 'Secret material is Transit ciphertext; restored as ciphertext (same deployment only).',
  }),
  rec('WorkflowInvariantRule', 'CONFIG_CONTENT', true, { notes: 'Mixed model: tenant rows only.' }),
  rec('ConsultationContextSchema', 'CONFIG_CONTENT', true),
  rec('ConsultationContextSchemaVersion', 'CONFIG_CONTENT', false, {
    notes: 'No soft delete and no trigger: hard-deleted when absent. Referenced only by number, never by FK.',
  }),
  rec('DocumentTemplate', 'CONFIG_CONTENT', true),
  m('DocumentTemplateVersion', 'CONFIG_CONTENT', 'RECONCILE', false, NEVER, TENANT, {
    immutableColumns: ['*'],
    immutableWhen: 'true',
    notes:
      'document_template_version_immutability_guard refuses ALL updates and deletes: reconcile degenerates to insert-missing. A version created after the checkpoint stays.',
  }),
  rec('Department', 'CONFIG_CONTENT', true, { notes: 'Self-FK parentDepartmentId; single INSERT…SELECT satisfies it.' }),
  rec('GoldenSet', 'CONFIG_CONTENT', true),
  rec('GoldenCase', 'CONFIG_CONTENT', true, { notes: 'Cases are encrypted PHI; restored as ciphertext.' }),
  rec('KnowledgeDocument', 'CONFIG_CONTENT', true, {
    notes: 'Post-commit: restored/changed documents are re-ingested from the checkpoint chunk text; retired ones lose their Qdrant vectors.',
  }),
  m('KnowledgeChunk', 'CONFIG_CONTENT', 'CAPTURE_ONLY', true, NEVER, TENANT, {
    derivedFrom: 'KnowledgeDocument',
    notes: 'Derived: captured (it is the only copy of the document text) but never reconciled — the re-ingest job rewrites chunks and vectors together.',
  }),
  rec('TenantNlpTaskInstructions', 'CONFIG_CONTENT', true),
  rec('Tag', 'CONFIG_CONTENT', true),
  rec('AiProviderConnection', 'CONFIG_CONTENT', true, {
    notes: 'Mixed model: tenant rows only (BYO credentials as Transit ciphertext). SYSTEM rows never match $1.',
  }),
  rec('AiRoutingPolicy', 'CONFIG_CONTENT', true, {
    notes: 'Mixed model. modelId/providerConnectionId may reference SYSTEM rows (FK Restrict) that are never captured.',
  }),
  rec('GlobalSetting', 'CONFIG_CONTENT', true, { notes: 'Mixed model: tenant rows only; the platform tier is SYSTEM and never matches $1.' }),
  rec('TenantGuardrailPolicy', 'CONFIG_CONTENT', true),
  rec('TenantStorageConfig', 'CONFIG_CONTENT', true, {
    notes: 'Mixed model. credentialsRef is a Vault pointer, restored as a pointer — the secret itself is not in the checkpoint.',
  }),
  rec('TenantBucket', 'CONFIG_CONTENT', true),
  rec('TenantFrontendConfig', 'CONFIG_CONTENT', true),
  rec('TenantAllowedOrigin', 'CONFIG_CONTENT', true),
  rec('TenantIdentityProvider', 'CONFIG_CONTENT', true),
  rec('TenantIdentityProviderDomain', 'CONFIG_CONTENT', true),
  rec('HarnessPolicy', 'CONFIG_CONTENT', true, { notes: 'Mixed model: the GLOBAL-DEFAULT row is SYSTEM-owned and never matches $1.' }),
  rec('RateLimitRule', 'CONFIG_CONTENT', true, { notes: 'Mixed model: tenant rows only.' }),
  rec('Webhook', 'CONFIG_CONTENT', true),
  rec('McpServer', 'CONFIG_CONTENT', true, { notes: 'Mixed model: the SYSTEM shared registry never matches $1.' }),
  rec('AiModel', 'CONFIG_CONTENT', true, {
    notes: 'Mixed model: only BYO (tenant-owned) rows match $1; the SYSTEM catalogue ("Hope provider") is never captured.',
  }),
];

// ============================================================================================
// USERS_ACCESS — memberships, roles, credentials, and the global User rows of the tenant's
// members. A User is global (no tenantId) and may belong to other tenants, so it and its
// children are INSERT_ONLY: a restore never rewrites a password, a profile or settings.
// Credentials are RETIRE_ONLY: never revived, and one created after the checkpoint is revoked.
// ============================================================================================
const USERS_ACCESS: CheckpointModelDescriptor[] = [
  m('User', 'USERS_ACCESS', 'INSERT_ONLY', true, NEVER, { kind: 'tenantMembers' }, {
    notes: 'Global row: members are users with a UserRoleAssignment or UserDepartment in the tenant. Missing ⇒ insert; existing ⇒ untouched.',
  }),
  m('UserProfile', 'USERS_ACCESS', 'INSERT_ONLY', true, NEVER, parentOf('userId', 'User')),
  m('UserSettings', 'USERS_ACCESS', 'INSERT_ONLY', true, NEVER, parentOf('userId', 'User')),
  m('ApiKey', 'USERS_ACCESS', 'RETIRE_ONLY', true, revoke(`"keyStatus" = 'REVOKED'`), TENANT, {
    notes:
      'Unscoped in the Prisma extension but carries tenantId. Revocation mirrors ApiKeyService.revoke (keyStatus REVOKED); a key rotated/revoked after the checkpoint stays so, one created after it is revoked.',
  }),
  m('ServiceAccount', 'USERS_ACCESS', 'RETIRE_ONLY', true,
    revoke(`"resourceStatus" = 'DELETED', "resourceStatusUpdatedAt" = now()`), TENANT, {
      notes:
        'Unscoped in the Prisma extension but carries tenantId. Revocation mirrors ServiceAccountService.revoke (soft delete); its live exchanged tokens must also be purged post-commit.',
    }),
  m('StorageAccessKey', 'USERS_ACCESS', 'RETIRE_ONLY', true,
    revoke(`"resourceStatus" = 'DELETED', "resourceStatusUpdatedAt" = now()`), TENANT, {
      notes: 'Revocation mirrors StorageAccessKeyService.revokeKey (soft delete).',
    }),
  m('FederatedIdentity', 'USERS_ACCESS', 'INSERT_ONLY', true, NEVER, TENANT, {
    notes:
      'An IdP subject → User link. INSERT_ONLY: a link removed after the checkpoint is not revived, and a link made after it is kept — retiring it would lock the user out, since a soft-deleted row still holds the (providerId, subject) unique slot.',
  }),
  rec('UserRoleAssignment', 'USERS_ACCESS', true, {
    notes: 'roleId may point at a SYSTEM built-in Role, which is never captured and must exist live.',
  }),
  rec('UserDepartment', 'USERS_ACCESS', true),
  rec('Role', 'USERS_ACCESS', true, { notes: 'Tenant custom roles only; SYSTEM built-ins never match $1. Self-FK parentRoleId.' }),
  m('RolePolicy', 'USERS_ACCESS', 'RECONCILE', true, HARD, parentOf('roleId', 'Role'), {
    notes: 'Join row to the global Policy; hard-deleted so a later re-grant does not collide with a soft-deleted (roleId, policyId) unique slot.',
  }),
];

// ============================================================================================
// CLINICAL — patient data; restorable by a platform admin only.
// ============================================================================================
const CLINICAL: CheckpointModelDescriptor[] = [
  rec('Consultation', 'CLINICAL', true, { notes: 'Self-FK parentConsultationId. doctorId points at a global User.' }),
  rec('ContextItem', 'CLINICAL', true),
  rec('ContextItemVersion', 'CLINICAL', false),
  rec('AudioRecording', 'CLINICAL', false, { notes: 'Missing media bytes are re-uploaded from the checkpoint.' }),
  rec('SummaryMeta', 'CLINICAL', false),
  rec('NamedEntity', 'CLINICAL', false),
  rec('Highlight', 'CLINICAL', true),
  rec('TranscriptSegment', 'CLINICAL', false),
  rec('DocumentSection', 'CLINICAL', false),
  rec('TranscriptionJob', 'CLINICAL', false),
  rec('Media', 'CLINICAL', true, { notes: 'Bytes of a retired Media are left in place (the safety checkpoint references them).' }),
  m('UserMedia', 'CLINICAL', 'RECONCILE', true, SOFT, parentOf('mediaId', 'Media'), {
    notes: 'No tenantId; scoped through the tenant-owned Media, never through the global User (who may hold media in other tenants).',
  }),
  rec('UserVoiceProfile', 'CLINICAL', true, { notes: 'Partial unique UserVoiceProfile_userId_active_unique: retire clears isActive first.' }),
  m('ConsentGrant', 'CLINICAL', 'INSERT_ONLY', true, NEVER, TENANT, {
    notes:
      'A record of the patient\'s will, not tenant configuration: a restore must never un-revoke a consent revoked after the checkpoint (RECONCILE would rewrite revokedAt) nor retire one granted after it. Missing rows are inserted.',
  }),
  rec('DnaWritingStyleReport', 'CLINICAL', true),
  rec('DnaWritingStyleVersion', 'CLINICAL', false),
  rec('EvalRun', 'CLINICAL', true),
  rec('EvalScore', 'CLINICAL', true),
  rec('GateEditExemplar', 'CLINICAL', false, { notes: 'Derived gate-edit mining store; hard-deleted when absent.' }),
  rec('Notification', 'CLINICAL', true),
  rec('ResourceSubscription', 'CLINICAL', true),
];

// ============================================================================================
// LOGS — captured for the record, never restored. The WORM change logs and the hash-chained
// HarnessAuditEvent are captured byte-identical.
// ============================================================================================
const LOGS: CheckpointModelDescriptor[] = [
  log('AuditLog', true),
  log('HarnessAuditEvent', false, TENANT, { notes: 'Per-tenant hash chain over ciphertext; captured byte-identical.' }),
  log('AgentTrajectoryStep', false),
  log('WorkflowRun', false, TENANT, {
    notes: 'Never restored. A live RUNNING run of a consultation the restore retired is set CANCELED post-commit.',
  }),
  log('AiUsageEvent', false),
  log('AiUsageOutbox', false),
  log('AiUsageRollupHourly', false),
  log('AiUsageRollupDaily', false),
  log('TenantUsageMeter', true),
  log('TenantPlanHistory', false),
  log('BillingInvoice', true),
  log('BillingInvoiceLine', true),
  log('BillingAdjustment', false),
  log('DnaUsageRecord', false),
  log('PromptUsageRecord', false),
  log('WebhookRunHistory', true, parentOf('webhookId', 'Webhook')),
  log('UserChangelogAcknowledgement', false),
  log('HarnessPolicyChange', false, TENANT, { notes: 'WORM change log.' }),
  log('AgentAssignmentChange', false, TENANT, { notes: 'WORM: agent_assignment_change_worm_guard refuses every UPDATE/DELETE.' }),
  log('WorkflowAssignmentChange', false, TENANT, { notes: 'WORM change log.' }),
  log('AgentPromotion', false, TENANT, { notes: 'WORM change log.' }),
];

// ============================================================================================
// EXCLUDED — platform-owned or global rows, and the checkpoint tables themselves.
// ============================================================================================
const EXCLUDED: CheckpointModelDescriptor[] = [
  excluded('Tenant', true, { notes: 'Captured to tenant.json for identity only; never a table entry, never restored.' }),
  excluded('PasswordResetToken', true, { notes: 'Short-lived secret; reviving one would re-open a reset window.' }),
  excluded('TenantEntitlement', true, { notes: 'Plan ceilings are platform-governed; carries tenantId but is never restored.' }),
  excluded('PlanEntitlement', true),
  excluded('AiPriceBook', true),
  excluded('ModelResidencyPolicy', true),
  excluded('ServiceRelease', true),
  excluded('ServiceInstance', false),
  excluded('ChangelogEntry', false),
  excluded('Policy', true, { notes: 'Global policy catalogue; RolePolicy rows reference it and it must exist live.' }),
  excluded('FedlClient', true, { table: 'clients' }),
  excluded('FedlRound', true, { table: 'rounds' }),
  excluded('FedlUpdate', true, { table: 'updates' }),
  excluded('FedlModelVersion', true, { table: 'model_versions' }),
  excluded('TenantCheckpoint', true, { notes: 'A checkpoint never contains checkpoints.' }),
  excluded('TenantCheckpointRestore', true, { notes: 'A checkpoint never contains checkpoints.' }),
];

export const CHECKPOINT_REGISTRY: readonly CheckpointModelDescriptor[] = Object.freeze([
  ...CONFIG_CONTENT,
  ...USERS_ACCESS,
  ...CLINICAL,
  ...LOGS,
  ...EXCLUDED,
]);

const BY_MODEL: ReadonlyMap<string, CheckpointModelDescriptor> = new Map(CHECKPOINT_REGISTRY.map((d) => [d.model, d]));

export function descriptorFor(model: string): CheckpointModelDescriptor {
  const d = BY_MODEL.get(model);
  if (!d) throw new Error(`checkpoint registry: unknown model "${model}"`);
  return d;
}

/** Physical table name in schema core (unquoted). */
export function rawTableName(d: CheckpointModelDescriptor): string {
  return d.table ?? d.model;
}

export function tableName(d: CheckpointModelDescriptor): string {
  return `core."${rawTableName(d)}"`;
}

/** Resolve a physical table name back to its model (Fedl* map); unknown tables return as-is. */
export function modelForTable(table: string): string {
  for (const d of CHECKPOINT_REGISTRY) if (rawTableName(d) === table) return d.model;
  return table;
}
