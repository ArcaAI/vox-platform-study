/* eslint-disable unused-imports/no-unused-imports */
/* eslint-disable @typescript-eslint/no-unused-vars */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { BusinessException } from '@arcaai/exceptions';
import { BaseEntity, IBaseEntity } from '../../../common';
import * as Enums from '../../../enums';

export interface IPlanEntitlementEntity extends Omit<IBaseEntity, 'tenantId'> {
  plan: Enums.TenantPlan;
  maxUsers?: number | null;
  maxDepartments?: number | null;
  maxPromptTemplates?: number | null;
  maxAsrPipelines?: number | null;
  maxApiKeys?: number | null;
  // Quantity ceiling on PUBLISHED WorkflowDefinition slugs.
  maxWorkflowDefinitions?: number | null;
  storageQuotaBytes?: bigint | null;
  maxConcurrentSessions?: number | null;
  monthlyConsultations?: number | null;
  monthlyTranscriptionMinutes?: number | null;
  monthlySummaries?: number | null;
  // Fourth business-object meter — PUBLISHED-workflow invocations.
  monthlyWorkflowInvocations?: number | null;
  // Per-capability included allowances over the UTC-calendar-month window
  // BigInt: enterprise token/character counts exceed Int32.
  // null = unlimited (same convention as every meter column above).
  monthlySttSessionSeconds?: bigint | null;
  monthlyLlmTokens?: bigint | null;
  monthlyTtsCharacters?: bigint | null;
  monthlyNlpTextUnits?: bigint | null;
  monthlyEmbeddingTokens?: bigint | null;
  featureDnaReports: boolean;
  featureVoiceEnrollment: boolean;
  featureMonitoringAccess: boolean;
  featurePlatformDefaultCredential: boolean;
  featurePaletteStt: boolean;
  featureAgenticLoop: boolean;
  modelTier: string;
  rateLimitTier: string;
  // rank 3 — an ABSOLUTE per-plan limit. Null keeps the indirect
  // behaviour: the plan names a `rateLimitTier` whose baseline supplies the number.
  rateLimitPerMinute?: number | null;
  rateLimitWindowMs?: number | null;
}

export class PlanEntitlementEntity extends BaseEntity {
  private _plan: IPlanEntitlementEntity['plan'];
  private _maxUsers?: IPlanEntitlementEntity['maxUsers'];
  private _maxDepartments?: IPlanEntitlementEntity['maxDepartments'];
  private _maxPromptTemplates?: IPlanEntitlementEntity['maxPromptTemplates'];
  private _maxAsrPipelines?: IPlanEntitlementEntity['maxAsrPipelines'];
  private _maxApiKeys?: IPlanEntitlementEntity['maxApiKeys'];
  private _maxWorkflowDefinitions?: IPlanEntitlementEntity['maxWorkflowDefinitions'];
  private _storageQuotaBytes?: IPlanEntitlementEntity['storageQuotaBytes'];
  private _maxConcurrentSessions?: IPlanEntitlementEntity['maxConcurrentSessions'];
  private _monthlyConsultations?: IPlanEntitlementEntity['monthlyConsultations'];
  private _monthlyTranscriptionMinutes?: IPlanEntitlementEntity['monthlyTranscriptionMinutes'];
  private _monthlySummaries?: IPlanEntitlementEntity['monthlySummaries'];
  private _monthlyWorkflowInvocations?: IPlanEntitlementEntity['monthlyWorkflowInvocations'];
  private _monthlySttSessionSeconds?: IPlanEntitlementEntity['monthlySttSessionSeconds'];
  private _monthlyLlmTokens?: IPlanEntitlementEntity['monthlyLlmTokens'];
  private _monthlyTtsCharacters?: IPlanEntitlementEntity['monthlyTtsCharacters'];
  private _monthlyNlpTextUnits?: IPlanEntitlementEntity['monthlyNlpTextUnits'];
  private _monthlyEmbeddingTokens?: IPlanEntitlementEntity['monthlyEmbeddingTokens'];
  private _featureDnaReports: IPlanEntitlementEntity['featureDnaReports'];
  private _featureVoiceEnrollment: IPlanEntitlementEntity['featureVoiceEnrollment'];
  private _featureMonitoringAccess: IPlanEntitlementEntity['featureMonitoringAccess'];
  private _featurePlatformDefaultCredential: IPlanEntitlementEntity['featurePlatformDefaultCredential'];
  private _featurePaletteStt: IPlanEntitlementEntity['featurePaletteStt'];
  private _featureAgenticLoop: IPlanEntitlementEntity['featureAgenticLoop'];
  private _modelTier: IPlanEntitlementEntity['modelTier'];
  private _rateLimitTier: IPlanEntitlementEntity['rateLimitTier'];
  private _rateLimitPerMinute?: IPlanEntitlementEntity['rateLimitPerMinute'];
  private _rateLimitWindowMs?: IPlanEntitlementEntity['rateLimitWindowMs'];

  constructor(init: IPlanEntitlementEntity) {
    super(init);
    this._plan = init.plan;
    this._maxUsers = init.maxUsers;
    this._maxDepartments = init.maxDepartments;
    this._maxPromptTemplates = init.maxPromptTemplates;
    this._maxAsrPipelines = init.maxAsrPipelines;
    this._maxApiKeys = init.maxApiKeys;
    this._maxWorkflowDefinitions = init.maxWorkflowDefinitions;
    this._storageQuotaBytes = init.storageQuotaBytes;
    this._maxConcurrentSessions = init.maxConcurrentSessions;
    this._monthlyConsultations = init.monthlyConsultations;
    this._monthlyTranscriptionMinutes = init.monthlyTranscriptionMinutes;
    this._monthlySummaries = init.monthlySummaries;
    this._monthlyWorkflowInvocations = init.monthlyWorkflowInvocations;
    this._monthlySttSessionSeconds = init.monthlySttSessionSeconds;
    this._monthlyLlmTokens = init.monthlyLlmTokens;
    this._monthlyTtsCharacters = init.monthlyTtsCharacters;
    this._monthlyNlpTextUnits = init.monthlyNlpTextUnits;
    this._monthlyEmbeddingTokens = init.monthlyEmbeddingTokens;
    this._featureDnaReports = init.featureDnaReports;
    this._featureVoiceEnrollment = init.featureVoiceEnrollment;
    this._featureMonitoringAccess = init.featureMonitoringAccess;
    this._featurePlatformDefaultCredential = init.featurePlatformDefaultCredential;
    this._featurePaletteStt = init.featurePaletteStt;
    this._featureAgenticLoop = init.featureAgenticLoop;
    this._modelTier = init.modelTier;
    this._rateLimitTier = init.rateLimitTier;
    this._rateLimitPerMinute = init.rateLimitPerMinute;
    this._rateLimitWindowMs = init.rateLimitWindowMs;
  }

  get plan(): IPlanEntitlementEntity['plan'] {
    return this._plan;
  }

  set plan(value: IPlanEntitlementEntity['plan']) {
    this.setProperty('plan', value);
  }

  get maxUsers(): IPlanEntitlementEntity['maxUsers'] {
    return this._maxUsers;
  }

  set maxUsers(value: IPlanEntitlementEntity['maxUsers']) {
    this.setProperty('maxUsers', value);
  }

  get maxDepartments(): IPlanEntitlementEntity['maxDepartments'] {
    return this._maxDepartments;
  }

  set maxDepartments(value: IPlanEntitlementEntity['maxDepartments']) {
    this.setProperty('maxDepartments', value);
  }

  get maxPromptTemplates(): IPlanEntitlementEntity['maxPromptTemplates'] {
    return this._maxPromptTemplates;
  }

  set maxPromptTemplates(value: IPlanEntitlementEntity['maxPromptTemplates']) {
    this.setProperty('maxPromptTemplates', value);
  }

  get maxAsrPipelines(): IPlanEntitlementEntity['maxAsrPipelines'] {
    return this._maxAsrPipelines;
  }

  set maxAsrPipelines(value: IPlanEntitlementEntity['maxAsrPipelines']) {
    this.setProperty('maxAsrPipelines', value);
  }

  get maxApiKeys(): IPlanEntitlementEntity['maxApiKeys'] {
    return this._maxApiKeys;
  }

  set maxApiKeys(value: IPlanEntitlementEntity['maxApiKeys']) {
    this.setProperty('maxApiKeys', value);
  }

  get maxWorkflowDefinitions(): IPlanEntitlementEntity['maxWorkflowDefinitions'] {
    return this._maxWorkflowDefinitions;
  }

  set maxWorkflowDefinitions(value: IPlanEntitlementEntity['maxWorkflowDefinitions']) {
    this.setProperty('maxWorkflowDefinitions', value);
  }

  get storageQuotaBytes(): IPlanEntitlementEntity['storageQuotaBytes'] {
    return this._storageQuotaBytes;
  }

  set storageQuotaBytes(value: IPlanEntitlementEntity['storageQuotaBytes']) {
    this.setProperty('storageQuotaBytes', value);
  }

  get maxConcurrentSessions(): IPlanEntitlementEntity['maxConcurrentSessions'] {
    return this._maxConcurrentSessions;
  }

  set maxConcurrentSessions(value: IPlanEntitlementEntity['maxConcurrentSessions']) {
    this.setProperty('maxConcurrentSessions', value);
  }

  get monthlyConsultations(): IPlanEntitlementEntity['monthlyConsultations'] {
    return this._monthlyConsultations;
  }

  set monthlyConsultations(value: IPlanEntitlementEntity['monthlyConsultations']) {
    this.setProperty('monthlyConsultations', value);
  }

  get monthlyTranscriptionMinutes(): IPlanEntitlementEntity['monthlyTranscriptionMinutes'] {
    return this._monthlyTranscriptionMinutes;
  }

  set monthlyTranscriptionMinutes(value: IPlanEntitlementEntity['monthlyTranscriptionMinutes']) {
    this.setProperty('monthlyTranscriptionMinutes', value);
  }

  get monthlySummaries(): IPlanEntitlementEntity['monthlySummaries'] {
    return this._monthlySummaries;
  }

  set monthlySummaries(value: IPlanEntitlementEntity['monthlySummaries']) {
    this.setProperty('monthlySummaries', value);
  }

  get monthlyWorkflowInvocations(): IPlanEntitlementEntity['monthlyWorkflowInvocations'] {
    return this._monthlyWorkflowInvocations;
  }

  set monthlyWorkflowInvocations(value: IPlanEntitlementEntity['monthlyWorkflowInvocations']) {
    this.setProperty('monthlyWorkflowInvocations', value);
  }

  get monthlySttSessionSeconds(): IPlanEntitlementEntity['monthlySttSessionSeconds'] {
    return this._monthlySttSessionSeconds;
  }

  set monthlySttSessionSeconds(value: IPlanEntitlementEntity['monthlySttSessionSeconds']) {
    this.setProperty('monthlySttSessionSeconds', value);
  }

  get monthlyLlmTokens(): IPlanEntitlementEntity['monthlyLlmTokens'] {
    return this._monthlyLlmTokens;
  }

  set monthlyLlmTokens(value: IPlanEntitlementEntity['monthlyLlmTokens']) {
    this.setProperty('monthlyLlmTokens', value);
  }

  get monthlyTtsCharacters(): IPlanEntitlementEntity['monthlyTtsCharacters'] {
    return this._monthlyTtsCharacters;
  }

  set monthlyTtsCharacters(value: IPlanEntitlementEntity['monthlyTtsCharacters']) {
    this.setProperty('monthlyTtsCharacters', value);
  }

  get monthlyNlpTextUnits(): IPlanEntitlementEntity['monthlyNlpTextUnits'] {
    return this._monthlyNlpTextUnits;
  }

  set monthlyNlpTextUnits(value: IPlanEntitlementEntity['monthlyNlpTextUnits']) {
    this.setProperty('monthlyNlpTextUnits', value);
  }

  get monthlyEmbeddingTokens(): IPlanEntitlementEntity['monthlyEmbeddingTokens'] {
    return this._monthlyEmbeddingTokens;
  }

  set monthlyEmbeddingTokens(value: IPlanEntitlementEntity['monthlyEmbeddingTokens']) {
    this.setProperty('monthlyEmbeddingTokens', value);
  }

  get featureDnaReports(): IPlanEntitlementEntity['featureDnaReports'] {
    return this._featureDnaReports;
  }

  set featureDnaReports(value: IPlanEntitlementEntity['featureDnaReports']) {
    this.setProperty('featureDnaReports', value);
  }

  get featureVoiceEnrollment(): IPlanEntitlementEntity['featureVoiceEnrollment'] {
    return this._featureVoiceEnrollment;
  }

  set featureVoiceEnrollment(value: IPlanEntitlementEntity['featureVoiceEnrollment']) {
    this.setProperty('featureVoiceEnrollment', value);
  }

  get featureMonitoringAccess(): IPlanEntitlementEntity['featureMonitoringAccess'] {
    return this._featureMonitoringAccess;
  }

  set featureMonitoringAccess(value: IPlanEntitlementEntity['featureMonitoringAccess']) {
    this.setProperty('featureMonitoringAccess', value);
  }

  get featurePlatformDefaultCredential(): IPlanEntitlementEntity['featurePlatformDefaultCredential'] {
    return this._featurePlatformDefaultCredential;
  }

  set featurePlatformDefaultCredential(value: IPlanEntitlementEntity['featurePlatformDefaultCredential']) {
    this.setProperty('featurePlatformDefaultCredential', value);
  }

  get featurePaletteStt(): IPlanEntitlementEntity['featurePaletteStt'] {
    return this._featurePaletteStt;
  }

  set featurePaletteStt(value: IPlanEntitlementEntity['featurePaletteStt']) {
    this.setProperty('featurePaletteStt', value);
  }

  get featureAgenticLoop(): IPlanEntitlementEntity['featureAgenticLoop'] {
    return this._featureAgenticLoop;
  }

  set featureAgenticLoop(value: IPlanEntitlementEntity['featureAgenticLoop']) {
    this.setProperty('featureAgenticLoop', value);
  }

  get modelTier(): IPlanEntitlementEntity['modelTier'] {
    return this._modelTier;
  }

  set modelTier(value: IPlanEntitlementEntity['modelTier']) {
    this.setProperty('modelTier', value);
  }

  get rateLimitTier(): IPlanEntitlementEntity['rateLimitTier'] {
    return this._rateLimitTier;
  }

  set rateLimitTier(value: IPlanEntitlementEntity['rateLimitTier']) {
    this.setProperty('rateLimitTier', value);
  }

  get rateLimitPerMinute(): IPlanEntitlementEntity['rateLimitPerMinute'] {
    return this._rateLimitPerMinute;
  }

  set rateLimitPerMinute(value: IPlanEntitlementEntity['rateLimitPerMinute']) {
    this.setProperty('rateLimitPerMinute', value);
  }

  get rateLimitWindowMs(): IPlanEntitlementEntity['rateLimitWindowMs'] {
    return this._rateLimitWindowMs;
  }

  set rateLimitWindowMs(value: IPlanEntitlementEntity['rateLimitWindowMs']) {
    this.setProperty('rateLimitWindowMs', value);
  }

  public override validate(): void {
    if (this._plan === undefined || this._plan === null) {
      throw new BusinessException('PlanEntitlement plan is required.');
    }
    if (!Object.values(Enums.TenantPlan).includes(this._plan)) {
      throw new BusinessException(`PlanEntitlement plan is invalid: ${String(this._plan)}.`);
    }
  }
}
