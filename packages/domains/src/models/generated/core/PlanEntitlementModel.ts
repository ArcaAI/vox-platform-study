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
  public maxWorkflowDefinitions: number | null;
  public maxConcurrentSessions: number | null;
  public monthlyConsultations: number | null;
  public monthlyTranscriptionMinutes: number | null;
  public monthlySummaries: number | null;
  public monthlyWorkflowInvocations: number | null;
  public monthlySttSessionSeconds: bigint | null;
  public monthlyLlmTokens: bigint | null;
  public monthlyTtsCharacters: bigint | null;
  public monthlyNlpTextUnits: bigint | null;
  public monthlyEmbeddingTokens: bigint | null;
  public featurePlatformDefaultCredential: boolean;
  public featurePaletteStt: boolean;
  public featureAgenticLoop: boolean;
  public modelTier: string;
  public rateLimitTier: string;
  public rateLimitPerMinute: number | null;
  public rateLimitWindowMs: number | null;
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
    this.maxWorkflowDefinitions = data.maxWorkflowDefinitions;
    this.maxConcurrentSessions = data.maxConcurrentSessions;
    this.monthlyConsultations = data.monthlyConsultations;
    this.monthlyTranscriptionMinutes = data.monthlyTranscriptionMinutes;
    this.monthlySummaries = data.monthlySummaries;
    this.monthlyWorkflowInvocations = data.monthlyWorkflowInvocations;
    this.monthlySttSessionSeconds = data.monthlySttSessionSeconds;
    this.monthlyLlmTokens = data.monthlyLlmTokens;
    this.monthlyTtsCharacters = data.monthlyTtsCharacters;
    this.monthlyNlpTextUnits = data.monthlyNlpTextUnits;
    this.monthlyEmbeddingTokens = data.monthlyEmbeddingTokens;
    this.featurePlatformDefaultCredential = data.featurePlatformDefaultCredential;
    this.featurePaletteStt = data.featurePaletteStt;
    this.featureAgenticLoop = data.featureAgenticLoop;
    this.modelTier = data.modelTier;
    this.rateLimitTier = data.rateLimitTier;
    this.rateLimitPerMinute = data.rateLimitPerMinute;
    this.rateLimitWindowMs = data.rateLimitWindowMs;
    this.resourceStatus = data.resourceStatus;
    this.resourceStatusUpdatedAt = data.resourceStatusUpdatedAt;
    this.resourceStatusUpdatedBy = data.resourceStatusUpdatedBy;
  }
}
