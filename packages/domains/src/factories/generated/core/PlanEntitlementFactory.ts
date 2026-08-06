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
  storageQuotaBytes?: IPlanEntitlementEntity['storageQuotaBytes'];
  maxConcurrentSessions?: IPlanEntitlementEntity['maxConcurrentSessions'];
  monthlyConsultations?: IPlanEntitlementEntity['monthlyConsultations'];
  monthlyTranscriptionMinutes?: IPlanEntitlementEntity['monthlyTranscriptionMinutes'];
  monthlySummaries?: IPlanEntitlementEntity['monthlySummaries'];
  monthlySttSessionSeconds?: IPlanEntitlementEntity['monthlySttSessionSeconds'];
  monthlyLlmTokens?: IPlanEntitlementEntity['monthlyLlmTokens'];
  monthlyTtsCharacters?: IPlanEntitlementEntity['monthlyTtsCharacters'];
  monthlyNlpTextUnits?: IPlanEntitlementEntity['monthlyNlpTextUnits'];
  monthlyEmbeddingTokens?: IPlanEntitlementEntity['monthlyEmbeddingTokens'];
  featureDnaReports?: IPlanEntitlementEntity['featureDnaReports'];
  featureVoiceEnrollment?: IPlanEntitlementEntity['featureVoiceEnrollment'];
  featureMonitoringAccess?: IPlanEntitlementEntity['featureMonitoringAccess'];
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
      storageQuotaBytes: props.storageQuotaBytes ?? null,
      maxConcurrentSessions: props.maxConcurrentSessions ?? null,
      monthlyConsultations: props.monthlyConsultations ?? null,
      monthlyTranscriptionMinutes: props.monthlyTranscriptionMinutes ?? null,
      monthlySummaries: props.monthlySummaries ?? null,
      monthlySttSessionSeconds: props.monthlySttSessionSeconds ?? null,
      monthlyLlmTokens: props.monthlyLlmTokens ?? null,
      monthlyTtsCharacters: props.monthlyTtsCharacters ?? null,
      monthlyNlpTextUnits: props.monthlyNlpTextUnits ?? null,
      monthlyEmbeddingTokens: props.monthlyEmbeddingTokens ?? null,
      featureDnaReports: props.featureDnaReports ?? false,
      featureVoiceEnrollment: props.featureVoiceEnrollment ?? false,
      featureMonitoringAccess: props.featureMonitoringAccess ?? false,
      modelTier: props.modelTier ?? 'full',
      rateLimitTier: props.rateLimitTier ?? 'default',
    });
  }
}
