/* eslint-disable unused-imports/no-unused-imports */
/* eslint-disable @typescript-eslint/no-unused-vars */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { BusinessException } from '@arcaai/exceptions';
import { BaseTenantEntity, IBaseTenantEntity } from '../../../common';
import * as Enums from '../../../enums';

export interface ITenantEntitlementEntity extends IBaseTenantEntity {
  maxUsers?: number | null;
  maxDepartments?: number | null;
  maxPromptTemplates?: number | null;
  maxAsrPipelines?: number | null;
  maxApiKeys?: number | null;
  // Per-tenant override of PlanEntitlement.maxWorkflowDefinitions.
  maxWorkflowDefinitions?: number | null;
  storageQuotaBytes?: bigint | null;
  maxConcurrentSessions?: number | null;
  monthlyConsultations?: number | null;
  monthlyTranscriptionMinutes?: number | null;
  monthlySummaries?: number | null;
  // Per-tenant override of PlanEntitlement.monthlyWorkflowInvocations.
  monthlyWorkflowInvocations?: number | null;
  // Per-capability included allowances over the UTC-calendar-month window
  // BigInt: enterprise token/character counts exceed Int32.
  // null = unlimited (same convention as every meter column above).
  monthlySttSessionSeconds?: bigint | null;
  monthlyLlmTokens?: bigint | null;
  monthlyTtsCharacters?: bigint | null;
  monthlyNlpTextUnits?: bigint | null;
  monthlyEmbeddingTokens?: bigint | null;
  monthlySpendLimitMicros?: bigint | null;
  featurePlatformDefaultCredential?: boolean | null;
  featurePaletteStt?: boolean | null;
  featureAgenticLoop?: boolean | null;
  modelTier?: string | null;
  rateLimitTier?: string | null;
  rateLimitPerMinute?: number | null;
  // the window paired with `rateLimitPerMinute` (read only when it is set).
  rateLimitWindowMs?: number | null;
}

export class TenantEntitlementEntity extends BaseTenantEntity {
  private _maxUsers?: ITenantEntitlementEntity['maxUsers'];
  private _maxDepartments?: ITenantEntitlementEntity['maxDepartments'];
  private _maxPromptTemplates?: ITenantEntitlementEntity['maxPromptTemplates'];
  private _maxAsrPipelines?: ITenantEntitlementEntity['maxAsrPipelines'];
  private _maxApiKeys?: ITenantEntitlementEntity['maxApiKeys'];
  private _maxWorkflowDefinitions?: ITenantEntitlementEntity['maxWorkflowDefinitions'];
  private _storageQuotaBytes?: ITenantEntitlementEntity['storageQuotaBytes'];
  private _maxConcurrentSessions?: ITenantEntitlementEntity['maxConcurrentSessions'];
  private _monthlyConsultations?: ITenantEntitlementEntity['monthlyConsultations'];
  private _monthlyTranscriptionMinutes?: ITenantEntitlementEntity['monthlyTranscriptionMinutes'];
  private _monthlySummaries?: ITenantEntitlementEntity['monthlySummaries'];
  private _monthlyWorkflowInvocations?: ITenantEntitlementEntity['monthlyWorkflowInvocations'];
  private _monthlySttSessionSeconds?: ITenantEntitlementEntity['monthlySttSessionSeconds'];
  private _monthlyLlmTokens?: ITenantEntitlementEntity['monthlyLlmTokens'];
  private _monthlyTtsCharacters?: ITenantEntitlementEntity['monthlyTtsCharacters'];
  private _monthlyNlpTextUnits?: ITenantEntitlementEntity['monthlyNlpTextUnits'];
  private _monthlyEmbeddingTokens?: ITenantEntitlementEntity['monthlyEmbeddingTokens'];
  private _monthlySpendLimitMicros?: ITenantEntitlementEntity['monthlySpendLimitMicros'];
  private _featurePlatformDefaultCredential?: ITenantEntitlementEntity['featurePlatformDefaultCredential'];
  private _featurePaletteStt?: ITenantEntitlementEntity['featurePaletteStt'];
  private _featureAgenticLoop?: ITenantEntitlementEntity['featureAgenticLoop'];
  private _modelTier?: ITenantEntitlementEntity['modelTier'];
  private _rateLimitTier?: ITenantEntitlementEntity['rateLimitTier'];
  private _rateLimitPerMinute?: ITenantEntitlementEntity['rateLimitPerMinute'];
  private _rateLimitWindowMs?: ITenantEntitlementEntity['rateLimitWindowMs'];

  constructor(init: ITenantEntitlementEntity) {
    super(init);
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
    this._monthlySpendLimitMicros = init.monthlySpendLimitMicros;
    this._featurePlatformDefaultCredential = init.featurePlatformDefaultCredential;
    this._featurePaletteStt = init.featurePaletteStt;
    this._featureAgenticLoop = init.featureAgenticLoop;
    this._modelTier = init.modelTier;
    this._rateLimitTier = init.rateLimitTier;
    this._rateLimitPerMinute = init.rateLimitPerMinute;
    this._rateLimitWindowMs = init.rateLimitWindowMs;
  }

  get maxUsers(): ITenantEntitlementEntity['maxUsers'] {
    return this._maxUsers;
  }

  set maxUsers(value: ITenantEntitlementEntity['maxUsers']) {
    this.setProperty('maxUsers', value);
  }

  get maxDepartments(): ITenantEntitlementEntity['maxDepartments'] {
    return this._maxDepartments;
  }

  set maxDepartments(value: ITenantEntitlementEntity['maxDepartments']) {
    this.setProperty('maxDepartments', value);
  }

  get maxPromptTemplates(): ITenantEntitlementEntity['maxPromptTemplates'] {
    return this._maxPromptTemplates;
  }

  set maxPromptTemplates(value: ITenantEntitlementEntity['maxPromptTemplates']) {
    this.setProperty('maxPromptTemplates', value);
  }

  get maxAsrPipelines(): ITenantEntitlementEntity['maxAsrPipelines'] {
    return this._maxAsrPipelines;
  }

  set maxAsrPipelines(value: ITenantEntitlementEntity['maxAsrPipelines']) {
    this.setProperty('maxAsrPipelines', value);
  }

  get maxApiKeys(): ITenantEntitlementEntity['maxApiKeys'] {
    return this._maxApiKeys;
  }

  set maxApiKeys(value: ITenantEntitlementEntity['maxApiKeys']) {
    this.setProperty('maxApiKeys', value);
  }

  get maxWorkflowDefinitions(): ITenantEntitlementEntity['maxWorkflowDefinitions'] {
    return this._maxWorkflowDefinitions;
  }

  set maxWorkflowDefinitions(value: ITenantEntitlementEntity['maxWorkflowDefinitions']) {
    this.setProperty('maxWorkflowDefinitions', value);
  }

  get storageQuotaBytes(): ITenantEntitlementEntity['storageQuotaBytes'] {
    return this._storageQuotaBytes;
  }

  set storageQuotaBytes(value: ITenantEntitlementEntity['storageQuotaBytes']) {
    this.setProperty('storageQuotaBytes', value);
  }

  get maxConcurrentSessions(): ITenantEntitlementEntity['maxConcurrentSessions'] {
    return this._maxConcurrentSessions;
  }

  set maxConcurrentSessions(value: ITenantEntitlementEntity['maxConcurrentSessions']) {
    this.setProperty('maxConcurrentSessions', value);
  }

  get monthlyConsultations(): ITenantEntitlementEntity['monthlyConsultations'] {
    return this._monthlyConsultations;
  }

  set monthlyConsultations(value: ITenantEntitlementEntity['monthlyConsultations']) {
    this.setProperty('monthlyConsultations', value);
  }

  get monthlyTranscriptionMinutes(): ITenantEntitlementEntity['monthlyTranscriptionMinutes'] {
    return this._monthlyTranscriptionMinutes;
  }

  set monthlyTranscriptionMinutes(value: ITenantEntitlementEntity['monthlyTranscriptionMinutes']) {
    this.setProperty('monthlyTranscriptionMinutes', value);
  }

  get monthlySummaries(): ITenantEntitlementEntity['monthlySummaries'] {
    return this._monthlySummaries;
  }

  set monthlySummaries(value: ITenantEntitlementEntity['monthlySummaries']) {
    this.setProperty('monthlySummaries', value);
  }

  get monthlyWorkflowInvocations(): ITenantEntitlementEntity['monthlyWorkflowInvocations'] {
    return this._monthlyWorkflowInvocations;
  }

  set monthlyWorkflowInvocations(value: ITenantEntitlementEntity['monthlyWorkflowInvocations']) {
    this.setProperty('monthlyWorkflowInvocations', value);
  }

  get monthlySttSessionSeconds(): ITenantEntitlementEntity['monthlySttSessionSeconds'] {
    return this._monthlySttSessionSeconds;
  }

  set monthlySttSessionSeconds(value: ITenantEntitlementEntity['monthlySttSessionSeconds']) {
    this.setProperty('monthlySttSessionSeconds', value);
  }

  get monthlyLlmTokens(): ITenantEntitlementEntity['monthlyLlmTokens'] {
    return this._monthlyLlmTokens;
  }

  set monthlyLlmTokens(value: ITenantEntitlementEntity['monthlyLlmTokens']) {
    this.setProperty('monthlyLlmTokens', value);
  }

  get monthlyTtsCharacters(): ITenantEntitlementEntity['monthlyTtsCharacters'] {
    return this._monthlyTtsCharacters;
  }

  set monthlyTtsCharacters(value: ITenantEntitlementEntity['monthlyTtsCharacters']) {
    this.setProperty('monthlyTtsCharacters', value);
  }

  get monthlyNlpTextUnits(): ITenantEntitlementEntity['monthlyNlpTextUnits'] {
    return this._monthlyNlpTextUnits;
  }

  set monthlyNlpTextUnits(value: ITenantEntitlementEntity['monthlyNlpTextUnits']) {
    this.setProperty('monthlyNlpTextUnits', value);
  }

  get monthlyEmbeddingTokens(): ITenantEntitlementEntity['monthlyEmbeddingTokens'] {
    return this._monthlyEmbeddingTokens;
  }

  set monthlyEmbeddingTokens(value: ITenantEntitlementEntity['monthlyEmbeddingTokens']) {
    this.setProperty('monthlyEmbeddingTokens', value);
  }

  get monthlySpendLimitMicros(): ITenantEntitlementEntity['monthlySpendLimitMicros'] {
    return this._monthlySpendLimitMicros;
  }

  set monthlySpendLimitMicros(value: ITenantEntitlementEntity['monthlySpendLimitMicros']) {
    this.setProperty('monthlySpendLimitMicros', value);
  }

  get featurePlatformDefaultCredential(): ITenantEntitlementEntity['featurePlatformDefaultCredential'] {
    return this._featurePlatformDefaultCredential;
  }

  set featurePlatformDefaultCredential(value: ITenantEntitlementEntity['featurePlatformDefaultCredential']) {
    this.setProperty('featurePlatformDefaultCredential', value);
  }

  get featurePaletteStt(): ITenantEntitlementEntity['featurePaletteStt'] {
    return this._featurePaletteStt;
  }

  set featurePaletteStt(value: ITenantEntitlementEntity['featurePaletteStt']) {
    this.setProperty('featurePaletteStt', value);
  }

  get featureAgenticLoop(): ITenantEntitlementEntity['featureAgenticLoop'] {
    return this._featureAgenticLoop;
  }

  set featureAgenticLoop(value: ITenantEntitlementEntity['featureAgenticLoop']) {
    this.setProperty('featureAgenticLoop', value);
  }

  get modelTier(): ITenantEntitlementEntity['modelTier'] {
    return this._modelTier;
  }

  set modelTier(value: ITenantEntitlementEntity['modelTier']) {
    this.setProperty('modelTier', value);
  }

  get rateLimitTier(): ITenantEntitlementEntity['rateLimitTier'] {
    return this._rateLimitTier;
  }

  set rateLimitTier(value: ITenantEntitlementEntity['rateLimitTier']) {
    this.setProperty('rateLimitTier', value);
  }

  get rateLimitPerMinute(): ITenantEntitlementEntity['rateLimitPerMinute'] {
    return this._rateLimitPerMinute;
  }

  set rateLimitPerMinute(value: ITenantEntitlementEntity['rateLimitPerMinute']) {
    this.setProperty('rateLimitPerMinute', value);
  }

  get rateLimitWindowMs(): ITenantEntitlementEntity['rateLimitWindowMs'] {
    return this._rateLimitWindowMs;
  }

  set rateLimitWindowMs(value: ITenantEntitlementEntity['rateLimitWindowMs']) {
    this.setProperty('rateLimitWindowMs', value);
  }
}
