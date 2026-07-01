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
  storageQuotaBytes?: bigint | null;
  maxConcurrentSessions?: number | null;
  monthlyConsultations?: number | null;
  monthlyTranscriptionMinutes?: number | null;
  monthlySummaries?: number | null;
  featureDnaReports?: boolean | null;
  featureVoiceEnrollment?: boolean | null;
  featureMonitoringAccess?: boolean | null;
  modelTier?: string | null;
  rateLimitTier?: string | null;
  rateLimitPerMinute?: number | null;
}

export class TenantEntitlementEntity extends BaseTenantEntity {
  private _maxUsers?: ITenantEntitlementEntity['maxUsers'];
  private _maxDepartments?: ITenantEntitlementEntity['maxDepartments'];
  private _maxPromptTemplates?: ITenantEntitlementEntity['maxPromptTemplates'];
  private _maxAsrPipelines?: ITenantEntitlementEntity['maxAsrPipelines'];
  private _maxApiKeys?: ITenantEntitlementEntity['maxApiKeys'];
  private _storageQuotaBytes?: ITenantEntitlementEntity['storageQuotaBytes'];
  private _maxConcurrentSessions?: ITenantEntitlementEntity['maxConcurrentSessions'];
  private _monthlyConsultations?: ITenantEntitlementEntity['monthlyConsultations'];
  private _monthlyTranscriptionMinutes?: ITenantEntitlementEntity['monthlyTranscriptionMinutes'];
  private _monthlySummaries?: ITenantEntitlementEntity['monthlySummaries'];
  private _featureDnaReports?: ITenantEntitlementEntity['featureDnaReports'];
  private _featureVoiceEnrollment?: ITenantEntitlementEntity['featureVoiceEnrollment'];
  private _featureMonitoringAccess?: ITenantEntitlementEntity['featureMonitoringAccess'];
  private _modelTier?: ITenantEntitlementEntity['modelTier'];
  private _rateLimitTier?: ITenantEntitlementEntity['rateLimitTier'];
  private _rateLimitPerMinute?: ITenantEntitlementEntity['rateLimitPerMinute'];

  constructor(init: ITenantEntitlementEntity) {
    super(init);
    this._maxUsers = init.maxUsers;
    this._maxDepartments = init.maxDepartments;
    this._maxPromptTemplates = init.maxPromptTemplates;
    this._maxAsrPipelines = init.maxAsrPipelines;
    this._maxApiKeys = init.maxApiKeys;
    this._storageQuotaBytes = init.storageQuotaBytes;
    this._maxConcurrentSessions = init.maxConcurrentSessions;
    this._monthlyConsultations = init.monthlyConsultations;
    this._monthlyTranscriptionMinutes = init.monthlyTranscriptionMinutes;
    this._monthlySummaries = init.monthlySummaries;
    this._featureDnaReports = init.featureDnaReports;
    this._featureVoiceEnrollment = init.featureVoiceEnrollment;
    this._featureMonitoringAccess = init.featureMonitoringAccess;
    this._modelTier = init.modelTier;
    this._rateLimitTier = init.rateLimitTier;
    this._rateLimitPerMinute = init.rateLimitPerMinute;
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

  get featureDnaReports(): ITenantEntitlementEntity['featureDnaReports'] {
    return this._featureDnaReports;
  }

  set featureDnaReports(value: ITenantEntitlementEntity['featureDnaReports']) {
    this.setProperty('featureDnaReports', value);
  }

  get featureVoiceEnrollment(): ITenantEntitlementEntity['featureVoiceEnrollment'] {
    return this._featureVoiceEnrollment;
  }

  set featureVoiceEnrollment(value: ITenantEntitlementEntity['featureVoiceEnrollment']) {
    this.setProperty('featureVoiceEnrollment', value);
  }

  get featureMonitoringAccess(): ITenantEntitlementEntity['featureMonitoringAccess'] {
    return this._featureMonitoringAccess;
  }

  set featureMonitoringAccess(value: ITenantEntitlementEntity['featureMonitoringAccess']) {
    this.setProperty('featureMonitoringAccess', value);
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
}
