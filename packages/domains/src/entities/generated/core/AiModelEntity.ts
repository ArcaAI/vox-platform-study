/* eslint-disable unused-imports/no-unused-imports */
/* eslint-disable @typescript-eslint/no-unused-vars */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { BusinessException } from '@arcaai/exceptions';
import { BaseTaggedEntity, IBaseTaggedEntity } from '../../../common';
import { JsonValue } from '../../../interfaces';
import * as Enums from '../../../enums';

export interface IAiModelEntity extends IBaseTaggedEntity {
  name: string;
  slug: string;
  description?: string | null;
  category: Enums.ModelCategory;
  taskType: Enums.ModelTaskType;
  modelType: Enums.ModelType;
  source: Enums.AiModelSource;
  sourceUri: string;
  sourceRevision?: string | null;
  format: Enums.AiModelFormat;
  memorySizeMb?: number | null;
  computeType?: string | null;
  downloadStatus: Enums.AiModelDownloadStatus;
  localPath?: string | null;
  downloadedAt?: Date | null;
  fileSizeMb?: number | null;
  checksum?: string | null;
}

export class AiModelEntity extends BaseTaggedEntity {
  private _name: IAiModelEntity['name'];
  private _slug: IAiModelEntity['slug'];
  private _description?: IAiModelEntity['description'];
  private _category: IAiModelEntity['category'];
  private _taskType: IAiModelEntity['taskType'];
  private _modelType: IAiModelEntity['modelType'];
  private _source: IAiModelEntity['source'];
  private _sourceUri: IAiModelEntity['sourceUri'];
  private _sourceRevision?: IAiModelEntity['sourceRevision'];
  private _format: IAiModelEntity['format'];
  private _memorySizeMb?: IAiModelEntity['memorySizeMb'];
  private _computeType?: IAiModelEntity['computeType'];
  private _downloadStatus: IAiModelEntity['downloadStatus'];
  private _localPath?: IAiModelEntity['localPath'];
  private _downloadedAt?: IAiModelEntity['downloadedAt'];
  private _fileSizeMb?: IAiModelEntity['fileSizeMb'];
  private _checksum?: IAiModelEntity['checksum'];

  constructor(init: IAiModelEntity) {
    super(init);
    this._name = init.name;
    this._slug = init.slug;
    this._description = init.description;
    this._category = init.category;
    this._taskType = init.taskType;
    this._modelType = init.modelType;
    this._source = init.source;
    this._sourceUri = init.sourceUri;
    this._sourceRevision = init.sourceRevision;
    this._format = init.format;
    this._memorySizeMb = init.memorySizeMb;
    this._computeType = init.computeType;
    this._downloadStatus = init.downloadStatus;
    this._localPath = init.localPath;
    this._downloadedAt = init.downloadedAt;
    this._fileSizeMb = init.fileSizeMb;
    this._checksum = init.checksum;
  }

  // Getters and Setters
  get name(): IAiModelEntity['name'] {
    return this._name;
  }

  set name(value: IAiModelEntity['name']) {
    this.setProperty('name', value);
  }

  get slug(): IAiModelEntity['slug'] {
    return this._slug;
  }

  set slug(value: IAiModelEntity['slug']) {
    this.setProperty('slug', value);
  }

  get description(): IAiModelEntity['description'] {
    return this._description;
  }

  set description(value: IAiModelEntity['description']) {
    this.setProperty('description', value);
  }

  get category(): IAiModelEntity['category'] {
    return this._category;
  }

  set category(value: IAiModelEntity['category']) {
    this.setProperty('category', value);
  }

  get taskType(): IAiModelEntity['taskType'] {
    return this._taskType;
  }

  set taskType(value: IAiModelEntity['taskType']) {
    this.setProperty('taskType', value);
  }

  get modelType(): IAiModelEntity['modelType'] {
    return this._modelType;
  }

  set modelType(value: IAiModelEntity['modelType']) {
    this.setProperty('modelType', value);
  }

  get source(): IAiModelEntity['source'] {
    return this._source;
  }

  set source(value: IAiModelEntity['source']) {
    this.setProperty('source', value);
  }

  get sourceUri(): IAiModelEntity['sourceUri'] {
    return this._sourceUri;
  }

  set sourceUri(value: IAiModelEntity['sourceUri']) {
    this.setProperty('sourceUri', value);
  }

  get sourceRevision(): IAiModelEntity['sourceRevision'] {
    return this._sourceRevision;
  }

  set sourceRevision(value: IAiModelEntity['sourceRevision']) {
    this.setProperty('sourceRevision', value);
  }

  get format(): IAiModelEntity['format'] {
    return this._format;
  }

  set format(value: IAiModelEntity['format']) {
    this.setProperty('format', value);
  }

  get memorySizeMb(): IAiModelEntity['memorySizeMb'] {
    return this._memorySizeMb;
  }

  set memorySizeMb(value: IAiModelEntity['memorySizeMb']) {
    this.setProperty('memorySizeMb', value);
  }

  get computeType(): IAiModelEntity['computeType'] {
    return this._computeType;
  }

  set computeType(value: IAiModelEntity['computeType']) {
    this.setProperty('computeType', value);
  }

  get downloadStatus(): IAiModelEntity['downloadStatus'] {
    return this._downloadStatus;
  }

  set downloadStatus(value: IAiModelEntity['downloadStatus']) {
    this.setProperty('downloadStatus', value);
  }

  get localPath(): IAiModelEntity['localPath'] {
    return this._localPath;
  }

  set localPath(value: IAiModelEntity['localPath']) {
    this.setProperty('localPath', value);
  }

  get downloadedAt(): IAiModelEntity['downloadedAt'] {
    return this._downloadedAt;
  }

  set downloadedAt(value: IAiModelEntity['downloadedAt']) {
    this.setProperty('downloadedAt', value);
  }

  get fileSizeMb(): IAiModelEntity['fileSizeMb'] {
    return this._fileSizeMb;
  }

  set fileSizeMb(value: IAiModelEntity['fileSizeMb']) {
    this.setProperty('fileSizeMb', value);
  }

  get checksum(): IAiModelEntity['checksum'] {
    return this._checksum;
  }

  set checksum(value: IAiModelEntity['checksum']) {
    this.setProperty('checksum', value);
  }

  // ============================================
  // Custom Domain Methods
  // ============================================

  /**
   * Check if the model has been downloaded
   */
  get isDownloaded(): boolean {
    return this._downloadStatus === Enums.AiModelDownloadStatus.DOWNLOADED;
  }

  /**
   * Check if the model is currently downloading
   */
  get isDownloading(): boolean {
    return this._downloadStatus === Enums.AiModelDownloadStatus.DOWNLOADING;
  }

  /**
   * Check if the model download failed
   */
  get isDownloadFailed(): boolean {
    return this._downloadStatus === Enums.AiModelDownloadStatus.DOWNLOAD_FAILED;
  }

  /**
   * Check if the model has not been downloaded yet
   */
  get isNotDownloaded(): boolean {
    return this._downloadStatus === Enums.AiModelDownloadStatus.NOT_DOWNLOADED;
  }

  /**
   * Check if this is an ASR (Automatic Speech Recognition) model
   */
  get isASR(): boolean {
    return this._taskType === Enums.ModelTaskType.AUTOMATIC_SPEECH_RECOGNITION;
  }

  /**
   * Check if this is a VAD (Voice Activity Detection) model
   */
  get isVAD(): boolean {
    return this._taskType === Enums.ModelTaskType.VOICE_ACTIVITY_DETECTION;
  }

  /**
   * Check if this is a TTS (Text-to-Speech) model
   */
  get isTTS(): boolean {
    return this._taskType === Enums.ModelTaskType.TEXT_TO_SPEECH;
  }

  /**
   * Check if this is an audio model
   */
  get isAudioModel(): boolean {
    return this._category === Enums.ModelCategory.AUDIO;
  }

  /**
   * Check if model is from HuggingFace
   */
  get isHuggingFace(): boolean {
    return this._source === Enums.AiModelSource.HUGGINGFACE;
  }

  /**
   * Check if model is from MLFlow
   */
  get isMLFlow(): boolean {
    return this._source === Enums.AiModelSource.MLFLOW;
  }

  /**
   * Mark model as currently downloading
   */
  public markAsDownloading(userId?: string): void {
    this.setProperty('downloadStatus', Enums.AiModelDownloadStatus.DOWNLOADING);
    if (userId) {
      this.setProperty('updatedBy', userId);
    }
  }

  /**
   * Mark model as successfully downloaded
   */
  public markAsDownloaded(localPath: string, fileSizeMb?: number, checksum?: string, userId?: string): void {
    this.setProperty('downloadStatus', Enums.AiModelDownloadStatus.DOWNLOADED);
    this.setProperty('localPath', localPath);
    this.setProperty('downloadedAt', new Date());
    if (fileSizeMb !== undefined) {
      this.setProperty('fileSizeMb', fileSizeMb);
    }
    if (checksum) {
      this.setProperty('checksum', checksum);
    }
    if (userId) {
      this.setProperty('updatedBy', userId);
    }
  }

  /**
   * Mark model download as failed
   */
  public markAsDownloadFailed(userId?: string): void {
    this.setProperty('downloadStatus', Enums.AiModelDownloadStatus.DOWNLOAD_FAILED);
    if (userId) {
      this.setProperty('updatedBy', userId);
    }
  }

  /**
   * Reset download status to not downloaded
   */
  public resetDownloadStatus(userId?: string): void {
    this.setProperty('downloadStatus', Enums.AiModelDownloadStatus.NOT_DOWNLOADED);
    this.setProperty('localPath', null);
    this.setProperty('downloadedAt', null);
    this.setProperty('fileSizeMb', null);
    this.setProperty('checksum', null);
    if (userId) {
      this.setProperty('updatedBy', userId);
    }
  }

  public override validate(): void {
    super.validate();
    if (!this._name || this._name.trim().length === 0) {
      throw new BusinessException('Model name is required');
    }
    if (!this._slug || this._slug.trim().length === 0) {
      throw new BusinessException('Model slug is required');
    }
    if (!this._sourceUri || this._sourceUri.trim().length === 0) {
      throw new BusinessException('Model source URI is required');
    }
    // Validate slug format (lowercase, alphanumeric, hyphens only)
    if (!/^[a-z0-9][a-z0-9-]*[a-z0-9]$|^[a-z0-9]$/.test(this._slug)) {
      throw new BusinessException('Model slug must be lowercase alphanumeric with hyphens (e.g., "whisper-large-v3")');
    }
  }
}
