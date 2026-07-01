/* eslint-disable unused-imports/no-unused-imports */
/* eslint-disable @typescript-eslint/no-unused-vars */
/* eslint-disable @typescript-eslint/no-explicit-any */

import { BaseDataModel } from '../../../common';
import { JsonValue } from '../../../interfaces';
import * as Enums from '../../../enums';
import * as Models from './';

export class PlanEntitlement extends BaseDataModel {
  public plan: Enums.TenantPlan;
  public maxUsers: number | null;
  public maxDepartments: number | null;
  public maxPromptTemplates: number | null;
  public maxAsrPipelines: number | null;
  public maxApiKeys: number | null;
  public storageQuotaBytes: bigint | null;
  public maxConcurrentSessions: number | null;
  public monthlyConsultations: number | null;
  public monthlyTranscriptionMinutes: number | null;
  public monthlySummaries: number | null;
  public featureDnaReports: boolean;
  public featureVoiceEnrollment: boolean;
  public featureMonitoringAccess: boolean;
  public modelTier: string;
  public rateLimitTier: string;
  public resourceStatus: Enums.ResourceStatusType;
  public resourceStatusUpdatedAt: Date | null;
  public resourceStatusUpdatedBy: string | null;

  constructor(data: PlanEntitlement & BaseDataModel) {
    super(data);
    this.plan = data.plan;
    this.maxUsers = data.maxUsers;
    this.maxDepartments = data.maxDepartments;
    this.maxPromptTemplates = data.maxPromptTemplates;
    this.maxAsrPipelines = data.maxAsrPipelines;
    this.maxApiKeys = data.maxApiKeys;
    this.storageQuotaBytes = data.storageQuotaBytes;
    this.maxConcurrentSessions = data.maxConcurrentSessions;
    this.monthlyConsultations = data.monthlyConsultations;
    this.monthlyTranscriptionMinutes = data.monthlyTranscriptionMinutes;
    this.monthlySummaries = data.monthlySummaries;
    this.featureDnaReports = data.featureDnaReports;
    this.featureVoiceEnrollment = data.featureVoiceEnrollment;
    this.featureMonitoringAccess = data.featureMonitoringAccess;
    this.modelTier = data.modelTier;
    this.rateLimitTier = data.rateLimitTier;
    this.resourceStatus = data.resourceStatus;
    this.resourceStatusUpdatedAt = data.resourceStatusUpdatedAt;
    this.resourceStatusUpdatedBy = data.resourceStatusUpdatedBy;
  }
}
