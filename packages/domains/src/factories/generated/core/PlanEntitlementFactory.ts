/* eslint-disable unused-imports/no-unused-imports */
/* eslint-disable @typescript-eslint/no-unused-vars */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { generateId } from '../../../utils';
import { BaseEntityFactoryCreateProps } from '../../../common';
import { PlanEntitlementEntity, IPlanEntitlementEntity } from '../../../entities';
import * as Enums from '../../../enums';
import * as Entities from '../../../entities';

export interface CreatePlanEntitlementProps extends BaseEntityFactoryCreateProps {
  plan: IPlanEntitlementEntity['plan'];
  maxUsers?: IPlanEntitlementEntity['maxUsers'];
  maxDepartments?: IPlanEntitlementEntity['maxDepartments'];
  maxPromptTemplates?: IPlanEntitlementEntity['maxPromptTemplates'];
  maxAsrPipelines?: IPlanEntitlementEntity['maxAsrPipelines'];
  maxApiKeys?: IPlanEntitlementEntity['maxApiKeys'];
  maxWorkflowDefinitions?: IPlanEntitlementEntity['maxWorkflowDefinitions'];
  storageQuotaBytes?: IPlanEntitlementEntity['storageQuotaBytes'];
  maxConcurrentSessions?: IPlanEntitlementEntity['maxConcurrentSessions'];
  monthlyConsultations?: IPlanEntitlementEntity['monthlyConsultations'];
  monthlyTranscriptionMinutes?: IPlanEntitlementEntity['monthlyTranscriptionMinutes'];
  monthlySummaries?: IPlanEntitlementEntity['monthlySummaries'];
  monthlyWorkflowInvocations?: IPlanEntitlementEntity['monthlyWorkflowInvocations'];
  monthlySttSessionSeconds?: IPlanEntitlementEntity['monthlySttSessionSeconds'];
  monthlyLlmTokens?: IPlanEntitlementEntity['monthlyLlmTokens'];
  monthlyTtsCharacters?: IPlanEntitlementEntity['monthlyTtsCharacters'];
  monthlyNlpTextUnits?: IPlanEntitlementEntity['monthlyNlpTextUnits'];
  monthlyEmbeddingTokens?: IPlanEntitlementEntity['monthlyEmbeddingTokens'];
  featureDnaReports?: IPlanEntitlementEntity['featureDnaReports'];
  featureVoiceEnrollment?: IPlanEntitlementEntity['featureVoiceEnrollment'];
  featureMonitoringAccess?: IPlanEntitlementEntity['featureMonitoringAccess'];
  featurePlatformDefaultCredential?: IPlanEntitlementEntity['featurePlatformDefaultCredential'];
  featurePaletteStt?: IPlanEntitlementEntity['featurePaletteStt'];
  modelTier?: IPlanEntitlementEntity['modelTier'];
  rateLimitTier?: IPlanEntitlementEntity['rateLimitTier'];

  createdAt?: IPlanEntitlementEntity['createdAt'];
  updatedAt?: IPlanEntitlementEntity['updatedAt'];
  createdBy?: IPlanEntitlementEntity['createdBy'];
  updatedBy?: IPlanEntitlementEntity['updatedBy'];
}

export class PlanEntitlementFactory {
  static CreatePlanEntitlement(props: CreatePlanEntitlementProps): PlanEntitlementEntity {
    const id = generateId();
    const now = new Date();

    return new PlanEntitlementEntity({
      id,
      createdAt: props.createdAt || now,
      updatedAt: props.updatedAt || now,
      createdBy: props.createdBy ?? null,
      updatedBy: props.updatedBy ?? null,
      plan: props.plan,
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
      featureDnaReports: props.featureDnaReports ?? false,
      featureVoiceEnrollment: props.featureVoiceEnrollment ?? false,
      featureMonitoringAccess: props.featureMonitoringAccess ?? false,
      // Fail-CLOSED default — a plan never grants the platform-default
      // credential unless someone says so explicitly.
      featurePlatformDefaultCredential: props.featurePlatformDefaultCredential ?? false,
      // TASK-724: `true` by default — STT palette authoring is a core platform
      // capability, mirrors the Prisma column's own @default(true).
      featurePaletteStt: props.featurePaletteStt ?? true,
      modelTier: props.modelTier ?? 'full',
      rateLimitTier: props.rateLimitTier ?? 'default',
    });
  }
}
