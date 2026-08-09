/* eslint-disable unused-imports/no-unused-imports */
/* eslint-disable @typescript-eslint/no-unused-vars */
/* eslint-disable @typescript-eslint/no-explicit-any */

import { BaseTenantDataModel } from '../../../common';
import { JsonValue } from '../../../interfaces';
import * as Enums from '../../../enums';
import * as Models from './';

export class TenantEntitlement extends BaseTenantDataModel {
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
  public monthlySttSessionSeconds: bigint | null;
  public monthlyLlmTokens: bigint | null;
  public monthlyTtsCharacters: bigint | null;
  public monthlyNlpTextUnits: bigint | null;
  public monthlyEmbeddingTokens: bigint | null;
  public monthlySpendLimitMicros: bigint | null;
  public featureDnaReports: boolean | null;
  public featureVoiceEnrollment: boolean | null;
  public featureMonitoringAccess: boolean | null;
  public featurePlatformDefaultCredential: boolean | null;
  public modelTier: string | null;
  public rateLimitTier: string | null;
  public rateLimitPerMinute: number | null;
  public resourceStatus: Enums.ResourceStatusType;
  public resourceStatusUpdatedAt: Date | null;
  public resourceStatusUpdatedBy: string | null;

  constructor(data: TenantEntitlement & BaseTenantDataModel) {
    super(data);
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
    this.monthlySttSessionSeconds = data.monthlySttSessionSeconds;
    this.monthlyLlmTokens = data.monthlyLlmTokens;
    this.monthlyTtsCharacters = data.monthlyTtsCharacters;
    this.monthlyNlpTextUnits = data.monthlyNlpTextUnits;
    this.monthlyEmbeddingTokens = data.monthlyEmbeddingTokens;
    this.monthlySpendLimitMicros = data.monthlySpendLimitMicros;
    this.featureDnaReports = data.featureDnaReports;
    this.featureVoiceEnrollment = data.featureVoiceEnrollment;
    this.featureMonitoringAccess = data.featureMonitoringAccess;
    this.featurePlatformDefaultCredential = data.featurePlatformDefaultCredential;
    this.modelTier = data.modelTier;
    this.rateLimitTier = data.rateLimitTier;
    this.rateLimitPerMinute = data.rateLimitPerMinute;
    this.resourceStatus = data.resourceStatus;
    this.resourceStatusUpdatedAt = data.resourceStatusUpdatedAt;
    this.resourceStatusUpdatedBy = data.resourceStatusUpdatedBy;
  }
}
