import { describe, expect, it } from 'vitest';
import { Prisma, MODELS_WITHOUT_SOFT_DELETE } from '@arcaai/database';
import { CHECKPOINT_REGISTRY, descriptorFor, tableName } from '../registry';

describe('checkpoint registry', () => {
  it('describes every Prisma model exactly once', () => {
    const models = Object.values(Prisma.ModelName).sort();
    const described = CHECKPOINT_REGISTRY.map((d) => d.model).sort();
    expect(described).toEqual(models);
  });

  it('agrees with MODELS_WITHOUT_SOFT_DELETE', () => {
    for (const d of CHECKPOINT_REGISTRY) {
      expect({ model: d.model, softDelete: d.softDelete }).toEqual({
        model: d.model,
        softDelete: !MODELS_WITHOUT_SOFT_DELETE.has(d.model),
      });
    }
  });

  it('never soft-deletes a model without soft delete and never restores an EXCLUDED/LOGS model', () => {
    for (const d of CHECKPOINT_REGISTRY) {
      if (!d.softDelete) expect(d.retire.kind, d.model).not.toBe('softDelete');
      if (d.category === 'LOGS') expect(d.policy, d.model).toBe('CAPTURE_ONLY');
      if (d.category === 'EXCLUDED') expect([d.policy, d.scope.kind], d.model).toEqual(['EXCLUDED', 'none']);
    }
  });

  it('only retires through a path the policy allows', () => {
    for (const d of CHECKPOINT_REGISTRY) {
      if (d.policy === 'CAPTURE_ONLY' || d.policy === 'EXCLUDED' || d.policy === 'INSERT_ONLY') {
        expect(d.retire.kind, d.model).toBe('never');
      }
      if (d.policy === 'RETIRE_ONLY') expect(d.retire.kind, d.model).not.toBe('never');
      if (d.retire.kind === 'revoke') expect(d.retire.setSql, d.model).not.toMatch(/;/);
      if (d.immutableWhen !== undefined) expect(d.immutableColumns?.length, d.model).toBeGreaterThan(0);
      if (d.scope.kind === 'parent') expect(() => descriptorFor((d.scope as { parent: string }).parent)).not.toThrow();
    }
  });

  it('maps only the @@map models to a different table', () => {
    const mapped = Object.fromEntries(CHECKPOINT_REGISTRY.filter((d) => d.table).map((d) => [d.model, d.table]));
    expect(mapped).toEqual({
      FedlClient: 'clients',
      FedlRound: 'rounds',
      FedlUpdate: 'updates',
      FedlModelVersion: 'model_versions',
    });
    expect(tableName(descriptorFor('FedlRound'))).toBe('core."rounds"');
    expect(tableName(descriptorFor('Agent'))).toBe('core."Agent"');
  });

  it('throws on an unknown model', () => {
    expect(() => descriptorFor('NoSuchModel')).toThrow(/NoSuchModel/);
  });

  // Category snapshot: moving a model between categories or policies is a deliberate change to this table.
  it('matches the category / policy / retire snapshot', () => {
    const snapshot = Object.fromEntries(
      [...CHECKPOINT_REGISTRY]
        .sort((a, b) => a.model.localeCompare(b.model))
        .map((d) => [d.model, `${d.category} ${d.policy} ${d.retire.kind} ${d.scope.kind}`]),
    );
    expect(snapshot).toEqual({
      Agent: 'CONFIG_CONTENT RECONCILE softDelete tenantColumn',
      AgentAssignment: 'CONFIG_CONTENT RECONCILE softDelete tenantColumn',
      AgentAssignmentChange: 'LOGS CAPTURE_ONLY never tenantColumn',
      AgentModelFallback: 'CONFIG_CONTENT RECONCILE hardDelete tenantColumn',
      AgentPromotion: 'LOGS CAPTURE_ONLY never tenantColumn',
      AgentTrajectoryStep: 'LOGS CAPTURE_ONLY never tenantColumn',
      AiActivityRun: 'LOGS CAPTURE_ONLY never tenantColumn',
      AiModel: 'CONFIG_CONTENT RECONCILE softDelete tenantColumn',
      AiPriceBook: 'EXCLUDED EXCLUDED never none',
      AiProviderConnection: 'CONFIG_CONTENT RECONCILE softDelete tenantColumn',
      AiRoutingPolicy: 'CONFIG_CONTENT RECONCILE softDelete tenantColumn',
      AiUsageEvent: 'LOGS CAPTURE_ONLY never tenantColumn',
      AiUsageOutbox: 'LOGS CAPTURE_ONLY never tenantColumn',
      AiUsageRollupDaily: 'LOGS CAPTURE_ONLY never tenantColumn',
      AiUsageRollupHourly: 'LOGS CAPTURE_ONLY never tenantColumn',
      ApiKey: 'USERS_ACCESS RETIRE_ONLY revoke tenantColumn',
      AudioRecording: 'CLINICAL RECONCILE hardDelete tenantColumn',
      AuditLog: 'LOGS CAPTURE_ONLY never tenantColumn',
      BillingAdjustment: 'LOGS CAPTURE_ONLY never tenantColumn',
      BillingInvoice: 'LOGS CAPTURE_ONLY never tenantColumn',
      BillingInvoiceLine: 'LOGS CAPTURE_ONLY never tenantColumn',
      ChangelogEntry: 'EXCLUDED EXCLUDED never none',
      ComposedPromptRecord: 'EXCLUDED EXCLUDED never none',
      ConsentGrant: 'CLINICAL INSERT_ONLY never tenantColumn',
      Consultation: 'CLINICAL RECONCILE softDelete tenantColumn',
      ConsultationApproval: 'CLINICAL RECONCILE never tenantColumn',
      ConsultationAttachment: 'CLINICAL RECONCILE softDelete tenantColumn',
      ConsultationEncounter: 'CLINICAL RECONCILE hardDelete tenantColumn',
      ConsultationFeedback: 'CLINICAL RECONCILE hardDelete tenantColumn',
      ConsultationFeedbackDailyRollup: 'LOGS CAPTURE_ONLY never tenantColumn',
      ConsultationContextSchema: 'CONFIG_CONTENT RECONCILE softDelete tenantColumn',
      ConsultationContextSchemaVersion: 'CONFIG_CONTENT RECONCILE hardDelete tenantColumn',
      ContextItem: 'CLINICAL RECONCILE softDelete tenantColumn',
      ContextItemVersion: 'CLINICAL RECONCILE never tenantColumn',
      Department: 'CONFIG_CONTENT RECONCILE softDelete tenantColumn',
      DnaUsageRecord: 'LOGS CAPTURE_ONLY never tenantColumn',
      DnaWritingStyleReport: 'CLINICAL RECONCILE softDelete tenantColumn',
      DnaWritingSample: 'CLINICAL RECONCILE softDelete tenantColumn',
      DnaWritingStyleVersion: 'CLINICAL RECONCILE hardDelete tenantColumn',
      DocumentSection: 'CLINICAL RECONCILE hardDelete tenantColumn',
      DocumentTemplate: 'CONFIG_CONTENT RECONCILE softDelete tenantColumn',
      DocumentTemplateVersion: 'CONFIG_CONTENT RECONCILE never tenantColumn',
      EvalRun: 'CLINICAL RECONCILE softDelete tenantColumn',
      EvalScore: 'CLINICAL RECONCILE softDelete tenantColumn',
      FederatedIdentity: 'USERS_ACCESS INSERT_ONLY never tenantColumn',
      FedlClient: 'EXCLUDED EXCLUDED never none',
      FedlModelVersion: 'EXCLUDED EXCLUDED never none',
      FedlRound: 'EXCLUDED EXCLUDED never none',
      FedlUpdate: 'EXCLUDED EXCLUDED never none',
      GateEditExemplar: 'CLINICAL RECONCILE hardDelete tenantColumn',
      GlobalSetting: 'CONFIG_CONTENT RECONCILE softDelete tenantColumn',
      GoldenCase: 'CONFIG_CONTENT RECONCILE softDelete tenantColumn',
      GoldenSet: 'CONFIG_CONTENT RECONCILE softDelete tenantColumn',
      GovernedPromptPiece: 'LOGS CAPTURE_ONLY softDelete tenantColumn',
      HarnessAuditEvent: 'LOGS CAPTURE_ONLY never tenantColumn',
      HarnessPolicy: 'CONFIG_CONTENT RECONCILE softDelete tenantColumn',
      HarnessPolicyChange: 'LOGS CAPTURE_ONLY never tenantColumn',
      Highlight: 'CLINICAL RECONCILE softDelete tenantColumn',
      KnowledgeChunk: 'CONFIG_CONTENT CAPTURE_ONLY never tenantColumn',
      KnowledgeDocument: 'CONFIG_CONTENT RECONCILE softDelete tenantColumn',
      McpServer: 'CONFIG_CONTENT RECONCILE softDelete tenantColumn',
      Media: 'CLINICAL RECONCILE softDelete tenantColumn',
      ModelResidencyPolicy: 'EXCLUDED EXCLUDED never none',
      NamedEntity: 'CLINICAL RECONCILE hardDelete tenantColumn',
      Notification: 'CLINICAL RECONCILE softDelete tenantColumn',
      PasswordResetToken: 'EXCLUDED EXCLUDED never none',
      PlanEntitlement: 'EXCLUDED EXCLUDED never none',
      Policy: 'EXCLUDED EXCLUDED never none',
      PromptTemplate: 'CONFIG_CONTENT RECONCILE softDelete tenantColumn',
      PromptUsageRecord: 'LOGS CAPTURE_ONLY never tenantColumn',
      PromptVersion: 'CONFIG_CONTENT RECONCILE hardDelete tenantColumn',
      RateLimitRule: 'CONFIG_CONTENT RECONCILE softDelete tenantColumn',
      ResourceSubscription: 'CLINICAL RECONCILE softDelete tenantColumn',
      Role: 'USERS_ACCESS RECONCILE softDelete tenantColumn',
      RolePolicy: 'USERS_ACCESS RECONCILE hardDelete parent',
      ServiceAccount: 'USERS_ACCESS RETIRE_ONLY revoke tenantColumn',
      ServiceInstance: 'EXCLUDED EXCLUDED never none',
      ServiceRelease: 'EXCLUDED EXCLUDED never none',
      StorageAccessKey: 'USERS_ACCESS RETIRE_ONLY revoke tenantColumn',
      SummaryMeta: 'CLINICAL RECONCILE hardDelete tenantColumn',
      Tag: 'CONFIG_CONTENT RECONCILE softDelete tenantColumn',
      Tenant: 'EXCLUDED EXCLUDED never none',
      TenantAllowedOrigin: 'CONFIG_CONTENT RECONCILE softDelete tenantColumn',
      TenantBucket: 'CONFIG_CONTENT RECONCILE softDelete tenantColumn',
      TenantCheckpoint: 'EXCLUDED EXCLUDED never none',
      TenantCheckpointRestore: 'EXCLUDED EXCLUDED never none',
      TenantEntitlement: 'EXCLUDED EXCLUDED never none',
      TenantFrontendConfig: 'CONFIG_CONTENT RECONCILE softDelete tenantColumn',
      TenantGuardrailPolicy: 'CONFIG_CONTENT RECONCILE softDelete tenantColumn',
      TenantIdentityProvider: 'CONFIG_CONTENT RECONCILE softDelete tenantColumn',
      TenantIdentityProviderDomain: 'CONFIG_CONTENT RECONCILE softDelete tenantColumn',
      TenantNlpTaskInstructions: 'CONFIG_CONTENT RECONCILE softDelete tenantColumn',
      TenantPlanHistory: 'LOGS CAPTURE_ONLY never tenantColumn',
      TenantStorageConfig: 'CONFIG_CONTENT RECONCILE softDelete tenantColumn',
      TenantUsageMeter: 'LOGS CAPTURE_ONLY never tenantColumn',
      TranscriptSegment: 'CLINICAL RECONCILE hardDelete tenantColumn',
      TranscriptionJob: 'CLINICAL RECONCILE hardDelete tenantColumn',
      User: 'USERS_ACCESS INSERT_ONLY never tenantMembers',
      UserChangelogAcknowledgement: 'LOGS CAPTURE_ONLY never tenantColumn',
      UserDepartment: 'USERS_ACCESS RECONCILE softDelete tenantColumn',
      UserMedia: 'CLINICAL RECONCILE softDelete parent',
      UserProfile: 'USERS_ACCESS INSERT_ONLY never parent',
      UserRoleAssignment: 'USERS_ACCESS RECONCILE softDelete tenantColumn',
      UserSettings: 'USERS_ACCESS INSERT_ONLY never parent',
      UserVoiceProfile: 'CLINICAL RECONCILE softDelete tenantColumn',
      Webhook: 'CONFIG_CONTENT RECONCILE softDelete tenantColumn',
      WebhookRunHistory: 'LOGS CAPTURE_ONLY never parent',
      WorkflowAssignment: 'CONFIG_CONTENT RECONCILE softDelete tenantColumn',
      WorkflowAssignmentChange: 'LOGS CAPTURE_ONLY never tenantColumn',
      WorkflowDefinition: 'CONFIG_CONTENT RECONCILE softDelete tenantColumn',
      WorkflowInvariantRule: 'CONFIG_CONTENT RECONCILE softDelete tenantColumn',
      WorkflowRun: 'LOGS CAPTURE_ONLY never tenantColumn',
      WorkflowTestFixture: 'CONFIG_CONTENT RECONCILE softDelete tenantColumn',
      WorkflowWebhookSecret: 'CONFIG_CONTENT RECONCILE softDelete tenantColumn',
    });
  });
});
