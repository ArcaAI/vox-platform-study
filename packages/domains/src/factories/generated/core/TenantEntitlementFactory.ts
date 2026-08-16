/* eslint-disable unused-imports/no-unused-imports */
/* eslint-disable @typescript-eslint/no-unused-vars */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { generateId } from '../../../utils';
import { BaseEntityFactoryCreateProps } from '../../../common';
import { TenantEntitlementEntity, ITenantEntitlementEntity } from '../../../entities';
import * as Enums from '../../../enums';

export interface CreateTenantEntitlementProps extends BaseEntityFactoryCreateProps {
  maxUsers?: ITenantEntitlementEntity['maxUsers'];
  maxDepartments?: ITenantEntitlementEntity['maxDepartments'];
  maxPromptTemplates?: ITenantEntitlementEntity['maxPromptTemplates'];
  maxAsrPipelines?: ITenantEntitlementEntity['maxAsrPipelines'];
  maxApiKeys?: ITenantEntitlementEntity['maxApiKeys'];
  maxWorkflowDefinitions?: ITenantEntitlementEntity['maxWorkflowDefinitions'];
  storageQuotaBytes?: ITenantEntitlementEntity['storageQuotaBytes'];
  maxConcurrentSessions?: ITenantEntitlementEntity['maxConcurrentSessions'];
  monthlyConsultations?: ITenantEntitlementEntity['monthlyConsultations'];
  monthlyTranscriptionMinutes?: ITenantEntitlementEntity['monthlyTranscriptionMinutes'];
  monthlySummaries?: ITenantEntitlementEntity['monthlySummaries'];
  monthlyWorkflowInvocations?: ITenantEntitlementEntity['monthlyWorkflowInvocations'];
  monthlySttSessionSeconds?: ITenantEntitlementEntity['monthlySttSessionSeconds'];
  monthlyLlmTokens?: ITenantEntitlementEntity['monthlyLlmTokens'];
  monthlyTtsCharacters?: ITenantEntitlementEntity['monthlyTtsCharacters'];
  monthlyNlpTextUnits?: ITenantEntitlementEntity['monthlyNlpTextUnits'];
  monthlyEmbeddingTokens?: ITenantEntitlementEntity['monthlyEmbeddingTokens'];
  monthlySpendLimitMicros?: ITenantEntitlementEntity['monthlySpendLimitMicros'];
  featureDnaReports?: ITenantEntitlementEntity['featureDnaReports'];
  featureVoiceEnrollment?: ITenantEntitlementEntity['featureVoiceEnrollment'];
  featureMonitoringAccess?: ITenantEntitlementEntity['featureMonitoringAccess'];
  featurePlatformDefaultCredential?: ITenantEntitlementEntity['featurePlatformDefaultCredential'];
  featurePaletteStt?: ITenantEntitlementEntity['featurePaletteStt'];
  modelTier?: ITenantEntitlementEntity['modelTier'];
  rateLimitTier?: ITenantEntitlementEntity['rateLimitTier'];
  rateLimitPerMinute?: ITenantEntitlementEntity['rateLimitPerMinute'];
  tenantId: ITenantEntitlementEntity['tenantId'];

  createdAt?: ITenantEntitlementEntity['createdAt'];
  updatedAt?: ITenantEntitlementEntity['updatedAt'];
  createdBy?: ITenantEntitlementEntity['createdBy'];
  updatedBy?: ITenantEntitlementEntity['updatedBy'];
}

export class TenantEntitlementFactory {
  static CreateTenantEntitlement(props: CreateTenantEntitlementProps): TenantEntitlementEntity {
    const id = generateId();
    const now = new Date();

    return new TenantEntitlementEntity({
      id,
      createdAt: props.createdAt || now,
      updatedAt: props.updatedAt || now,
      createdBy: props.createdBy ?? null,
      updatedBy: props.updatedBy ?? null,
      tenantId: props.tenantId,
      maxUsers: props.maxUsers ?? null,
      maxDepartments: props.maxDepartments ?? null,
      maxPromptTemplates: props.maxPromptTemplates ?? null,
      maxAsrPipelines: props.maxAsrPipelines ?? null,
      maxApiKeys: props.maxApiKeys ?? null,
      maxWorkflowDefinitions: props.maxWorkflowDefinitions ?? null,
      storageQuotaBytes: props.storageQuotaBytes ?? null,
      maxConcurrentSessions: props.maxConcurrentSessions ?? null,
      monthlyConsultations: props.monthlyConsultations ?? null,
      monthlyTranscriptionMinutes: props.monthlyTranscriptionMinutes ?? null,
      monthlySummaries: props.monthlySummaries ?? null,
      monthlyWorkflowInvocations: props.monthlyWorkflowInvocations ?? null,
      monthlySttSessionSeconds: props.monthlySttSessionSeconds ?? null,
      monthlyLlmTokens: props.monthlyLlmTokens ?? null,
      monthlyTtsCharacters: props.monthlyTtsCharacters ?? null,
      monthlyNlpTextUnits: props.monthlyNlpTextUnits ?? null,
      monthlyEmbeddingTokens: props.monthlyEmbeddingTokens ?? null,
      monthlySpendLimitMicros: props.monthlySpendLimitMicros ?? null,
      featureDnaReports: props.featureDnaReports ?? null,
      featureVoiceEnrollment: props.featureVoiceEnrollment ?? null,
      featureMonitoringAccess: props.featureMonitoringAccess ?? null,
      // `null` = inherit the plan (which is itself `false`), NOT deny —
      // the tri-state's three states are all load-bearing here.
      featurePlatformDefaultCredential: props.featurePlatformDefaultCredential ?? null,
      // `null` = inherit the plan default (TASK-724).
      featurePaletteStt: props.featurePaletteStt ?? null,
      modelTier: props.modelTier ?? null,
      rateLimitTier: props.rateLimitTier ?? null,
      rateLimitPerMinute: props.rateLimitPerMinute ?? null,
    });
  }
}
