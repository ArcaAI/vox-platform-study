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
  storageQuotaBytes?: ITenantEntitlementEntity['storageQuotaBytes'];
  maxConcurrentSessions?: ITenantEntitlementEntity['maxConcurrentSessions'];
  monthlyConsultations?: ITenantEntitlementEntity['monthlyConsultations'];
  monthlyTranscriptionMinutes?: ITenantEntitlementEntity['monthlyTranscriptionMinutes'];
  monthlySummaries?: ITenantEntitlementEntity['monthlySummaries'];
  featureDnaReports?: ITenantEntitlementEntity['featureDnaReports'];
  featureVoiceEnrollment?: ITenantEntitlementEntity['featureVoiceEnrollment'];
  featureMonitoringAccess?: ITenantEntitlementEntity['featureMonitoringAccess'];
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
      storageQuotaBytes: props.storageQuotaBytes ?? null,
      maxConcurrentSessions: props.maxConcurrentSessions ?? null,
      monthlyConsultations: props.monthlyConsultations ?? null,
      monthlyTranscriptionMinutes: props.monthlyTranscriptionMinutes ?? null,
      monthlySummaries: props.monthlySummaries ?? null,
      featureDnaReports: props.featureDnaReports ?? null,
      featureVoiceEnrollment: props.featureVoiceEnrollment ?? null,
      featureMonitoringAccess: props.featureMonitoringAccess ?? null,
      modelTier: props.modelTier ?? null,
      rateLimitTier: props.rateLimitTier ?? null,
      rateLimitPerMinute: props.rateLimitPerMinute ?? null,
    });
  }
}
